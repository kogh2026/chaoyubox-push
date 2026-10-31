// Office COM 模块校验（P2）：脚本生成、扩展名映射、无 Office 时的检测与回退语义。
// 运行：node electron/officeCom.check.cjs
const assert = require('assert');
const path = require('path');
const oc = require('./officeCom.cjs');
const { tempFile } = require('../tools/tmproot.cjs'); // 仅开发态脚本，打包产物不含 tools/

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log('  PASS  ' + name);
  } catch (e) {
    fail++;
    console.log('  FAIL  ' + name + ' → ' + (e && e.message));
  }
}

console.log('=== 纯函数：扩展名 → COM 程序 ===');
t('docx 走 Word', () => assert.strictEqual(oc.appFor('a.DOCX').progId, 'Word.Application'));
t('xlsx 走 Excel', () => assert.strictEqual(oc.appFor('b.xlsx').progId, 'Excel.Application'));
t('pptx 走 PowerPoint', () => assert.strictEqual(oc.appFor('c.pptx').progId, 'PowerPoint.Application'));
t('pdf 不走 COM', () => assert.strictEqual(oc.appFor('d.pdf'), null));

console.log('=== 脚本生成：导出方式与路径转义 ===');
const wordScript = oc.buildScript('word', "C:\\a b\\中文.docx", "C:\\out\\中文.pdf");
t('Word 用 ExportAsFixedFormat(…,17)', () => assert.ok(wordScript.includes('ExportAsFixedFormat') && wordScript.includes(', 17)')));
t('脚本包含输入/输出绝对路径', () => assert.ok(wordScript.includes("C:\\a b\\中文.docx") && wordScript.includes("C:\\out\\中文.pdf")));
t('Word 结束时 Quit 释放进程', () => assert.ok(wordScript.includes('$app.Quit(0)')));
t('单引号路径被转义（防注入）', () => {
  const s = oc.buildScript('excel', "C:\\it's.xlsx", 'C:\\o.pdf');
  assert.ok(s.includes("C:\\it''s.xlsx"));
});
t('Excel 用 ExportAsFixedFormat(0, …)', () => assert.ok(oc.buildScript('excel', 'a.xlsx', 'b.pdf').includes('ExportAsFixedFormat(0,')));
t('PowerPoint 用 SaveAs(…,32)', () => assert.ok(oc.buildScript('powerpoint', 'a.pptx', 'b.pdf').includes('SaveAs')));

(async () => {
  console.log('=== 运行时：本机无 Office 时应安全回退 ===');
  const out = tempFile('chaoyu-com-check.pdf');
  const r = await oc.convertWithCom('C:\\nonexistent.docx', out);
  t('未装 Office → skipped=true（不回退错误）', () => assert.strictEqual(r.skipped, true));
  const r2 = await oc.convertWithCom('C:\\nonexistent.pdf', out);
  t('不支持的扩展名 → skipped=true', () => assert.strictEqual(r2.skipped, true));

  const avail = await oc.comAvailable('Word.Application');
  t('comAvailable 返回布尔值且不抛错', () => assert.strictEqual(typeof avail, 'boolean'));
  console.log(`  INFO  本机 Word COM 可用性 = ${avail}`);

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})();
