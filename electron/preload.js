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
  installUpdate: () => ipcRenderer.invoke('installUpdate'),
  contentInfo: () => ipcRenderer.invoke('contentInfo'),
  checkContent: () => ipcRenderer.invoke('contentCheck'),
  reloadContent: () => ipcRenderer.invoke('contentReload'),
  revertContent: () => ipcRenderer.invoke('contentRevert'),
  onContent: (cb) => ipcRenderer.on('content:ready', (e, info) => cb(info))
});
