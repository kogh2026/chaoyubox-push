// PDF 文本字符串编码工具。
// pdf-lib 的 PDFString.of() 只支持单字节（charCodeAt & 0xff），中文等
// 非 Latin-1 字符会被截断乱码。这里按 PDF 规范生成：
//   - 纯 Latin-1 字符 → 字面串 PDFString.of()
//   - 含非 Latin-1 字符 → UTF-16BE + BOM 的十六进制串 PDFHexString.of()
// 读取侧 pdf-lib 的 PDFString.decodeText() 已能自动识别 UTF-16 BOM。
import { PDFHexString, PDFString } from 'pdf-lib';

export type PdfText = PDFString | PDFHexString;

/** 是否含 Latin-1 以外的字符（需要 UTF-16 编码） */
export function needsUtf16(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0xff) return true;
  }
  return false;
}

/** 把 JS 字符串编码为 PDF 文本字符串对象（字面串或 UTF-16BE 十六进制串） */
export function pdfTextString(s: string): PdfText {
  if (!needsUtf16(s)) return PDFString.of(s);
  const bytes: number[] = [0xfe, 0xff]; // BOM
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    bytes.push((c >> 8) & 0xff, c & 0xff);
  }
  return PDFHexString.of(bytes.map((b) => b.toString(16).padStart(2, '0')).join(''));
}

/** 从 PDF 文本字符串的字节内容解码为 JS 字符串（UTF-16 BOM 或 PDFDocEncoding） */
export function decodePdfTextBytes(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    }
    return out;
  }
  // PDFDocEncoding 近似：与 Latin-1 一致的区间直接映射，其余用 charCode
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}
