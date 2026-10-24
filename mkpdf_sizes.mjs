// 生成不同纸张尺寸的测试 PDF：A4(3页:黑白/红章/彩色)、A3、A5、A4双面命名
import { jsPDF } from 'jspdf';
import { writeFileSync } from 'node:fs';

const OUT = 'D:/Downloads/2026-10-23-08-38-11/';

// 1) A4 三页：纯黑白 / 红章 / 满版彩
const a4 = new jsPDF({ unit: 'pt', format: 'a4' });
a4.setFillColor(255, 255, 255); a4.rect(0, 0, 595.28, 841.89, 'F');
a4.setTextColor(0, 0, 0); a4.setFontSize(14);
a4.text('Page 1 pure black & white text only.', 40, 100);
a4.text('A4 size test.', 40, 130);
a4.addPage();
a4.setFillColor(255, 255, 255); a4.rect(0, 0, 595.28, 841.89, 'F');
a4.setTextColor(0, 0, 0); a4.text('Page 2 with red stamp.', 40, 100);
a4.setFillColor(210, 30, 30); a4.circle(300, 400, 60, 'F');
a4.setTextColor(255, 255, 255); a4.text('STAMP', 268, 405);
a4.addPage();
a4.setFillColor(40, 90, 200); a4.rect(40, 40, 515, 760, 'F');
a4.setTextColor(255, 255, 255); a4.setFontSize(28);
a4.text('Page 3 full color', 200, 400);
writeFileSync(OUT + 'test-bp.pdf', Buffer.from(a4.output('arraybuffer')));

// 2) A3 单页彩色
const a3 = new jsPDF({ unit: 'pt', format: 'a3' });
a3.setFillColor(40, 160, 80); a3.rect(0, 0, 841.89, 1190.55, 'F');
a3.setTextColor(255, 255, 255); a3.setFontSize(40);
a3.text('A3 COLOR PAGE', 250, 600);
writeFileSync(OUT + 'test-a3.pdf', Buffer.from(a3.output('arraybuffer')));

// 3) A5 单页黑白
const a5 = new jsPDF({ unit: 'pt', format: 'a5' });
a5.setFillColor(255, 255, 255); a5.rect(0, 0, 419.53, 595.28, 'F');
a5.setTextColor(0, 0, 0); a5.setFontSize(12);
a5.text('A5 black & white page', 30, 100);
writeFileSync(OUT + 'test-a5.pdf', Buffer.from(a5.output('arraybuffer')));

// 4) A4，文件名带 (2份)双面 → 测试文件名识别
const dup = new jsPDF({ unit: 'pt', format: 'a4' });
dup.setFillColor(255, 255, 255); dup.rect(0, 0, 595.28, 841.89, 'F');
dup.setTextColor(0, 0, 0); dup.setFontSize(12);
dup.text('dup-named file', 40, 100);
writeFileSync(OUT + 'test-(2份)双面.pdf', Buffer.from(dup.output('arraybuffer')));

console.log('PDFs written');
