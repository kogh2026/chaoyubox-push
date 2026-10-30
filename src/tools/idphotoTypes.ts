/** 证件照各面板共用的运行时模型（原先内联在 IdPhoto.tsx，拆分后独立成模块避免循环引用） */

/** 单张导入照片的运行时模型：用稳定 id 代替数组下标，避免增删后选中态错位 */
export interface PhotoItem {
  id: string;
  file: File;
  /** 预览用 object URL，移除时回收 */
  url: string;
}

/** 合成结果（预览与导出的渲染模型） */
export interface ComposeResult {
  id: string;
  name: string;
  blob: Blob;
  url: string;
}
