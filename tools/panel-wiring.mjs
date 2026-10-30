#!/usr/bin/env node
/**
 * 面板 props 接线检查（拆分方案步骤 6 的护栏）
 *
 *   node tools/panel-wiring.mjs
 *
 * 为什么需要它：IdPhoto 把三栏 JSX 拆成组件后，父组件要手写 15 / 15 / 63 个
 * `prop={同名的值}`。这类接线绝大部分能被 tsc 抓住，但**同类型的错接抓不住**——
 * `setBgId={setCustomHex}`、`setAdvShine={setAdvEye}` 都是 string/number setter，
 * 类型完全合法，编译通过、页面不报错，只是点「背景色」时改错了 state。
 * 编译器和现有冒烟脚本都发现不了这种错。
 *
 * 本脚本用四条规则把它变成可机械检查的事实：
 *   1. 父组件传的 prop 名集合 == 子组件 interface 的 prop 名集合（不漏、不多）；
 *   2. 每个 prop 都是 `name={name}` 自接线（不允许 `a={b}`）；
 *   3. 子组件解构了全部 prop（避免 interface 加了字段却忘了取）；
 *   4. （步骤 7 起）设置项**读写同键**：`setOption('k', …)` 所在控件若带
 *      `checked={x}` / `value={x}`，则 x 必须等于 k。`<input checked={sizeMark}
 *      onChange={… setOption('guideOn', …)}>` 类型完全合法、tsc 一声不响，
 *      只是点「尺寸标注」改到了「人像定位线」—— 规则 4 专治这类。
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const HOST = 'src/tools/IdPhoto.tsx';
const PANELS = [
  { tag: 'IdPhotoLeft', file: 'src/tools/IdPhotoLeft.tsx' },
  { tag: 'IdPhotoCenter', file: 'src/tools/IdPhotoCenter.tsx' },
  { tag: 'IdPhotoRight', file: 'src/tools/IdPhotoRight.tsx' },
];

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const host = read(HOST);

/** JSX 里 `<Tag ... />` 的属性列表 */
function attrsOf(tag) {
  const start = host.indexOf(`<${tag}\n`);
  if (start < 0) throw new Error(`IdPhoto.tsx 里没找到 <${tag}`);
  const end = host.indexOf('/>', start);
  const block = host.slice(start, end);
  const out = [];
  for (const line of block.split('\n').slice(1)) {
    const m = line.match(/^\s+([A-Za-z_$][\w$]*)=\{(.*)\},?\s*$/);
    if (m) out.push({ name: m[1], expr: m[2].trim() });
  }
  return out;
}

/** 子组件 `export interface TagProps { ... }` 的属性名 */
function propsOf(src, tag) {
  const start = src.indexOf(`export interface ${tag}Props {`);
  if (start < 0) throw new Error(`${tag} 没有导出 ${tag}Props`);
  const body = src.slice(start, src.indexOf('\n}', start));
  const out = [];
  for (const line of body.split('\n').slice(1)) {
    const m = line.match(/^\s{2}([A-Za-z_$][\w$]*)\??:/);
    if (m) out.push(m[1]);
  }
  return out;
}

/** 签名里的解构参数 */
function destructuredOf(src, tag) {
  const sig = src.indexOf(`export default function ${tag}({`);
  if (sig < 0) throw new Error(`${tag} 不是 ({...}: Props) 形式`);
  const body = src.slice(sig, src.indexOf('}:', sig));
  return body
    .split('\n')
    .map((l) => l.match(/^\s+([A-Za-z_$][\w$]*),?\s*$/))
    .filter(Boolean)
    .map((m) => m[1]);
}

let failed = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '  \u2714' : '  \u2716'} ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failed += 1;
}

for (const { tag, file } of PANELS) {
  const src = read(file);
  const attrs = attrsOf(tag);
  const props = propsOf(src, tag);
  const de = destructuredOf(src, tag);

  const aSet = new Set(attrs.map((a) => a.name));
  const pSet = new Set(props);
  const missing = props.filter((p) => !aSet.has(p));
  const extra = attrs.map((a) => a.name).filter((n) => !pSet.has(n));
  const foreign = attrs.filter((a) => a.expr !== a.name);
  const notDestructured = props.filter((p) => !de.includes(p));

  console.log(`\n${tag}  (${attrs.length} 个 prop)`);
  check(`父组件传的 prop 与 ${tag}Props 一致`, missing.length === 0 && extra.length === 0,
    missing.length || extra.length ? `缺 ${JSON.stringify(missing)} 多 ${JSON.stringify(extra)}` : '');
  check('全部自接线 name={name}', foreign.length === 0,
    foreign.length ? foreign.map((f) => `${f.name}={${f.expr}}`).join(', ') : '');
  check('interface 字段全部被解构', notDestructured.length === 0,
    notDestructured.length ? JSON.stringify(notDestructured) : '');
}

// ---------- 规则 4：设置项读写同键（步骤 7） ----------
const OPTION_FILES = ['src/tools/IdPhoto.tsx', 'src/tools/IdPhotoRight.tsx'];
const optionKeys = (() => {
  const src = read('src/lib/idphotoOptions.ts');
  const start = src.indexOf('export interface PhotoOptions {');
  if (start < 0) throw new Error('没找到 PhotoOptions');
  const body = src.slice(start, src.indexOf('\n}', start));
  return new Set(
    body
      .split('\n')
      .map((l) => l.match(/^\s{2}([A-Za-z_$][\w$]*)\??:/))
      .filter(Boolean)
      .map((m) => m[1]),
  );
})();

for (const file of OPTION_FILES) {
  const src = read(file);
  const marks = [...src.matchAll(/setOption\('([\w$]+)'/g)];
  const unknown = marks.map((m) => m[1]).filter((k) => !optionKeys.has(k));
  const mismatched = [];
  let checkedSites = 0;

  for (const m of marks) {
    const key = m[1];
    const pos = m.index;
    // 只看**同一个 JSX 元素**内部：从最近的 <input/<select/<textarea/<button 起
    const open = Math.max(
      src.lastIndexOf('<input', pos),
      src.lastIndexOf('<select', pos),
      src.lastIndexOf('<textarea', pos),
      src.lastIndexOf('<button', pos),
    );
    if (open < 0) continue;
    const window = src.slice(open, pos);
    if (window.includes('/>')) continue; // 元素已闭合 → setOption 不在这个元素里
    const readMatches = [...window.matchAll(/(?:checked|value)=\{([A-Za-z_$][\w$]*)\}/g)];
    if (readMatches.length === 0) continue; // 纯 onClick（色块/档位按钮）无从比对
    const readName = readMatches[readMatches.length - 1][1];
    checkedSites += 1;
    if (readName !== key) mismatched.push(`${readName} → setOption('${key}')`);
  }

  const short = file.split('/').pop();
  console.log(`\n${short}  (${marks.length} 处 setOption，${checkedSites} 处可比对)`);
  check('setOption 的键都在 PhotoOptions 里', unknown.length === 0, unknown.length ? JSON.stringify(unknown) : '');
  check('读写同键（checked/value 与 setOption 一致）', mismatched.length === 0, mismatched.join(', '));
}

if (failed) {
  console.log(`\nWIRING_FAIL  ${failed} 项不通过`);
  process.exit(1);
}
console.log('\nWIRING_OK');
