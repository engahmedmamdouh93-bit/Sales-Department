const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('sd', {
  version: () => ipcRenderer.invoke('version'),
  info: () => ipcRenderer.invoke('info'),
  status: () => ipcRenderer.invoke('status'),
  brain: (prompt) => ipcRenderer.invoke('brain', prompt),
  setConfig: (c) => ipcRenderer.invoke('setConfig', c),
  setKey: (k) => ipcRenderer.invoke('setKey', k),
  setRepo: (repo, channel) => ipcRenderer.invoke('setRepo', repo, channel),
  checkUpdate: () => ipcRenderer.invoke('checkUpdate'),
  installUpdate: () => ipcRenderer.invoke('installUpdate')
});
