// 统一临时文件根目录 —— 与 tools/tmproot.py 同一套口径：默认仓库内 `.tmp/`（D 盘）。
//
// 为什么不用 os.tmpdir()：Windows 的 %TEMP% 在 C 盘，本项目一轮门禁能产出数 GB
// （Electron 独立 userData、导出中间档、浏览器解压目录），C 盘写满后整条工具链
// 都会 ENOSPC。收口到仓库内 `.tmp/` 后随仓库一起在 D 盘。
//
// 覆盖：set CHAOYU_TMP_ROOT=E:\scratch
//
// 用法：
//   const { tmpRoot, mkdtemp, scratch, tempFile } = require('./tmproot.cjs');
//   const out = tempFile('chaoyu-v-123.pdf');   // 固定文件名
//   const dir = mkdtemp('chaoyu-export-');      // 唯一目录
//
// 注意：electron/*.cjs 里**只有开发态脚本**能 require 本文件；打包产物只含
// dist/ 与 electron/（不含 tools/），所以生产代码 officeCom.cjs 用的是内联版解析。

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENV_VAR = 'CHAOYU_TMP_ROOT';

function tmpRoot() {
  const env = process.env[ENV_VAR];
  const base = env ? path.resolve(env) : path.join(ROOT, '.tmp');
  fs.mkdirSync(base, { recursive: true });
  return base;
}

function mkdtemp(prefix) {
  return fs.mkdtempSync(path.join(tmpRoot(), prefix));
}

function scratch(name) {
  const d = path.join(tmpRoot(), name);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function tempFile(name) {
  return path.join(tmpRoot(), name);
}

module.exports = { ROOT, ENV_VAR, tmpRoot, mkdtemp, scratch, tempFile };

if (require.main === module) {
  console.log(`ROOT     = ${ROOT}`);
  console.log(`TMP_ROOT = ${tmpRoot()}`);
  console.log(`override = ${process.env[ENV_VAR] || '(未设置)'}`);
  console.log(`os.tmpdir() = ${os.tmpdir()}  <- 已不再使用`);
}
