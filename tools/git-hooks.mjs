#!/usr/bin/env node
/**
 * 提交 / 推送门禁（由 husky 调用）
 *
 *   node tools/git-hooks.mjs pre-commit    # 秒级：类型 + 相关单测 + 反模式静态扫描
 *   node tools/git-hooks.mjs pre-push      # 分钟级：全量单测 + 完整 UI 回归（含构建）
 *   node tools/git-hooks.mjs pre-commit --all   # 无视暂存区，强制跑全部环节
 *
 * 设计取舍：pre-commit 只跑「不依赖构建产物」的检查——
 * 用 --no-build 的 ui 扫描会拿旧 dist 得出结论，等于自欺欺人；
 * 需要真实渲染的对比度/字号规则放在 pre-push（先构建再扫）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = process.argv.slice(2);
const MODE = argv[0] === 'pre-push' ? 'pre-push' : 'pre-commit';
const FORCE = argv.includes('--all');

const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', bold: '\x1b[1m', off: '\x1b[0m' }
  : { dim: '', red: '', green: '', yellow: '', bold: '', off: '' };

const NODE = process.execPath;
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const VITEST = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts });
}

function stagedFiles() {
  const r = sh('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR']);
  if (r.status !== 0) return [];
  return r.stdout
    .split('\n')
    .map((s) => s.trim().replace(/\\/g, '/'))
    .filter(Boolean);
}

function fmt(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 依次跑环节；任一失败立即中止 */
function runStages(title, stages) {
  if (!stages.length) {
    console.log(`${C.dim}── ${title}：没有需要检查的改动，跳过 ──${C.off}`);
    return 0;
  }
  console.log(`${C.bold}── ${title} ──${C.off}`);
  for (let i = 0; i < stages.length; i += 1) {
    const stage = stages[i];
    const tag = `[${i + 1}/${stages.length}]`;
    console.log(`${C.dim}${tag}${C.off} ${stage.name} …`);
    const t0 = Date.now();
    const r = stage.run();
    const ms = Date.now() - t0;
    if (r.status !== 0) {
      console.log(`${C.red}      ✖ 失败${C.off} ${C.dim}(${fmt(ms)})${C.off}\n`);
      printHelp(stage);
      return 1;
    }
    console.log(`${C.green}      ✔${C.off} ${C.dim}(${fmt(ms)})${C.off}`);
  }
  console.log(`${C.green}${C.bold}✔ ${title} 通过${C.off}\n`);
  return 0;
}

function printHelp(stage) {
  console.log(`${C.yellow}${C.bold}失败处理：${C.off}`);
  for (const line of stage.help) console.log(`  · ${line}`);
  console.log(`  · 紧急绕过：${C.bold}git ${MODE === 'pre-push' ? 'push' : 'commit'} --no-verify${C.off}` +
    `${C.dim}（请在提交信息里写明原因，事后补修）${C.off}`);
  console.log('');
}

// ── 环节定义 ──────────────────────────────────────────────────────────────

function typecheckStage() {
  return {
    name: `类型检查 ${C.dim}tsc --noEmit${C.off}`,
    run: () => sh(NODE, [TSC, '--noEmit'], { stdio: 'inherit' }),
    help: ['按 tsc 报错修类型，再重新提交', '只想确认：npm run typecheck'],
  };
}

function relatedTestsStage(files) {
  return {
    name: `相关单测 ${C.dim}vitest related · ${files.length} 个改动文件${C.off}`,
    run: () => sh(NODE, [VITEST, 'related', '--run', '--passWithNoTests', ...files], { stdio: 'inherit' }),
    help: ['按失败用例修实现或更新断言', '全量回归：npm test'],
  };
}

function fullTestsStage() {
  return {
    name: `全量单测 ${C.dim}vitest run${C.off}`,
    run: () => sh(NODE, [VITEST, 'run'], { stdio: 'inherit' }),
    help: ['按失败用例修实现或更新断言', '单个文件排查：node node_modules/vitest/vitest.mjs run <文件>'],
  };
}

function wiringStage() {
  return {
    name: `面板接线 ${C.dim}props 是否自接线、是否漏传${C.off}`,
    run: () => sh(NODE, [join(ROOT, 'tools', 'panel-wiring.mjs')], { stdio: 'inherit' }),
    help: [
      '错接（如 setBgId={setCustomHex}）→ 改成同名自接线；tsc 抓不住这类错，只有这一关能',
      '漏传/多传 prop → 对齐子组件 interface 与父组件标签',
    ],
  };
}

function uiStaticStage() {
  return {
    name: `设计反模式 ${C.dim}impeccable detect src（静态）${C.off}`,
    run: () => sh(NODE, [join(ROOT, 'tools', 'ui-regression.mjs'), '--static-only', '--no-build'], { stdio: 'inherit' }),
    help: [
      '真的反模式 → 改样式（渐变文字、AI 紫、过小字号等）',
      '确属误报 → node node_modules/impeccable/cli/bin/cli.js ignores add-value <rule> <value> --reason "原因"',
      '属于有意变更 → npm run ui:baseline（会把当前问题记入白名单）',
    ],
  };
}

function uiFullStage() {
  return {
    name: `UI 回归 ${C.dim}impeccable detect（构建 + 静态 + 运行时）${C.off}`,
    run: () => sh(NODE, [join(ROOT, 'tools', 'ui-regression.mjs')], { stdio: 'inherit' }),
    help: [
      '看报告里「新增」条目的文件:行号 / 选择器 / 实测对比度',
      '确认无回归后可直接推送；若是预期变更 → npm run ui:baseline',
    ],
  };
}

// ── 主流程 ────────────────────────────────────────────────────────────────

function main() {
  if (!existsSync(TSC) || !existsSync(VITEST)) {
    console.error(`${C.red}✖ 依赖缺失（typescript/vitest），先 npm install${C.off}`);
    return 1;
  }

  const changed = FORCE ? [] : stagedFiles();
  const codeChanged = changed.filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('.d.ts'));
  const uiChanged = changed.filter((f) => /\.(css|ts|tsx|html)$/.test(f));

  const isCode = FORCE || codeChanged.length > 0;
  const isUi = FORCE || uiChanged.length > 0;

  if (MODE === 'pre-push') {
    // 推送前：一切照跑，构建与运行时扫描都需要
    return runStages('pre-push 门禁（推送前，约 1 分钟）', [fullTestsStage(), uiFullStage()]);
  }

  const stages = [];
  if (isCode) {
    stages.push(typecheckStage());
    stages.push(wiringStage());
    if (FORCE) stages.push(fullTestsStage());
    else stages.push(relatedTestsStage(codeChanged));
  }
  if (isUi) stages.push(uiStaticStage());

  return runStages('pre-commit 门禁（提交前）', stages);
}

process.exit(main());
