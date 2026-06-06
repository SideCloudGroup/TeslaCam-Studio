const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('teslaCam', {
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  scanFolder: (folderPath) => ipcRenderer.invoke('scan-folder', folderPath),
  readFileBuffer: (filePath) => ipcRenderer.invoke('read-file-buffer', filePath)
});
