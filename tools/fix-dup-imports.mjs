// 修复恢复重放造成的「import 语句重复」：对文件顶部 import 区按语句文本去重（保留首现）。
// 用法：node tools/fix-dup-imports.mjs <file...>
import fs from 'node:fs';

for (const file of process.argv.slice(2)) {
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n');
  const out = [];
  const seen = new Set();
  let i = 0;
  let inImport = false;
  let stmt = [];
  const flush = () => {
    if (stmt.length) {
      const key = stmt.join('\n').replace(/\s+/g, ' ').trim();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(...stmt);
      }
      stmt = [];
    }
  };
  for (; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (stmt.length > 0) {
      stmt.push(line);
      if (/['"];\s*$/.test(line) || (t === '}' && stmt.join(' ').includes("from"))) {
        // 语句可能到 from '...'; 结束，也可能多行括号；统一以分号行结束判断
        if (/;\s*$/.test(line)) flush();
      }
      continue;
    }
    if (/^import\b/.test(t) || /^} from\b/.test(t)) {
      inImport = true;
      stmt.push(line);
      if (/;\s*$/.test(t)) flush();
      continue;
    }
    if (inImport && (t === '' || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*'))) {
      // import 区里的空行/注释原样保留
      flush();
      out.push(line);
      continue;
    }
    inImport = false;
    flush();
    out.push(...lines.slice(i));
    break;
  }
  if (i >= lines.length) flush();
  const fixed = out.join('\n');
  if (fixed !== src) {
    fs.writeFileSync(file, fixed);
    console.log(`fixed ${file} (${src.split('\n').length} -> ${fixed.split('\n').length} 行)`);
  } else {
    console.log(`unchanged ${file}`);
  }
}
