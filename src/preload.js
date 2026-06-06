const {contextBridge, ipcRenderer} = require('electron');

contextBridge.exposeInMainWorld('teslaCam', {
    chooseFolder: () => ipcRenderer.invoke('choose-folder'),
    scanFolder: (folderPath) => ipcRenderer.invoke('scan-folder', folderPath),
    readFileBuffer: (filePath) => ipcRenderer.invoke('read-file-buffer', filePath),
    saveScreenshot: (payload) => ipcRenderer.invoke('save-screenshot', payload),
    exportVideoClip: (payload) => ipcRenderer.invoke('export-video-clip', payload),
    onExportVideoProgress: (callback) => {
        const listener = (_event, payload) => callback(payload);
        ipcRenderer.on('export-video-progress', listener);
        return () => ipcRenderer.removeListener('export-video-progress', listener);
    }
});
