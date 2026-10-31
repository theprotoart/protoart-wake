// The only bridge between the panel and the app. Exposes a few narrow functions.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wake', {
  onState: cb => ipcRenderer.on('state', (_e, s) => cb(s)),
  set: patch => ipcRenderer.send('set', patch),
  toggleApp: id => ipcRenderer.send('toggle-app', id),
  startApp: id => ipcRenderer.send('start-app', id),
  pickFile: () => ipcRenderer.send('pick-file'),
  onMenu: cb => ipcRenderer.on('menu', (_e, cmd) => cb(cmd)),
  lightsOut: () => ipcRenderer.send('lights-out'),
  quit: () => ipcRenderer.send('quit'),
});
