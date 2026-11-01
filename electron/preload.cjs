// Electron 预加载脚本：向渲染进程安全暴露打印桥
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  print: (opts) => ipcRenderer.invoke('print', opts),
  printPdf: (data, opts) => ipcRenderer.invoke('print-pdf', { data, opts }),
  listPrinters: () => ipcRenderer.invoke('list-printers'),
  checkOffice: (sofficePath) => ipcRenderer.invoke('check-office', sofficePath),
  convertOffice: (args) => ipcRenderer.invoke('convert-office', args),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  readFont: (paths) => ipcRenderer.invoke('read-font', paths),
  // 自动更新事件订阅（E11）：handler 收到 { type: 'available'|'progress'|'downloaded', ... }
  onUpdate: (handler) => {
    const onAvail = (_e, info) => handler({ type: 'available', info });
    const onProg = (_e, progress) => handler({ type: 'progress', progress });
    const onDone = (_e, info) => handler({ type: 'downloaded', info });
    ipcRenderer.on('update:available', onAvail);
    ipcRenderer.on('update:progress', onProg);
    ipcRenderer.on('update:downloaded', onDone);
    return () => {
      ipcRenderer.removeListener('update:available', onAvail);
      ipcRenderer.removeListener('update:progress', onProg);
      ipcRenderer.removeListener('update:downloaded', onDone);
    };
  },
  installUpdate: () => ipcRenderer.invoke('update:install'),
  setAutoStart: (enable) => ipcRenderer.invoke('set-autostart', enable),
  // 方案 C 导出：主进程 tmp + rename 原子写盘
  saveFile: (args) => ipcRenderer.invoke('save-file', args),
  saveFiles: (args) => ipcRenderer.invoke('save-files', args),
  pickSaveDir: (args) => ipcRenderer.invoke('pick-save-dir', args),
  // 批量导出进度订阅：handler 收到 { done, total, current }
  onExportProgress: (handler) => {
    const cb = (_e, p) => handler(p);
    ipcRenderer.on('export:progress', cb);
    return () => ipcRenderer.removeListener('export:progress', cb);
  },
  isElectron: true,
  // 打印载体页（printHelper.html）用的拉取式握手：主进程把待打印 PDF 暂存，
  // 载体页加载后主动来取，渲染完再回报 —— 比「先 load 后 send」少一类时序竞态。
  printJobPull: () => ipcRenderer.invoke('print-job-pull'),
  printHelperReady: (info) => ipcRenderer.invoke('print-helper-ready', info),
  // 本地预装资源根（P0-B）：渲染进程用它覆盖 @imgly/Tesseract 的资源地址，离线可用
  appResBase: 'appres://res/',
  // 启动体检（运行环境健康度）：探针采集 + 一键清理 + 临时根迁移到 D 盘
  healthProbe: () => ipcRenderer.invoke('health-probe'),
  healthCleanup: () => ipcRenderer.invoke('health-cleanup'),
  getAppTempRoot: () => ipcRenderer.invoke('get-app-temp-root'),
  setAppTempRoot: (root) => ipcRenderer.invoke('set-app-temp-root', root),
});
