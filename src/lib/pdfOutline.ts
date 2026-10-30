// PDF 大纲（书签）读取与重建。
// 读取：pdfjs-dist（能解析命名/显式 destination 并解析到页码）。
// 重建：pdf-lib 底层对象（copyPages 不会搬运大纲，栅格化重建文档时靠它保留导航）。
import { PDFDocument, PDFDict, PDFName, PDFNumber, PDFRef } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { pdfTextString } from './pdfText';

// worker 仅在浏览器环境注入；node（单测）下 pdfjs 用自带 fake worker
if (typeof window !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
}

export interface OutlineNode {
  title: string;
  page: number; // 1 起；无法解析页码时为 1
  children: OutlineNode[];
}

// pdfjs getOutline 的行内类型（其 OutlineNode 未导出，本地对齐）
interface PdfOutlineItem {
  title: string;
  dest: string | any[] | null;
  items?: PdfOutlineItem[];
}

type Dest = string | any[];

// pdfjs 的 destination 解析为 1 起页码；失败返回 null
async function resolveDestPage(pdf: pdfjsLib.PDFDocumentProxy, dest: Dest | undefined): Promise<number | null> {
  try {
    let d: any[] | null = null;
    if (typeof dest === 'string') d = (await pdf.getDestination(dest)) as any[] | null;
    else if (Array.isArray(dest)) d = dest;
    if (!d || d.length === 0) return null;
    const ref = d[0];
    // 显式 destination 首元素是页码 RefProxy；少数结构是 [pageRef, /XYZ, ...]
    const idx = typeof ref === 'object' && ref && 'num' in ref ? await pdf.getPageIndex(ref) : null;
    return idx === null ? null : idx + 1;
  } catch {
    return null;
  }
}

async function readOutlineNodes(pdf: pdfjsLib.PDFDocumentProxy, items: PdfOutlineItem[], depth: number): Promise<OutlineNode[]> {
  const out: OutlineNode[] = [];
  for (const it of items) {
    const page = (await resolveDestPage(pdf, it.dest as Dest | undefined)) ?? 1;
    const children = depth < 8 && it.items?.length ? await readOutlineNodes(pdf, it.items, depth + 1) : [];
    out.push({ title: String(it.title ?? ''), page, children });
  }
  return out;
}

// 读取 PDF 大纲；无大纲返回 []
export async function readOutline(data: Uint8Array): Promise<OutlineNode[]> {
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(data) }).promise;
  try {
    const outline = (await pdf.getOutline()) as unknown as PdfOutlineItem[];
    if (!outline || outline.length === 0) return [];
    return await readOutlineNodes(pdf, outline, 0);
  } finally {
    pdf.destroy();
  }
}

// 大纲扁平化（深度优先），用于列表展示
export function flattenOutline(nodes: OutlineNode[]): { title: string; page: number; depth: number }[] {
  const out: { title: string; page: number; depth: number }[] = [];
  const walk = (ns: OutlineNode[], d: number) => {
    for (const n of ns) {
      out.push({ title: n.title, page: n.page, depth: d });
      walk(n.children, d + 1);
    }
  };
  walk(nodes, 0);
  return out;
}

// 大纲章节区间：第 i 个节点覆盖 [page, 下一个同级或更浅节点的 page - 1]，末段到文档尾页
export function outlineSections(nodes: OutlineNode[], totalPages: number): { title: string; from: number; to: number; depth: number }[] {
  const flat: { title: string; page: number; depth: number }[] = [];
  const walk = (ns: OutlineNode[], d: number) => {
    for (const n of ns) {
      flat.push({ title: n.title, page: n.page, depth: d });
      walk(n.children, d + 1);
    }
  };
  walk(nodes, 0);
  return flat.map((f, i) => {
    let to = totalPages;
    for (let j = i + 1; j < flat.length; j++) {
      if (flat[j].depth <= f.depth) {
        to = flat[j].page - 1;
        break;
      }
    }
    return { title: f.title, from: f.page, to: Math.max(f.page, to), depth: f.depth };
  });
}

/* ===== 大纲重建（pdf-lib 底层） ===== */

// pageMap：源页码(1 起) -> 目标页码(1 起)；返回 null 表示该目标页不存在（跳过该书签）
export type PageMapFn = (srcPage: number) => number | null;

// 在 dest 文档中按 nodes 重建大纲。节点页码经 pageMap 转换；无效节点丢弃。
export function buildOutline(dest: PDFDocument, nodes: OutlineNode[], pageMap: PageMapFn): void {
  const ctx = dest.context;

  const makeItem = (n: OutlineNode, parentRef: PDFRef | null): PDFRef | null => {
    const target = pageMap(n.page);
    if (target === null) return null;
    const pageRef = dest.getPage(target - 1).ref;
    const dict = ctx.obj({
      Title: pdfTextString(n.title),
      Dest: ctx.obj([pageRef, PDFName.of('Fit')]),
    }) as PDFDict;
    const selfRef = ctx.register(dict);
    const childRefs: PDFRef[] = [];
    for (const c of n.children) {
      const r = makeItem(c, selfRef);
      if (r) childRefs.push(r);
    }
    if (childRefs.length > 0) {
      dict.set(PDFName.of('First'), childRefs[0]);
      dict.set(PDFName.of('Last'), childRefs[childRefs.length - 1]);
      dict.set(PDFName.of('Count'), PDFNumber.of(childRefs.length));
    }
    if (parentRef) dict.set(PDFName.of('Parent'), parentRef);
    return selfRef;
  };

  const roots: PDFRef[] = [];
  for (const n of nodes) {
    const r = makeItem(n, null);
    if (r) roots.push(r);
  }
  if (roots.length === 0) return;

  // 同级链接：Prev / Next
  const linkSiblings = (list: PDFRef[]) => {
    for (let i = 0; i < list.length; i++) {
      const d = ctx.lookup(list[i]) as PDFDict;
      if (i > 0) d.set(PDFName.of('Prev'), list[i - 1]);
      if (i < list.length - 1) d.set(PDFName.of('Next'), list[i + 1]);
    }
  };
  linkSiblings(roots);

  const rootDict = ctx.obj({
    Type: PDFName.of('Outlines'),
    First: roots[0],
    Last: roots[roots.length - 1],
    Count: PDFNumber.of(roots.length),
  }) as PDFDict;
  dest.catalog.set(PDFName.of('Outlines'), rootDict);
  // 顶层节点的 Parent 指向根
  for (const r of roots) (ctx.lookup(r) as PDFDict).set(PDFName.of('Parent'), rootDict);
}

// 移除文档大纲（保留元数据由调用方决定）
export function removeOutline(doc: PDFDocument): void {
  doc.catalog.delete(PDFName.of('Outlines'));
  doc.catalog.delete(PDFName.of('PageMode'));
}

// 用 PDFArray 的浅拷贝工具：把源大纲结构整体搬到目标文档不可行（跨文档引用），
// 因此统一走「读成页码树 -> 重建」。下面提供便捷封装。
export async function rebuildOutline(
  dest: PDFDocument,
  srcData: Uint8Array,
  pageMap: PageMapFn,
): Promise<void> {
  const nodes = await readOutline(srcData);
  if (nodes.length === 0) return;
  buildOutline(dest, nodes, pageMap);
}

// 小工具：把页码区间合并为 map 函数（恒等或整体偏移）
export function shiftPageMap(offset: number): PageMapFn {
  return (p) => {
    const t = p + offset;
    return t >= 1 ? t : null;
  };
}
