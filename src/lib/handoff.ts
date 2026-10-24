// 工具间文件传递总线：把处理结果从一个工具送到另一个工具（同一渲染进程）。
// 目前唯一通道：PDF 预处理 → 批量打印。Uint8Array 承载，接收方转 File。
export interface HandoffPdf {
  name: string;
  data: Uint8Array;
}

export const HANDOFF_BATCH_PRINT = 'chaoyu-handoff-batch-print';

export function sendToBatchPrint(files: HandoffPdf[]): void {
  if (!files.length) return;
  window.dispatchEvent(new CustomEvent<HandoffPdf[]>(HANDOFF_BATCH_PRINT, { detail: files }));
}

// 批量打印侧：把 handoff 文件转成 FileList 喂给导入入口
export function handoffToFileList(files: HandoffPdf[]): FileList {
  const dt = new DataTransfer();
  for (const f of files) {
    // TS 5.6 下 Uint8Array<ArrayBufferLike> 与 BlobPart 的泛型不兼容，此处收窄
    dt.items.add(new File([f.data as BlobPart], f.name, { type: 'application/pdf' }));
  }
  return dt.files;
}
