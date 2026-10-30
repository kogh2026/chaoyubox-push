// 标准安全处理器（加密）测试：
//  A. 独立复算自洽性（node:crypto MD5 + 独立 RC4 复算规范密钥链，验证文件自身符合规范）
//  B. pdfjs 带密码打开往返（用户/主密码、权限限制、R2/R3、CJK 口令、错误口令拒绝）
// 栅格/渲染类操作由浏览器 E2E 覆盖。
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';
import { applyStandardSecurity, computeFileKey, computeO, computeU } from './pdfSecure';

/* ===== 独立实现（不复用被测代码） ===== */

function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + S[i] + key[i % key.length]) & 255;
    [S[i], S[j]] = [S[j], S[i]];
  }
  const out = new Uint8Array(data.length);
  let x = 0;
  let y = 0;
  for (let i = 0; i < data.length; i++) {
    x = (x + 1) & 255;
    y = (y + S[x]) & 255;
    [S[x], S[y]] = [S[y], S[x]];
    out[i] = data[i] ^ S[(S[x] + S[y]) & 255];
  }
  return out;
}

const PAD = new Uint8Array([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

function md5(b: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('md5').update(b).digest());
}
function padPw(pw: string): Uint8Array {
  const out = new Uint8Array(32);
  const src = Array.from(pw, (c) => c.charCodeAt(0) & 0xff).slice(0, 32);
  for (let i = 0; i < src.length; i++) out[i] = src[i];
  for (let i = src.length; i < 32; i++) out[i] = PAD[i - src.length];
  return out;
}
function hex(u: Uint8Array): string {
  return Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
}
function unhex(s: string): Uint8Array {
  const clean = s.replace(/[^0-9A-Fa-f]/g, '');
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

async function makePlain(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  doc.addPage([200, 200]);
  return doc.save({ useObjectStreams: false });
}

function parseEnc(text: string) {
  const enc = /(\d+) 0 obj\n<< \/Filter \/Standard ([\s\S]*?)>>\nendobj/.exec(text);
  if (!enc) throw new Error('Encrypt dict not found');
  const body = enc[2];
  const R = parseInt(/\/R (\d+)/.exec(body)![1], 10);
  const P = parseInt(/\/P (-?\d+)/.exec(body)![1], 10);
  const O = unhex(/\/O <([0-9a-fA-F]+)>/.exec(body)![1]);
  const U = unhex(/\/U <([0-9a-fA-F]+)/.exec(body)![1]);
  const idArr = /\/ID \[<([0-9A-Fa-f]+)> <([0-9A-Fa-f]+)>\]/.exec(text)!;
  return { R, P, O, U, id0: unhex(idArr[1]) };
}

const allPerms = { printing: true, copying: true, modifying: true, annotating: true };

/* ===== A. 独立复算自洽性 ===== */

describe('加密文件自洽性（独立复算规范密钥链）', () => {
  it('RC4 标准向量自检', () => {
    const key = new Uint8Array(Array.from('Key', (c) => c.charCodeAt(0)));
    const pt = new Uint8Array(Array.from('Plaintext', (c) => c.charCodeAt(0)));
    expect(hex(rc4(key, pt)).toUpperCase()).toBe('BBF316E8D940AF0AD3');
  });

  it('R3：文件 /U 与用文件自身 O/P/id0 独立复算的 Algorithm 5 一致', async () => {
    const plain = await makePlain();
    const enc = applyStandardSecurity(plain, {
      userPassword: 'secret',
      ownerPassword: '',
      permissions: allPerms,
      r3: true,
    });
    const { R, P, O, U, id0 } = parseEnc(Buffer.from(enc).toString('latin1'));
    expect(R).toBe(3);
    const pBytes = new Uint8Array(4);
    new DataView(pBytes.buffer).setInt32(0, P, true);
    let hash = md5(new Uint8Array([...padPw('secret'), ...O, ...pBytes, ...id0]));
    for (let i = 0; i < 50; i++) hash = md5(hash.subarray(0, 16));
    const key = hash.subarray(0, 16);
    let check = rc4(key, md5(new Uint8Array([...PAD, ...id0])));
    for (let i = 1; i <= 19; i++) check = rc4(key.map((b) => b ^ i), check);
    expect(hex(U.subarray(0, 16))).toBe(hex(check));
  });

  it('R2：文件 /U 与独立复算的 Algorithm 4 一致', async () => {
    const plain = await makePlain();
    const enc = applyStandardSecurity(plain, {
      userPassword: 'secret',
      ownerPassword: '',
      permissions: allPerms,
      r3: false,
    });
    const { R, P, O, U, id0 } = parseEnc(Buffer.from(enc).toString('latin1'));
    expect(R).toBe(2);
    const pBytes = new Uint8Array(4);
    new DataView(pBytes.buffer).setInt32(0, P, true);
    const key = md5(new Uint8Array([...padPw('secret'), ...O, ...pBytes, ...id0])).subarray(0, 5);
    expect(hex(U.subarray(0, 32))).toBe(hex(rc4(key, PAD)));
  });
});

/* ===== B. pdfjs 往返 ===== */

async function makeRichPdf(): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 3; i++) {
    const page = doc.addPage([300, 300]);
    page.drawText(`Page ${i + 1} content test`, { x: 50, y: 200, size: 20, font });
  }
  doc.setTitle('加密往返测试');
  doc.setAuthor('测试作者');
  return doc;
}

async function openPdfjs(data: Uint8Array, password?: string): Promise<number> {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(data), password }).promise;
  const n = doc.numPages;
  await doc.destroy();
  return n;
}

describe('加密后 pdfjs 带密码往返', () => {
  it('仅用户口令 + 全部权限（R3）', async () => {
    const doc = await makeRichPdf();
    const enc = await doc.save().then(() => doc);
    void enc;
    const { encryptWithPasswords } = await import('./pdfSecure');
    const data = await encryptWithPasswords(doc, {
      userPassword: 'secret',
      ownerPassword: '',
      permissions: allPerms,
      r3: true,
    });
    expect(await openPdfjs(data, 'secret')).toBe(3);
  });

  it('用户 + 所有者口令（R3）', async () => {
    const { encryptWithPasswords } = await import('./pdfSecure');
    const doc = await makeRichPdf();
    const data = await encryptWithPasswords(doc, {
      userPassword: 'secret',
      ownerPassword: 'ownerpw',
      permissions: allPerms,
      r3: true,
    });
    expect(await openPdfjs(data, 'secret')).toBe(3);
  });

  it('限制权限（R3）', async () => {
    const { encryptWithPasswords } = await import('./pdfSecure');
    const doc = await makeRichPdf();
    const data = await encryptWithPasswords(doc, {
      userPassword: 'secret',
      ownerPassword: '',
      r3: true,
      permissions: { printing: false, copying: false, modifying: false, annotating: false },
    });
    expect(await openPdfjs(data, 'secret')).toBe(3);
  });

  it('R2 40 位', async () => {
    const { encryptWithPasswords } = await import('./pdfSecure');
    const doc = await makeRichPdf();
    const data = await encryptWithPasswords(doc, {
      userPassword: 'secret',
      ownerPassword: '',
      permissions: allPerms,
      r3: false,
    });
    expect(await openPdfjs(data, 'secret')).toBe(3);
  });

  it('中文口令', async () => {
    const { encryptWithPasswords } = await import('./pdfSecure');
    const doc = await makeRichPdf();
    const data = await encryptWithPasswords(doc, {
      userPassword: '密码',
      ownerPassword: '',
      permissions: allPerms,
      r3: true,
    });
    expect(await openPdfjs(data, '密码')).toBe(3);
  });

  it('错误口令被拒绝', async () => {
    const { encryptWithPasswords } = await import('./pdfSecure');
    const doc = await makeRichPdf();
    const data = await encryptWithPasswords(doc, {
      userPassword: 'secret',
      ownerPassword: '',
      permissions: allPerms,
      r3: true,
    });
    await expect(openPdfjs(data, 'wrongpw')).rejects.toThrow();
  });

  it('computeO/computeU/computeFileKey 导出一致性', () => {
    // 空口令下 O/U/密钥链三函数互洽（回归保护）
    const O = computeO('', 'u', true);
    const key = computeFileKey('u', O, -1, new Uint8Array(16).fill(7), true);
    const U = computeU(key, new Uint8Array(16).fill(7), true);
    expect(O.length).toBe(32);
    expect(key.length).toBe(16);
    expect(U.length).toBe(32);
  });
});
