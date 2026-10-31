// 在真实文件系统上验证 tmp + rename 原子写的核心保证。
// 之前这段逻辑埋在 main.cjs 里（顶部 require('electron')，Node 加载不了）根本没法验证，
// 抽成 atomicWrite.cjs 之后终于可以跑真实用例了。
const fs = require('fs');
const path = require('path');
const { mkdtemp } = require('../tools/tmproot.cjs'); // 工作目录落仓库 .tmp（D 盘），不占 C 盘
const {
  sanitizeFileName,
  listTaken,
  pickFreeName,
  assertInside,
  toBuffer,
  writeFileAtomic,
  translateFsError,
  pool,
} = require('./atomicWrite.cjs');

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name} ${extra}`);
  }
}

// 同目录残留 .tmp 文件数量——用来验证失败清理
function tmpResidues(dir) {
  return fs.readdirSync(dir).filter((n) => n.includes('.tmp'));
}

async function main() {
  const root = mkdtemp('chaoyu-atomic-');
  console.log(`工作目录: ${root}\n`);

  /* ---- 1. 基本写入 ---- */
  console.log('[1] 基本原子写');
  const t1 = path.join(root, '基本.pdf');
  const payload = Buffer.from('%PDF-1.4 测试内容');
  await writeFileAtomic(t1, payload);
  ok('目标文件已生成', fs.existsSync(t1));
  ok('内容完全一致', fs.readFileSync(t1).equals(payload));
  ok('没有残留临时文件', tmpResidues(root).length === 0, `残留: ${tmpResidues(root)}`);

  /* ---- 2. 覆盖已存在的文件 ---- */
  console.log('\n[2] 覆盖已有文件');
  await writeFileAtomic(t1, Buffer.from('第一版'));
  ok('第一次覆盖成功', fs.readFileSync(t1).toString() === '第一版');
  await writeFileAtomic(t1, Buffer.from('第二版很长很长的内容'));
  ok('第二次覆盖成功（新内容更长）', fs.readFileSync(t1).toString() === '第二版很长很长的内容');
  await writeFileAtomic(t1, Buffer.from('短'));
  ok('第三次覆盖成功（新内容更短，无残留尾巴）', fs.readFileSync(t1).toString() === '短');
  ok('覆盖后仍无临时文件残留', tmpResidues(root).length === 0);

  /* ---- 3. 目标目录不存在时自动创建 ---- */
  console.log('\n[3] 多级目录自动创建');
  const deep = path.join(root, 'a', 'b', 'c', '深层.pdf');
  await writeFileAtomic(deep, Buffer.from('x'));
  ok('多级目录被自动创建并写入', fs.existsSync(deep));

  /* ---- 4. 并发批量写：互不干扰、无残留 ---- */
  console.log('\n[4] 并发批量写');
  const batchDir = path.join(root, 'batch');
  const names = Array.from({ length: 20 }, (_, i) => `文件${i}.pdf`);
  await pool(names, 3, async (n) => {
    await writeFileAtomic(path.join(batchDir, n), Buffer.from(`内容-${n}`));
  });
  const written = fs.readdirSync(batchDir).filter((n) => n.endsWith('.pdf'));
  ok('20 个文件全部写入', written.length === 20, `实际: ${written.length}`);
  ok('每个文件内容正确', names.every((n) => fs.readFileSync(path.join(batchDir, n)).toString() === `内容-${n}`));
  ok('并发后无临时文件残留', tmpResidues(batchDir).length === 0);

  /* ---- 5. 失败时不留垃圾、且原文件不被破坏（原子性核心） ---- */
  console.log('\n[5] 写失败时的原子性保证');
  const keep = path.join(root, '受保护.pdf');
  await writeFileAtomic(keep, Buffer.from('原始内容-绝不能丢'));
  // 把目标换成目录：rename 到已存在的目录会失败（EISDIR/ENOTEMPTY），模拟真实落盘失败
  const asDir = path.join(root, '变成了目录.pdf');
  fs.mkdirSync(asDir, { recursive: true });
  let threw = false;
  try {
    await writeFileAtomic(asDir, Buffer.from('尝试写入'));
  } catch {
    threw = true;
  }
  ok('写入失败确实抛错', threw);
  ok('失败后原文件完好无损', fs.readFileSync(keep).toString() === '原始内容-绝不能丢');
  ok('失败后未留下临时文件', tmpResidues(root).length === 0, `残留: ${tmpResidues(root)}`);

  /* ---- 6. 文件名净化 ---- */
  console.log('\n[6] 文件名净化');
  ok('非法字符被替换', sanitizeFileName('a/b:c.pdf') === 'a_b_c.pdf');
  ok('保留设备名被处理', sanitizeFileName('CON') === '_CON');
  ok('路径穿越 ../ 被吃掉', !sanitizeFileName('../../etc/passwd').includes('..'));
  ok('空输入有兜底名', sanitizeFileName('') === '未命名');

  /* ---- 7. 路径逃逸的最后一道防线 ---- */
  console.log('\n[7] 路径逃逸防护');
  let escaped = false;
  try {
    // 即使净化没拦住，assertInside 也必须拦住
    assertInside(root, path.join(root, '..', '逃出去了.pdf'));
  } catch (e) {
    escaped = e.code === 'EACCES';
  }
  ok('逃出目标目录被拒绝', escaped);
  ok('留在目标目录内允许', (() => {
    try {
      assertInside(root, path.join(root, '正常.pdf'));
      return true;
    } catch {
      return false;
    }
  })());

  /* ---- 8. 字节转换零拷贝 ---- */
  console.log('\n[8] IPC 字节转换');
  const u8 = new Uint8Array([1, 2, 3, 4, 5]);
  const buf = toBuffer(u8);
  ok('Uint8Array → Buffer 内容一致', buf.equals(Buffer.from([1, 2, 3, 4, 5])));
  ok('直接传 Buffer 原样返回', toBuffer(buf) === buf);
  ok('空值得到空 Buffer', toBuffer(null).length === 0);
  // 偏移视图必须按 byteOffset 取值，不能从 buffer 开头读
  const src = new Uint8Array([9, 9, 7, 8, 9]);
  const view = src.subarray(2);
  ok('带偏移的视图转换正确', toBuffer(view).equals(Buffer.from([7, 8, 9])));

  /* ---- 9. 错误翻译 ---- */
  console.log('\n[9] 错误码翻译');
  ok('ENOSPC → 磁盘不足', translateFsError({ code: 'ENOSPC' }, '/x/a.pdf').error.includes('磁盘空间不足'));
  ok('EBUSY → 文件被占用', translateFsError({ code: 'EBUSY' }, '/x/a.pdf').error.includes('被占用'));
  ok('EPERM → 同占用（Windows 表现）', translateFsError({ code: 'EPERM' }, '/x/a.pdf').code === 'ebusy');
  ok('错误信息带文件名', translateFsError({ code: 'EBUSY' }, '/x/报价单.pdf').error.includes('报价单.pdf'));

  /* ---- 10. 受限并发 ---- */
  console.log('\n[10] 受限并发');
  let running = 0;
  let peak = 0;
  const rs = await pool([1, 2, 3, 4, 5, 6], 2, async (n) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    return n * 2;
  });
  ok('并发峰值为 2', peak === 2, `实际峰值: ${peak}`);
  ok('结果按输入顺序返回', rs.join(',') === '2,4,6,8,10,12');

  /* ---- 11. 批量同名录入：必须在数据包一层改成「自动顺延」而非覆盖 ---- */
  console.log('\n[11] 同名自动顺延（方案 A）');

  // 11a：纯函数层
  const taken0 = new Set();
  ok('目录里没有同名时原样使用', pickFreeName(taken0, '证件照.pdf') === '证件照.pdf');
  ok('第二次同名顺延为 (1)', pickFreeName(taken0, '证件照.pdf') === '证件照 (1).pdf');
  ok('第三次同名顺延为 (2)', pickFreeName(taken0, '证件照.pdf') === '证件照 (2).pdf');
  ok('不同名不受影响', pickFreeName(taken0, '别的.pdf') === '别的.pdf');

  const taken1 = new Set(['报价单.pdf']);
  ok('已存在时直接顺延', pickFreeName(taken1, '报价单.pdf') === '报价单 (1).pdf');

  const taken2 = new Set(['report.pdf']);
  ok('大小写不敏感（NTFS 语义）', pickFreeName(taken2, 'Report.PDF') === 'Report (1).PDF');
  ok('无扩展名也能顺延', pickFreeName(new Set(['名单']), '名单') === '名单 (1)');

  // 11b：真实磁盘端到端 —— 预先放一个同名文件，批量写入必须两个都在
  console.log('\n[12] 端到端：已有同名文件不被覆盖');
  const dupDir = path.join(root, 'dup');
  fs.mkdirSync(dupDir, { recursive: true });
  fs.writeFileSync(path.join(dupDir, '旧结果.pdf'), Buffer.from('上一次导出的内容'));

  const dupTaken = listTaken(dupDir);
  ok('listTaken 能读到已有文件', dupTaken.has('旧结果.pdf'));

  const dupNames = ['旧结果.pdf', '旧结果.pdf', '新文件.pdf'];
  await pool(dupNames, 3, async (n) => {
    const final = pickFreeName(dupTaken, n);
    await writeFileAtomic(path.join(dupDir, final), Buffer.from(`新内容-${final}`));
  });

  ok('旧文件内容完好（没被覆盖）', fs.readFileSync(path.join(dupDir, '旧结果.pdf')).toString() === '上一次导出的内容');
  const after = fs.readdirSync(dupDir).sort();
  ok('目录里变成 4 个文件', after.length === 4, `实际: ${after.join(' | ')}`);
  ok('产生了 (1) 与 (2) 两个副本', ['旧结果 (1).pdf', '旧结果 (2).pdf'].every((n) => after.includes(n)), `实际: ${after.join(' | ')}`);
  ok('副本内容各自正确', fs.readFileSync(path.join(dupDir, '旧结果 (1).pdf')).toString().includes('新内容-旧结果 (1).pdf'));
  ok('顺延后无临时文件残留', tmpResidues(dupDir).length === 0);

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('验证脚本异常:', e);
  process.exit(1);
});
