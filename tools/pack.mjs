#!/usr/bin/env node
/**
 * 统一打包入口：固定输出到 dist-pkg-current，且每次打包前先清空。
 *
 * 为什么需要它：历史上每次打包都用 `-c.directories.output=dist-pkg-pN` 临时改名，
 * 结果堆了 26 个 1GB 级目录（合计 20GB）。本脚本锁死输出目录 + 强制清空。
 *
 * 用法：
 *   node tools/pack.mjs                # 清空 → 构建渲染层 → 打 NSIS 安装包
 *   node tools/pack.mjs --skip-build   # 跳过 vite build（dist 已最新时）
 *   node tools/pack.mjs --clean-only   # 只清空输出目录，不打包
 *
 * 注意：不要再用 `npx electron-builder -c.directories.output=xxx` 直接打包。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist-pkg-current');
const args = new Set(process.argv.slice(2));
const SKIP_BUILD = args.has('--skip-build');
const CLEAN_ONLY = args.has('--clean-only');

const mb = (n) => `${(n / 1048576).toFixed(0)}MB`;
const longPath = (p) => (process.platform === 'win32' ? '\\\\?\\' + path.resolve(p) : p);

function walk(dir, out = []) {
  let ents;
  try {
    ents = fs.readdirSync(longPath(dir), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** 清空输出目录：unlink → 失败则 truncate(0)（Locked 文件的唯一降级路径）→ rmdir */
function cleanOutput() {
  if (!fs.existsSync(longPath(OUT))) {
    console.log(`[clean] ${path.relative(ROOT, OUT)} 不存在，跳过`);
    return 0;
  }
  const files = walk(OUT);
  let freed = 0;
  let locked = 0;
  for (const f of files) {
    let sz = 0;
    try {
      sz = fs.statSync(longPath(f)).size;
    } catch {}
    try {
      fs.unlinkSync(longPath(f));
      freed += sz;
      continue;
    } catch {}
    try {
      fs.truncateSync(longPath(f), 0);
      freed += sz;
      locked++;
      continue;
    } catch {}
    locked++;
  }
  try {
    fs.rmSync(longPath(OUT), { recursive: true, force: true });
  } catch {}

  if (fs.existsSync(longPath(OUT))) {
    console.log(
      `[clean] 部分残留（${locked} 个文件被占用，已截断为 0 字节），已释放 ${mb(freed)}；建议关闭占用进程后重跑`,
    );
  } else {
    console.log(`[clean] 输出目录已清空，释放 ${mb(freed)}`);
  }
  return freed;
}

function run(cmd, cmdArgs, label) {
  console.log(`\n[${label}] ${cmd} ${cmdArgs.join(' ')}`);
  const r = spawnSync(cmd, cmdArgs, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
  });
  if (r.status !== 0) {
    console.error(`\n[${label}] 失败，退出码 ${r.status}`);
    process.exit(r.status ?? 1);
  }
}

// ---- 1) 清空 ----
cleanOutput();
if (CLEAN_ONLY) {
  console.log('\n仅清理模式，结束。');
  process.exit(0);
}

// ---- 2) 构建 ----
if (!SKIP_BUILD) run('npm', ['run', 'build'], 'build');

// ---- 3) 打包（输出目录写死，禁止临时改名） ----
const bin = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');
const builder = fs.existsSync(bin) ? bin : 'npx';
run(builder, builder === 'npx' ? ['electron-builder', '--win', 'nsis'] : ['--win', 'nsis'], 'pack');

// ---- 4) 汇报产物 ----
console.log('\n[产物]');
for (const f of fs.readdirSync(longPath(OUT))) {
  if (/\.(exe|blockmap|yml)$/i.test(f)) {
    const sz = fs.statSync(path.join(OUT, f)).size;
    console.log(`  ${f}  (${mb(sz)})`);
  }
}
console.log(`\n输出目录：${OUT}`);
console.log('提示：本目录每次打包都会被清空，需要留存的交付包请另行复制出去。');
