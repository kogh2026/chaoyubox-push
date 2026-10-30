#!/usr/bin/env node
/**
 * UI 设计质量回归检查（Impeccable）
 *
 * 做两遍扫描，再和基线比对，只对「新增」问题报警：
 *   1) 静态扫描  src/            —— 正则级规则（配色、字体、间距、结构写法），秒级
 *   2) 运行时扫描 dist/          —— 起本地静态服务，交给 Chromium 算真实样式
 *                                  （低对比度、字号过小等元素级规则只有这遍才跑）
 *
 * 基线存在 .impeccable/baseline.json，已存在问题不会阻塞，新增才会失败。
 *
 * 用法：
 *   node tools/ui-regression.mjs                  # 回归检查（dist 过期会自动构建）
 *   node tools/ui-regression.mjs --no-build       # 复用现有 dist，不构建
 *   node tools/ui-regression.mjs -u               # 重建基线（认可当前状态）
 *   node tools/ui-regression.mjs --mobile         # 额外跑 390x844 窄屏
 *   node tools/ui-regression.mjs --verbose        # 打印全部已知问题，按规则分组
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CLI = join(ROOT, 'node_modules', 'impeccable', 'cli', 'bin', 'cli.js');
const BASELINE = join(ROOT, '.impeccable', 'baseline.json');
const REPORT_DIR = join(ROOT, '.impeccable', 'reports');
const MAX_REPORTS = 20;

const argv = process.argv.slice(2);

function flag(name) {
  const i = argv.indexOf(name);
  if (i === -1) return false;
  argv.splice(i, 1);
  return true;
}

const OPT = {
  updateBaseline: flag('-u') || flag('--update-baseline'),
  noBuild: flag('--no-build'),
  verbose: flag('--verbose'),
  mobile: flag('--mobile'),
  staticOnly: flag('--static-only'),
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.tflite': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
};

const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', bold: '\x1b[1m', off: '\x1b[0m' }
  : { dim: '', red: '', green: '', yellow: '', bold: '', off: '' };

let step = 0;
function say(msg) {
  step += 1;
  console.log(`${C.dim}[${step}]${C.off} ${msg}`);
}

function die(msg, code = 1) {
  console.error(`${C.red}✖ ${msg}${C.off}`);
  process.exit(code);
}

// ── impeccable 调用 ────────────────────────────────────────────────────────

function impeccableVersion() {
  const r = spawnSync(process.execPath, [CLI, '--version'], { encoding: 'utf8' });
  return (r.stdout || '').trim() || 'unknown';
}

/**
 * 跑一次 detect --json，返回 { findings, failed }
 *
 * 必须异步：静态服务跑在本进程的事件循环里，spawnSync 会把事件循环堵死，
 * Chromium 拿不到响应，最终 Navigation timeout。
 */
function detect(targets, extra = []) {
  return new Promise((resolvePromise) => {
    const args = [CLI, 'detect', '--json', ...extra, ...targets];
    const child = spawn(process.execPath, args, { cwd: ROOT });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => resolvePromise({ findings: [], failed: String(e) }));
    child.on('close', (code) => {
      const text = out.trim();
      let findings = [];
      if (text) {
        try {
          findings = JSON.parse(text);
        } catch {
          resolvePromise({ findings: [], failed: `输出不是合法 JSON：${text.slice(0, 200)}` });
          return;
        }
      }
      // 退出码：0 无问题 / 2 有问题 / 1 有目标扫不了（1 优先于 2）
      if (code === 1) {
        resolvePromise({ findings, failed: err.trim().split('\n').slice(-3).join(' ') });
        return;
      }
      resolvePromise({ findings, failed: null });
    });
  });
}

// ── 静态服务（扫 dist） ────────────────────────────────────────────────────

function serveDist(dir) {
  const server = createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    let file = resolve(dir, '.' + url);
    if (!file.startsWith(dir)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) {
      // SPA 回退
      file = join(dir, 'index.html');
    }
    try {
      const body = readFileSync(file);
      res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream' });
      res.end(body);
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  });
  return new Promise((ok, no) => {
    server.on('error', no);
    server.listen(0, '127.0.0.1', () => ok({ server, port: server.address().port }));
  });
}

// ── 构建新鲜度 ────────────────────────────────────────────────────────────

function newestMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(p));
    else newest = Math.max(newest, statSync(p).mtimeMs);
  }
  return newest;
}

function mtimeOf(p) {
  const st = statSync(p);
  return st.isDirectory() ? newestMtime(p) : st.mtimeMs;
}

function distIsStale() {
  const index = join(ROOT, 'dist', 'index.html');
  if (!existsSync(index)) return true;
  const built = statSync(index).mtimeMs;
  return ['src', 'index.html']
    .map((p) => join(ROOT, p))
    .filter(existsSync)
    .some((p) => mtimeOf(p) > built);
}

function build() {
  // Windows 上直接 spawn npm.cmd 会 EINVAL（Node 对 .cmd 的 spawn 限制），走 shell 最稳
  const r = spawnSync('npm run build', { cwd: ROOT, stdio: 'inherit', shell: true });
  if (r.status !== 0) {
    die(`构建失败（status=${r.status}${r.error ? `, ${r.error.message}` : ''}），先修构建再跑 UI 回归`);
  }
}

// ── 归一化与比对 ──────────────────────────────────────────────────────────

function normalise(f, target, viewport) {
  const rule = f.antipattern || 'unknown';
  const selector = f.selector || '';
  const snippet = (f.snippet || '').trim();
  const key = createHash('sha1').update([target, rule, selector, snippet].join('\u0000')).digest('hex').slice(0, 16);
  return {
    key,
    rule,
    name: f.name || rule,
    severity: f.severity || (f.advisory ? 'advisory' : 'error'),
    advisory: Boolean(f.advisory),
    target,
    viewport,
    selector,
    snippet,
    line: f.line || 0,
  };
}

/** 同一个 key 只留一条（URL 扫描会对同类元素重复报同一处） */
function dedupe(list) {
  const map = new Map();
  for (const item of list) if (!map.has(item.key)) map.set(item.key, item);
  return [...map.values()].sort((a, b) =>
    (a.rule + a.target + a.selector + a.snippet).localeCompare(b.rule + b.target + b.selector + b.snippet),
  );
}

function loadBaseline() {
  if (!existsSync(BASELINE)) return null;
  try {
    return JSON.parse(readFileSync(BASELINE, 'utf8'));
  } catch {
    die(`基线文件损坏，删掉重跑 -u：${BASELINE}`);
  }
}

function saveBaseline(findings) {
  mkdirSync(join(ROOT, '.impeccable'), { recursive: true });
  const payload = {
    tool: `impeccable@${impeccableVersion()}`,
    updatedAt: new Date().toISOString(),
    note: '已认可存在的设计问题；新增问题才会让 ui:check 失败。重建：npm run ui:baseline',
    counts: countBy(findings),
    findings,
  };
  writeFileSync(BASELINE, JSON.stringify(payload, null, 2) + '\n');
}

function countBy(findings) {
  const byRule = {};
  let primary = 0;
  for (const f of findings) {
    if (f.advisory) continue;
    primary += 1;
    byRule[f.rule] = (byRule[f.rule] || 0) + 1;
  }
  return { primary, advisory: findings.length - primary, byRule };
}

function pruneReports() {
  if (!existsSync(REPORT_DIR)) return;
  const files = readdirSync(REPORT_DIR)
    .filter((n) => n.endsWith('.json'))
    .sort();
  for (const old of files.slice(0, Math.max(0, files.length - MAX_REPORTS))) {
    const p = join(REPORT_DIR, old);
    try {
      unlinkSync(p);
    } catch {
      try {
        writeFileSync(p, ''); // 句柄被占用时退化为清零
      } catch {
        /* 忽略 */
      }
    }
  }
}

function shortTarget(t) {
  return t.replace(/^url:\d+x\d+:/, '');
}

function describe(f) {
  const where = f.target.startsWith('url:') ? `${shortTarget(f.target)} ${f.selector || ''}` : `${shortTarget(f.target)}:${f.line}`;
  const detail = f.snippet.length > 110 ? f.snippet.slice(0, 110) + '…' : f.snippet;
  return `  ${C.yellow}${f.rule}${C.off} @ ${where}${detail ? `\n      ${C.dim}${detail}${C.off}` : ''}`;
}

function groupByRule(list) {
  const map = new Map();
  for (const f of list) {
    if (!map.has(f.rule)) map.set(f.rule, []);
    map.get(f.rule).push(f);
  }
  return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
}

// ── 主流程 ────────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(CLI)) die('没找到 impeccable，先跑 npm install');

  const version = impeccableVersion();
  console.log(`${C.bold}UI 回归检查${C.off} ${C.dim}impeccable@${version}${C.off}\n`);

  if (!OPT.staticOnly && !OPT.noBuild && distIsStale()) {
    say('dist 不存在或落后于 src，先构建…');
    build();
  } else if (OPT.staticOnly) {
    say('--static-only：只跑静态扫描，不构建、不起浏览器');
  } else if (!OPT.noBuild) {
    say('dist 是最新的，复用（跳过构建）');
  } else {
    say('--no-build：复用现有 dist');
  }
  if (!OPT.staticOnly && !existsSync(join(ROOT, 'dist', 'index.html'))) {
    die('dist/index.html 不存在，先 npm run build');
  }

  // 1) 静态扫描
  say('静态扫描 src/ …');
  const staticRes = await detect(['src']);
  if (staticRes.failed) die(`静态扫描失败：${staticRes.failed}`);
  const staticFindings = staticRes.findings.map((f) => {
    const rel = relative(ROOT, resolve(ROOT, f.file || '')).split(sep).join('/');
    return normalise(f, `file:${rel}`, '-');
  });
  say(`  静态命中 ${staticFindings.length} 条（${version} 的正则级规则）`);

  // 2) 运行时扫描
  const viewports = ['1280x800', ...(OPT.mobile ? ['390x844'] : [])];
  const urlFindings = [];
  if (!OPT.staticOnly) {
    const { server, port } = await serveDist(join(ROOT, 'dist'));
    try {
      for (const vp of viewports) {
        say(`运行时扫描 http://127.0.0.1:${port}/ @ ${vp} …`);
        const res = await detect([`http://127.0.0.1:${port}/`], ['--viewport', vp]);
        if (res.failed) die(`URL 扫描失败：${res.failed}`);
        const mapped = res.findings.map((f) => normalise(f, `url:${vp}:/`, vp));
        urlFindings.push(...mapped);
        say(`  命中 ${mapped.length} 条`);
      }
    } finally {
      server.close();
    }
  }

  const current = dedupe([...staticFindings, ...urlFindings]);
  const counts = countBy(current);

  // 3) 基线
  if (OPT.updateBaseline) {
    saveBaseline(current);
    say(`基线已写入 ${relative(ROOT, BASELINE)}：主问题 ${counts.primary} 条，建议级 ${counts.advisory} 条`);
    console.log(`\n${C.green}✔ 基线已更新${C.off}`);
    return;
  }

  const baseline = loadBaseline();
  if (!baseline) {
    console.log(`\n${C.yellow}⚠ 还没有基线${C.off}：本次结果按「全部为已知」处理，请先跑一次 npm run ui:baseline 认可现状。`);
    console.log(`  当前共 ${counts.primary} 条主问题 / ${counts.advisory} 条建议级。`);
    process.exitCode = 0;
    return;
  }

  // 只跟同作用域的基线条目比：--static-only 时 URL 条目不在本次扫描范围内，
  // 否则会被误判成「已修复」。
  const inScope = (t) => !OPT.staticOnly || t.startsWith('file:');
  const baseFindings = (baseline.findings || []).filter((f) => inScope(f.target));
  const baseKeys = new Set(baseFindings.map((f) => f.key));
  const currKeys = new Set(current.map((f) => f.key));
  const added = current.filter((f) => !baseKeys.has(f.key));
  const fixed = baseFindings.filter((f) => !currKeys.has(f.key));

  const addedPrimary = added.filter((f) => !f.advisory);
  const addedAdvisory = added.filter((f) => f.advisory);

  // 4) 报告
  mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
  const reportPath = join(REPORT_DIR, `ui-${stamp}.json`);
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        tool: `impeccable@${version}`,
        ranAt: new Date().toISOString(),
        viewports,
        baselineUpdatedAt: baseline.updatedAt,
        counts: { current: counts, added: countBy(added), fixed: fixed.length, unchanged: current.length - added.length },
        added,
        fixed,
        all: current,
      },
      null,
      2,
    ) + '\n',
  );
  pruneReports();

  // 5) 输出
  const knownPrimary = counts.primary - addedPrimary.length;
  console.log('');
  if (OPT.verbose) {
    console.log(`${C.bold}已知问题（${current.length} 条，按规则分组）${C.off}`);
    for (const [rule, list] of groupByRule(current)) {
      console.log(`\n${C.bold}${rule}${C.off} ${C.dim}× ${list.length}${C.off}`);
      for (const f of list) console.log(describe(f));
    }
    console.log('');
  }

  if (addedPrimary.length) {
    console.log(`${C.red}${C.bold}✖ 新增 ${addedPrimary.length} 条设计问题（回归）${C.off}`);
    for (const [rule, list] of groupByRule(addedPrimary)) {
      console.log(`\n  ${C.bold}${rule}${C.off} ${C.dim}× ${list.length}${C.off}`);
      for (const f of list) console.log(describe(f));
    }
  }
  if (addedAdvisory.length) {
    console.log(`\n${C.yellow}△ 新增 ${addedAdvisory.length} 条建议级（不阻塞）${C.off}`);
    for (const f of addedAdvisory) console.log(describe(f));
  }
  if (fixed.length) {
    console.log(`\n${C.green}✔ ${fixed.length} 条已修复${C.off}`);
    for (const [rule, list] of groupByRule(fixed)) {
      console.log(`  ${rule} ${C.dim}× ${list.length}${C.off}`);
    }
  }

  console.log(
    `\n${C.dim}已知 ${knownPrimary} 条 · 新增 ${addedPrimary.length} 条 · 修复 ${fixed.length} 条 · 建议级 ${counts.advisory} 条${C.off}`,
  );
  console.log(`${C.dim}报告：${relative(ROOT, reportPath)}${C.off}`);

  if (addedPrimary.length || addedAdvisory.length) {
    console.log(
      `\n${C.dim}确认这些是预期变更后，跑 npm run ui:baseline 认可新基线。${C.off}`,
    );
  }

  process.exitCode = addedPrimary.length ? 1 : 0;
}

main().catch((e) => die(e && e.stack ? e.stack : String(e)));
