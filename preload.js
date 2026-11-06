'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (name) => (...args) => ipcRenderer.invoke(`sa:${name}`, ...args);

contextBridge.exposeInMainWorld('sa', {
  platform: process.platform,
  getState: call('getState'),
  pickFiles: call('pickFiles'),
  pickMedia: call('pickMedia'),
  pickFolders: call('pickFolders'),
  describePaths: call('describePaths'),
  readClipboard: call('readClipboard'),
  saveImageData: call('saveImageData'),
  thumbnail: call('thumbnail'),
  send: call('send'),
  retrySend: call('retrySend'),
  shareStart: call('shareStart'),
  shareStop: call('shareStop'),
  respondShare: call('respondShare'),
  qr: call('qr'),
  cancelTransfer: call('cancelTransfer'),
  respondReceive: call('respondReceive'),
  chooseDestination: call('chooseDestination'),
  scanNow: call('scanNow'),
  cancelScan: call('cancelScan'),
  addHost: call('addHost'),
  removeHost: call('removeHost'),
  toggleFavorite: call('toggleFavorite'),
  suggestNetworks: call('suggestNetworks'),
  updateSettings: call('updateSettings'),
  deleteHistory: call('deleteHistory'),
  openPath: call('openPath'),
  showInFolder: call('showInFolder'),
  copyText: call('copyText'),
  firewallStatus: call('firewallStatus'),
  enableFirewall: call('enableFirewall'),
  randomAlias: call('randomAlias'),
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },
  onEvent: (cb) => {
    const fn = (_e, msg) => cb(msg);
    ipcRenderer.on('sa:event', fn);
    return () => ipcRenderer.removeListener('sa:event', fn);
  },
});
