#!/usr/bin/env node
/**
 * PDF 转曲（字体转轮廓）批处理
 *
 *   node tools/pdf-outline.mjs <文件或目录...> [--out DIR] [--jobs 4] [--gs PATH] [--keep-name]
 *
 * 引擎：Ghostscript 的 `-dNoOutputFonts`（把文本绘制成路径）。
 * 为什么不用 Acrobat Preflight：Acrobat 必须在交互式桌面会话里跑（会弹窗口、需要注入文档级 JS），
 * 更适合「本机批量处理客户文件」而不是随程序分发；详见 docs/pdf-outline.md。
 *
 * 每个产出都会做正向验证：用 pdf-lib 逐页读 /Resources/Font，
 * 字体引用必须归零，否则该文件判失败——转曲「看起来成功、实际没转」是最常见的坑。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';

const argv = process.argv.slice(2);
function take(flag, def) {
  const i = argv.indexOf(flag);
  if (i === -1) return def;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v ?? def;
}
const OUT_DIR = resolve(take('--out', 'outline-out'));
const JOBS = Number(take('--jobs', '4')) || 4;
const GS_ARG = take('--gs', '');
const KEEP_NAME = argv.includes('--keep-name');
if (KEEP_NAME) argv.splice(argv.indexOf('--keep-name'), 1);

const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', bold: '\x1b[1m', off: '\x1b[0m' }
  : { dim: '', red: '', green: '', yellow: '', bold: '', off: '' };

function findGs() {
  if (GS_ARG) return GS_ARG;
  if (process.env.GS_BIN) return process.env.GS_BIN;
  const roots = ['C:\\Program Files\\gs', 'C:\\Program Files (x86)\\gs'];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const vers = readdirSync(root)
      .filter((d) => d.startsWith('gs'))
      .sort()
      .reverse();
    for (const v of vers) {
      for (const exe of ['gswin64c.exe', 'gswin32c.exe']) {
        const p = join(root, v, 'bin', exe);
        if (existsSync(p)) return p;
      }
    }
  }
  const which = spawnSync('where', ['gswin64c'], { encoding: 'utf8' });
  if (which.status === 0) return which.stdout.split('\n')[0].trim();
  return null;
}

function collect(targets) {
  const files = [];
  for (const t of targets) {
    const p = resolve(t);
    if (!existsSync(p)) {
      console.warn(`${C.yellow}跳过（不存在）：${t}${C.off}`);
      continue;
    }
    if (statSync(p).isDirectory()) {
      for (const name of readdirSync(p)) {
        if (extname(name).toLowerCase() === '.pdf') files.push(join(p, name));
      }
    } else if (extname(p).toLowerCase() === '.pdf') {
      files.push(p);
    }
  }
  return files;
}

/** 逐页统计 /Resources/Font 的字体条目数（含继承资源） */
async function fontRefs(file) {
  const doc = await PDFDocument.load(readFileSync(file), { updateMetadata: false });
  let total = 0;
  const names = new Set();
  for (const page of doc.getPages()) {
    const res = page.node.Resources();
    if (!res || !res.get(PDFName.of('Font'))) continue;
    let font;
    try {
      font = res.lookup(PDFName.of('Font'), PDFDict);
    } catch {
      continue; // 资源项不是字典：按无字体处理，交给上层判定
    }
    if (!font) continue;
    for (const key of font.keys()) {
      total += 1;
      names.add(key.toString().replace(/^\//, ''));
    }
  }
  return { pages: doc.getPageCount(), total, names: [...names] };
}

function convert(gs, src, dst) {
  const t0 = Date.now();
  const r = spawnSync(
    gs,
    [
      '-q',
      '-dNOPAUSE',
      '-dBATCH',
      '-dSAFER',
      '-sDEVICE=pdfwrite',
      '-dNoOutputFonts',
      '-dCompatibilityLevel=1.5',
      `-sOutputFile=${dst}`,
      src,
    ],
    { encoding: 'utf8' },
  );
  return { ok: r.status === 0 && existsSync(dst), ms: Date.now() - t0, err: (r.stderr || '').trim() };
}

async function handle(gs, src) {
  const name = basename(src, extname(src));
  const dst = join(OUT_DIR, KEEP_NAME ? basename(src) : `${name}.outline.pdf`);
  const before = await fontRefs(src).catch(() => null);
  const conv = convert(gs, src, dst);
  if (!conv.ok) return { src, dst, ok: false, reason: conv.err || 'gs 失败', ms: conv.ms };

  const after = await fontRefs(dst).catch((e) => ({ error: String(e) }));
  if (after.error) return { src, dst, ok: false, reason: `产出无法解析：${after.error}`, ms: conv.ms };
  const fontsLeft = after.total;
  return {
    src,
    dst,
    ok: fontsLeft === 0 && after.pages === (before?.pages ?? after.pages),
    reason: fontsLeft === 0 ? '' : `仍有 ${fontsLeft} 处字体引用（${after.names.join(', ')}）`,
    ms: conv.ms,
    pages: after.pages,
    fontsBefore: before?.total ?? -1,
    fontsAfter: fontsLeft,
    sizeBefore: statSync(src).size,
    sizeAfter: statSync(dst).size,
  };
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

const kb = (n) => `${(n / 1024).toFixed(1)}KB`;

async function main() {
  const files = collect(argv);
  if (!files.length) {
    console.error('用法：node tools/pdf-outline.mjs <文件或目录...> [--out DIR] [--jobs 4]');
    process.exit(2);
  }
  const gs = findGs();
  if (!gs) {
    console.error(`${C.red}✖ 没找到 Ghostscript（gswin64c）。装一个或设 GS_BIN 环境变量。${C.off}`);
    process.exit(2);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`${C.bold}PDF 转曲${C.off} ${C.dim}${files.length} 个文件 · 引擎 gs${C.off}`);
  console.log(`${C.dim}gs: ${gs}${C.off}`);
  console.log(`${C.dim}输出: ${OUT_DIR}${C.off}\n`);

  const results = await pool(files, JOBS, (f) => handle(gs, f));

  let failed = 0;
  for (const r of results) {
    const tag = r.ok ? `${C.green}✔${C.off}` : `${C.red}✖${C.off}`;
    const name = basename(r.src);
    if (r.ok) {
      console.log(
        `${tag} ${name} ${C.dim}${r.pages}p · 字体 ${r.fontsBefore}→0 · ${kb(r.sizeBefore)}→${kb(r.sizeAfter)} · ${(r.ms / 1000).toFixed(1)}s${C.off}`,
      );
    } else {
      failed += 1;
      console.log(`${tag} ${name} ${C.red}${r.reason}${C.off}`);
    }
  }

  console.log(
    `\n${failed ? C.red : C.green}${files.length - failed}/${files.length} 成功${C.off}` +
      `${failed ? `，${failed} 个失败` : ''} ${C.dim}→ ${OUT_DIR}${C.off}`,
  );
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
