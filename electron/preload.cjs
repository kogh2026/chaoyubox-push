// Electron 预加载脚本：向渲染进程安全暴露打印桥
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  print: (opts) => ipcRenderer.invoke('print', opts),
  listPrinters: () => ipcRenderer.invoke('list-printers'),
  checkOffice: (sofficePath) => ipcRenderer.invoke('check-office', sofficePath),
  convertOffice: (args) => ipcRenderer.invoke('convert-office', args),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  isElectron: true,
});
