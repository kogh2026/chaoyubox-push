// PDF 标准安全处理器（加密保存）。
// pdf-lib 只读不支持带密码加载、保存也不支持加密，这里按 PDF 规范实现
// R2/V1（40 位 RC4）与 R3/V2（128 位 RC4）：计算 O / U / 文件密钥，
// 逐对象加密字符串与流，重建 trailer 写入 /Encrypt 与 /ID。
// 验证方式见 pdfSecure.test.ts（加密结果用 pdfjs 带密码打开）。
import { PDFDocument } from 'pdf-lib';

/* ===== MD5（RFC 1321） ===== */

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_K: number[] = [];
for (let i = 0; i < 64; i++) MD5_K.push(Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296));

export function md5(msg: Uint8Array): Uint8Array {
  const len = msg.length;
  const withPad = new Uint8Array((((len + 8) >> 6) + 1) << 6);
  withPad.set(msg);
  withPad[len] = 0x80;
  const bitLen = len * 8;
  const dv = new DataView(withPad.buffer);
  dv.setUint32(withPad.length - 8, bitLen & 0xffffffff, true);
  dv.setUint32(withPad.length - 4, Math.floor(bitLen / 4294967296), true);
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const M = new Uint32Array(16);
  for (let off = 0; off < withPad.length; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number;
      let g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + MD5_K[i] + M[g]) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + ((F << MD5_S[i]) | (F >>> (32 - MD5_S[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, a0, true);
  odv.setUint32(4, b0, true);
  odv.setUint32(8, c0, true);
  odv.setUint32(12, d0, true);
  return out;
}

/* ===== RC4 ===== */

function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + S[i] + key[i % key.length]) & 255;
    const t = S[i];
    S[i] = S[j];
    S[j] = t;
  }
  const out = new Uint8Array(data.length);
  let x = 0;
  let y = 0;
  for (let i = 0; i < data.length; i++) {
    x = (x + 1) & 255;
    y = (y + S[x]) & 255;
    const t = S[x];
    S[x] = S[y];
    S[y] = t;
    out[i] = data[i] ^ S[(S[x] + S[y]) & 255];
  }
  return out;
}

/* ===== 标准安全处理器算法 ===== */

const PAD = new Uint8Array([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

function padPassword(pw: string): Uint8Array {
  // 规范：口令字节在前，剩余部分从 PAD 的**开头**依次填充到 32 字节
  // （不是把口令覆盖到 PAD 上——那会用错 PAD 的尾部片段）
  const bytes = new Uint8Array(32);
  const src = latin1(pw).slice(0, 32);
  for (let i = 0; i < src.length; i++) bytes[i] = src[i];
  for (let i = src.length; i < 32; i++) bytes[i] = PAD[i - src.length];
  return bytes;
}

function latin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function xorKey(key: Uint8Array, n: number): Uint8Array {
  return key.map((b) => b ^ n);
}

// Algorithm 3：计算 O 入口（R3 做 50 次 MD5 迭代 + 20 轮 RC4）
export function computeO(ownerPw: string, userPw: string, r3: boolean): Uint8Array {
  let hash = md5(padPassword(ownerPw));
  const n = r3 ? 16 : 5;
  if (r3) {
    for (let i = 0; i < 50; i++) hash = md5(hash);
  }
  const key = hash.slice(0, n);
  const val = padPassword(userPw);
  if (!r3) return rc4(key, val);
  let out = rc4(key, val);
  for (let i = 1; i <= 19; i++) out = rc4(xorKey(key, i), out);
  return out;
}

// 算法 4/5：计算 U 入口
export function computeU(fileKey: Uint8Array, id0: Uint8Array, r3: boolean): Uint8Array {
  if (!r3) return rc4(fileKey, PAD);
  // Algorithm 5：md5(PAD + id0) 一次（50 次迭代只属于算法 2/3，不在这里）
  let hash = md5(new Uint8Array([...PAD, ...id0]));
  let out = rc4(fileKey, hash);
  for (let i = 1; i <= 19; i++) out = rc4(xorKey(fileKey, i), out);
  // 16 字节任意填充（规范允许），用 0 填充
  const u = new Uint8Array(32);
  u.set(out);
  return u;
}

// 算法 2：文件加密密钥
export function computeFileKey(userPw: string, O: Uint8Array, P: number, id0: Uint8Array, r3: boolean): Uint8Array {
  const n = r3 ? 16 : 5;
  const pBytes = new Uint8Array(4);
  new DataView(pBytes.buffer).setInt32(0, P, true);
  let hash = md5(new Uint8Array([...padPassword(userPw), ...O, ...pBytes, ...id0]));
  if (r3) {
    for (let i = 0; i < 50; i++) hash = md5(hash);
  }
  return hash.slice(0, n);
}

// Algorithm 1：对象密钥
function objectKey(fileKey: Uint8Array, objNum: number, genNum: number): Uint8Array {
  const ext = new Uint8Array(fileKey.length + 5);
  ext.set(fileKey);
  ext[fileKey.length] = objNum & 0xff;
  ext[fileKey.length + 1] = (objNum >> 8) & 0xff;
  ext[fileKey.length + 2] = (objNum >> 16) & 0xff;
  ext[fileKey.length + 3] = genNum & 0xff;
  ext[fileKey.length + 4] = (genNum >> 8) & 0xff;
  const h = md5(ext);
  const len = Math.min(fileKey.length + 5, 16);
  return h.slice(0, len);
}

/* ===== 权限位 ===== */

export interface EncryptPermissions {
  printing: boolean;
  copying: boolean;
  modifying: boolean;
  annotating: boolean;
}

export function permissionsBits(p: EncryptPermissions): number {
  let P = -1;
  P &= ~((1 << 1) | (1 << 2)); // 保留位必须为 0
  if (!p.printing) P &= ~((1 << 3) | (1 << 12));
  if (!p.modifying) P &= ~((1 << 5) | (1 << 11));
  if (!p.copying) P &= ~((1 << 9) | (1 << 10));
  if (!p.annotating) P &= ~(1 << 6);
  return P;
}

/* ===== PDF 结构改写 ===== */

function bytesToLatin1(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return s;
}

// 用 xref 表切分对象（pdf-lib 以 useObjectStreams:false 保存时输出经典 xref）
function parseXref(text: string): { offsets: number[]; trailerStart: number; xrefStart: number } {
  const xrefStart = text.lastIndexOf('\nxref');
  if (xrefStart < 0) throw new Error('不是经典的 xref 表结构，无法加密');
  const trStart = text.indexOf('trailer', xrefStart);
  const xrefBody = text.slice(text.indexOf('\n', xrefStart + 1), trStart);
  const lines = xrefBody.split('\n').filter((l) => /^\d{10}\s\d{5}\s[nf]\s*$/.test(l));
  const offsets: number[] = [];
  for (const l of lines) {
    const m = /^(\d{10})\s\d{5}\s([nf])/.exec(l);
    if (!m) continue;
    offsets.push(m[2] === 'f' ? -1 : parseInt(m[1], 10));
  }
  if (offsets.length < 2) throw new Error('xref 表解析失败');
  return { offsets, trailerStart: trStart, xrefStart: xrefStart + 1 };
}

function parseTrailer(text: string, from: number): Record<string, string> {
  const dictStart = text.indexOf('<<', from);
  let depth = 0;
  let i = dictStart;
  for (; i < text.length - 1; i++) {
    if (text[i] === '<' && text[i + 1] === '<') depth++;
    else if (text[i] === '>' && text[i + 1] === '>') {
      depth--;
      if (depth === 0) break;
    }
  }
  const body = text.slice(dictStart + 2, i);
  const out: Record<string, string> = {};
  const re = /\/(\w+)\s*(<<|\[|\()/g;
  void re;
  // 逐键值提取（值可能是数字、引用 N G R、名字、数组）
  const kv = /\/(Root|Info|Size|Encrypt|ID)\b\s*([^\s/\]>]+(?:\s+\d+\s+R)?|\{[^}]*\})/g;
  let m: RegExpExecArray | null;
  while ((m = kv.exec(body))) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

// 对象流数据定位：优先按 /Length（直接整数），退回 endstream 搜索。
// /Type /Metadata 的流按规范不加密，返回 null。
function locateStream(body: string): { start: number; end: number } | null {
  const sm = /stream\r\n|stream\n|stream\r/.exec(body);
  if (!sm || !/endstream/.test(body)) return null;
  if (/\/Type\s*\/Metadata/.test(body.slice(0, sm.index))) return null;
  const lm = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(body.slice(0, sm.index));
  const start = sm.index + sm[0].length;
  if (lm) return { start, end: start + parseInt(lm[1], 10) };
  const em = body.indexOf('endstream', start);
  let dataEnd = em;
  if (body[dataEnd - 1] === '\n') dataEnd--;
  if (body[dataEnd - 1] === '\r') dataEnd--;
  return { start, end: dataEnd };
}

// 加密一个对象体：字符串（字面 / 十六进制）与流数据
function encryptObjectBody(
  body: string,
  fileKey: Uint8Array,
  objNum: number,
  gen: number,
): string {
  const key = objectKey(fileKey, objNum, gen);
  let out = '';
  let i = 0;
  const stream = locateStream(body);
  while (i < body.length) {
    if (stream && i === stream.start) {
      // 流数据原样加密（等长）
      const data = latin1(body.slice(stream.start, stream.end));
      const enc = rc4(key, data);
      out += bytesToLatin1(enc);
      i = stream.end;
      continue;
    }
    const ch = body[i];
    if (ch === '<') {
      if (body[i + 1] === '<') {
        // 字典开始：整个 << 跳过，避免第二个 < 被误判为十六进制串
        out += '<<';
        i += 2;
        continue;
      }
      const end = body.indexOf('>', i);
      if (end > 0) {
        const hex = body.slice(i + 1, end).replace(/[^0-9A-Fa-f]/g, '');
        const plain = new Uint8Array(Math.floor(hex.length / 2));
        for (let k = 0; k < plain.length; k++) plain[k] = parseInt(hex.substr(k * 2, 2), 16);
        const enc = rc4(key, plain);
        out += '<' + Array.from(enc, (b) => b.toString(16).padStart(2, '0')).join('') + '>';
        i = end + 1;
        continue;
      }
    }
    if (ch === '(') {
      // 字面字符串：扫描到配对的 ）
      let depth = 1;
      let j = i + 1;
      let raw = '';
      while (j < body.length && depth > 0) {
        const c = body[j];
        if (c === '\\') {
          raw += c + (body[j + 1] ?? '');
          j += 2;
          continue;
        }
        if (c === '(') depth++;
        if (c === ')') {
          depth--;
          if (depth === 0) break;
        }
        raw += c;
        j++;
      }
      // 反转义 -> 加密 -> 转十六进制字符串（长度变化由外层重建 xref 兜底）
      const plain = unescapeLiteral(raw);
      const enc = rc4(key, plain);
      out += '<' + Array.from(enc, (b) => b.toString(16).padStart(2, '0')).join('') + '>';
      i = j + 1;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function unescapeLiteral(s: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      const n = s[i + 1];
      if (n === 'n') {
        bytes.push(10);
        i++;
      } else if (n === 'r') {
        bytes.push(13);
        i++;
      } else if (n === 't') {
        bytes.push(9);
        i++;
      } else if (n === 'b') {
        bytes.push(8);
        i++;
      } else if (n === 'f') {
        bytes.push(12);
        i++;
      } else if (n === '(' || n === ')' || n === '\\') {
        bytes.push(n.charCodeAt(0));
        i++;
      } else if (n >= '0' && n <= '7') {
        let oct = n;
        let k = 1;
        while (k < 3 && s[i + 1 + k - 1] >= '0' && s[i + 1 + k - 1] <= '7' && /[0-7]/.test(s[i + k] ?? '')) {
          oct += s[i + k];
          k++;
        }
        bytes.push(parseInt(oct, 8) & 0xff);
        i += k;
      } else {
        i++; // 未知转义：丢弃反斜杠
      }
    } else {
      bytes.push(c.charCodeAt(0) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

function hex16(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function randomId(): Uint8Array {
  const out = new Uint8Array(16);
  const c = globalThis.crypto;
  if (c?.getRandomValues) c.getRandomValues(out);
  else for (let i = 0; i < 16; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

export interface SecureEncryptOpts {
  userPassword: string;
  ownerPassword: string;
  permissions: EncryptPermissions;
  r3?: boolean; // 128 位 RC4（默认）；false = 40 位
}

// 主入口：doc 由调用方提供（已 load），内部 save 后做加密改写
export async function encryptWithPasswords(
  doc: PDFDocument,
  opts: SecureEncryptOpts,
): Promise<Uint8Array> {
  const plain = await doc.save({ useObjectStreams: false });
  return applyStandardSecurity(plain, opts);
}

// 对无加密 PDF 字节流施加标准安全处理器
export function applyStandardSecurity(plain: Uint8Array, opts: SecureEncryptOpts, idOverride?: Uint8Array): Uint8Array {
  const r3 = opts.r3 !== false;
  const text = bytesToLatin1(plain);
  const { offsets, trailerStart, xrefStart } = parseXref(text);
  const trailer = parseTrailer(text, trailerStart);
  const size = parseInt(trailer.Size ?? '0', 10);
  if (!size || offsets.length !== size) {
    throw new Error(`xref 与 /Size 不一致（${offsets.length} vs ${trailer.Size}），无法加密`);
  }
  const id0 = idOverride ?? randomId();
  const id1 = idOverride ? randomId() : randomId();
  const P = permissionsBits(opts.permissions);
  const O = computeO(opts.ownerPassword || opts.userPassword, opts.userPassword, r3);
  const fileKey = computeFileKey(opts.userPassword, O, P, id0, r3);
  const U = computeU(fileKey, id0, r3);

  // 逐对象加密（对象 0 是 free 头；跳过含 /Type /Metadata 的流）
  // 字面串转十六进制串后长度会变（2 倍），因此记录每个对象在输出中的
  // 新偏移，最后按新偏移重建 xref；对象间的原始空白原样保留。
  const newOffsets = new Array<number>(size).fill(-1);
  let out = '';
  let prevEnd = 0;
  const encObjNum = size; // 新对象号
  for (let n = 1; n < size; n++) {
    const start = offsets[n];
    if (start < 0) continue;
    const head = text.slice(start, start + 40);
    const hm = new RegExp(`^${n}\\s+(\\d+)\\s+obj`).exec(head);
    if (!hm) throw new Error(`对象 ${n} 头部解析失败`);
    const gen = parseInt(hm[1], 10);
    const bodyStart = start + hm[0].length;
    let end = n + 1 < size && offsets[n + 1] >= 0 ? offsets[n + 1] : xrefStart;
    // 回退到 endobj 之后
    const eo = text.lastIndexOf('endobj', end);
    if (eo < 0) throw new Error(`对象 ${n} 缺少 endobj`);
    end = eo + 'endobj'.length;
    const body = text.slice(bodyStart, eo);
    const encBody = encryptObjectBody(body, fileKey, n, gen);
    // 对象头（N G obj 的起始字符）在新输出中的位置
    newOffsets[n] = out.length + (start - prevEnd);
    out += text.slice(prevEnd, bodyStart) + encBody + 'endobj';
    prevEnd = end;
  }
  out += text.slice(prevEnd, xrefStart);

  // 追加 /Encrypt 对象
  const encOffset = out.length;
  const encDict =
    `${encObjNum} 0 obj\n<< /Filter /Standard /V ${r3 ? 2 : 1} /R ${r3 ? 3 : 2} ` +
    `/Length ${r3 ? 128 : 40} /P ${P} /O <${hex16(O)}> /U <${hex16(U)}>>\nendobj\n`;
  out += encDict;

  // 重建 xref（新增一项，用新偏移）
  const xrefOffset = out.length;
  out += `xref\n0 ${size + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n < size; n++) {
    if (newOffsets[n] < 0) {
      out += '0000000000 65535 f \n';
      continue;
    }
    out += `${String(newOffsets[n]).padStart(10, '0')} 00000 n \n`;
  }
  out += `${String(encOffset).padStart(10, '0')} 00000 n \n`;

  // 重建 trailer
  const rootRef = trailer.Root ?? '1 0 R';
  const infoRef = trailer.Info;
  out +=
    `trailer\n<< /Size ${size + 1} /Root ${rootRef}` +
    (infoRef ? ` /Info ${infoRef}` : '') +
    ` /Encrypt ${encObjNum} 0 R /ID [<${hex16(id0)}> <${hex16(id1)}>] >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;
  return latin1(out);
}
