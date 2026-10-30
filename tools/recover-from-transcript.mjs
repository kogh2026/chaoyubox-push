// 从会话记录（JSONL）里抽取本项目的全部 Write/Edit 操作，重放出每个文件的最终内容。
// 用法：node tools/recover-from-transcript.mjs <list|apply|dry>
//   list —— 只列出受影响文件与操作数
//   dry  —— 重放并报告每个文件的可行策略与校验标记，不写盘
//   apply—— 实际写盘（先把当前版本备份到 .scratch/revert-backup/）
import fs from 'node:fs';
import path from 'node:path';

const JSONL = 'C:/Users/Coldhack/.workbuddy/projects/d-Downloads-2026-10-23-08-38-11/e1f3a94e-cbac-4919-b244-adc929cef1b0.jsonl';
const ROOT = 'D:/Downloads/2026-10-23-08-38-11/aiyinbox-clone';
const MODE = process.argv[2] || 'list';

// ---- 1. 抽取操作序列 ----
// 记录格式：{ type:'function_call', name:'Write'|'Edit', arguments:<JSON 字符串或对象>, timestamp, cwd }
const ops = []; // { ts, tool, path, input }
const rl = fs.readFileSync(JSONL, 'utf8').split('\n');
for (const line of rl) {
  if (!line.includes('"function_call"')) continue;
  let obj;
  try { obj = JSON.parse(line); } catch { continue; }
  if (obj.type !== 'function_call' || (obj.name !== 'Write' && obj.name !== 'Edit')) continue;
  let args = obj.arguments;
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { continue; } }
  if (!args || !args.file_path) continue;
  const fp = String(args.file_path).replace(/\\/g, '/');
  if (!fp.includes('aiyinbox-clone')) continue;
  ops.push({ ts: obj.timestamp || 0, tool: obj.name, path: fp, input: args });
}
// 会话里路径有绝对/相对/“d/”“/d/”盘符相对四种，统一成绝对并合并
for (const o of ops) {
  let p = o.path;
  p = p.replace(/^\/([a-z])\//i, '$1:/'); // “/d/Downloads/...”（Git Bash 风格）
  p = p.replace(/^([a-z])\/(?!\/)/i, '$1:/'); // “d/Downloads/...”（相对盘根）
  if (!/^[A-Za-z]:\//.test(p)) p = path.posix.join(ROOT.replace(/\\/g, '/'), p.replace(/^\.?\//, ''));
  p = p.replace(/\/+/g, '/');
  p = p[0].toUpperCase() + p.slice(1);
  o.path = p;
}
// 排序：按记录出现顺序（文件本身按时间追加，天然有序）
// 排除恢复脚本自身（避免重放旧版本覆盖自己）
const SELF = path.posix.join(ROOT.replace(/\\/g, '/'), 'tools/recover-from-transcript.mjs');
const byFile = new Map();
for (const o of ops) {
  if (o.path === SELF) continue;
  if (!byFile.has(o.path)) byFile.set(o.path, []);
  byFile.get(o.path).push(o);
}

if (MODE === 'list') {
  for (const [p, list] of byFile) {
    const w = list.filter((o) => o.tool === 'Write').length;
    const e = list.length - w;
    const rel = path.relative(ROOT, p).replace(/\\/g, '/');
    console.log(`${rel}  Write×${w} Edit×${e}  exists=${fs.existsSync(p)}`);
  }
  console.log(`\n共 ${byFile.size} 个文件，${ops.length} 次操作`);
  process.exit(0);
}

// ---- 2. 重放 ----
const results = [];
const backupDir = path.join(ROOT, '.scratch', 'revert-backup');
for (const [p, list] of byFile) {
  const rel = path.relative(ROOT, p).replace(/\\/g, '/');
  if (rel.startsWith('..')) continue;
  let content = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  const origContent = content;

  // 策略：从最后一次 Write 起步（Write 是全量内容），依次应用其后的 Edit；
  // 若没有任何 Write，则从「最早一个能在当前盘上内容里命中 old_string 的 Edit」开始重放。
  let lastWrite = -1;
  for (let i = 0; i < list.length; i++) if (list[i].tool === 'Write') lastWrite = i;

  let startIdx, base;
  if (lastWrite >= 0) {
    startIdx = lastWrite;
    base = list[lastWrite].input.content;
  } else {
    startIdx = list.length;
    for (let k = 0; k < list.length; k++) {
      if (content != null && content.includes(list[k].input.old_string)) { startIdx = k; break; }
    }
    if (startIdx === list.length) {
      // 可能全部编辑都已应用过：new_string 在、old_string 不在
      const allDone = content != null && list.every((o) => content.includes(o.input.new_string ?? ''));
      if (allDone) {
        results.push({ rel, ok: true, applied: 0, skipped: list.length, failed: 0, changed: false, hasDisk: true, finalLen: content.length, note: '已应用' });
      } else {
        results.push({ rel, ok: false, reason: '无 Write 且当前内容不包含任何 Edit 的 old_string（基线对不上）' });
      }
      continue;
    }
    base = content;
  }

  let applied = 0, skipped = 0, failed = 0;
  const fails = [];
  let cur = base;
  for (let i = startIdx; i < list.length; i++) {
    const o = list[i];
    if (o.tool === 'Write') { cur = o.input.content; applied++; continue; }
    const oldS = o.input.old_string;
    const newS = o.input.new_string ?? '';
    if (cur.includes(oldS)) {
      cur = cur.replace(oldS, newS);
      applied++;
    } else if (cur.includes(newS)) {
      skipped++; // 已是目标状态
    } else {
      failed++;
      fails.push(`#${i} old=${oldS.slice(0, 70).replace(/\n/g, '⏎')}`);
    }
  }

  const changed = cur !== origContent;
  results.push({ rel, ok: failed === 0, applied, skipped, failed, fails, changed, hasDisk: origContent != null, finalLen: cur.length });
  if (MODE === 'dump' && (failed > 0 || !fs.existsSync(p))) {
    const out = path.join(ROOT, '.scratch', 'recovered', rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, cur);
  }
  if (MODE === 'apply' && changed && failed === 0) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (origContent != null) {
      const bdir = path.join(backupDir, path.dirname(rel));
      fs.mkdirSync(bdir, { recursive: true });
      fs.writeFileSync(path.join(backupDir, rel), origContent);
    }
    fs.writeFileSync(p, cur);
  }
  if (MODE === 'dry' && changed) {
    console.log(`[dry] ${rel}: applied=${applied} skipped=${skipped} failed=${failed} len=${cur.length}`);
  }
}

if (MODE === 'apply2') {
  // 以当前盘上内容（= 回退检查点状态）为基线，只重放检查点之后（boundary 之下）的工具操作。
  // python/脚本等非 Write/Edit 通道的改动已在磁盘基线里，不需要也无法从记录重放。
  const BOUNDARY = Date.parse('2026-10-26T10:00:00Z'); // 10-26 18:00 本地：此后才有今日改动
  let n = 0, bad = 0;
  for (const [p, list] of byFile) {
    const rel = path.relative(ROOT, p).replace(/\\/g, '/');
    if (rel.startsWith('..')) continue;
    const late = list.filter((o) => (o.ts || 0) > BOUNDARY);
    if (late.length === 0) continue;
    let cur = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
    let failed = 0;
    const fails = [];
    for (const o of late) {
      if (o.tool === 'Write') { cur = o.input.content; continue; }
      const oldS = o.input.old_string;
      const newS = o.input.new_string ?? '';
      if (cur != null && cur.includes(oldS)) cur = cur.replace(oldS, newS);
      else if (cur != null && cur.includes(newS)) { /* 已应用 */ }
      else { failed++; fails.push(`old=${oldS.slice(0, 70).replace(/\n/g, '⏎')}`); }
    }
    if (cur == null) { console.log(`SKIP ${rel}（盘上不存在且无 Write）`); continue; }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, cur);
    n++;
    if (failed) { bad++; console.log(`PARTIAL ${rel}: failed=${failed}`); for (const f of fails) console.log(`    ${f}`); }
    else console.log(`OK ${rel}（应用 ${late.length} 个操作）`);
  }
  console.log(`\napply2 完成：写盘 ${n} 个文件，其中不完整 ${bad} 个`);
  process.exit(0);
}

if (MODE === 'dry') {
  const bad = results.filter((r) => !r.ok);
  console.log(`\n校验：可恢复 ${results.filter((r) => r.ok).length} / ${results.length}；异常 ${bad.length}`);
  for (const b of bad) {
    console.log(`  FAIL ${b.rel}: ${b.reason || `failed=${b.failed}`}`);
    for (const f of b.fails || []) console.log(`      ${f}`);
  }
}
