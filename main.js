'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeImage, nativeTheme, Notification, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const argv = process.argv.slice(1);
const demo = argv.includes('--demo');
const shotDir = (argv.find((a) => a.startsWith('--screenshots=')) || '').split('=')[1];
const uitest = argv.includes('--uitest');

app.setName('LocalSendPlus');
// Portable mode (like LocalSend): a settings.json beside the executable keeps all data in that folder.
// Single-file portable builds report their real folder in PORTABLE_EXECUTABLE_DIR (the exe itself runs from a temp folder).
const exeDir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
const portable = app.isPackaged && (!!process.env.PORTABLE_EXECUTABLE_DIR || ['portable.txt', 'settings.json'].some((f) => fs.existsSync(path.join(exeDir, f))));
const portableData = path.join(exeDir, 'data');
if (portable) app.setPath('userData', path.join(portableData, 'app'));
if (demo || uitest) app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-demo-')));
if (process.platform === 'win32') app.setAppUserModelId('com.localsendplus.app');

if (!demo && !app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const { Engine } = require('./src/core/engine');
const { folderInfo } = require('./src/core/sender');
const { randomAlias } = require('./src/core/store');

let win = null;
let tray = null;
let engine = null;
let quitting = false;

const iconPath = path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
const trayIconPath = path.join(__dirname, 'assets', 'tray.png');

function send(type, data) {
  if (win && !win.isDestroyed()) win.webContents.send('sa:event', { type, data });
}

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1040,
    height: 740,
    minWidth: 780,
    minHeight: 560,
    title: 'LocalSendPlus',
    show: false,
    backgroundColor: '#0e1514',
    icon: iconPath,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    const hidden = argv.includes('--hidden') || (engine.store.get('startMinimized') && !engine.store.get('firstRun'));
    if (!hidden || shotDir) win.show();
  });
  win.on('close', (e) => {
    if (!quitting && engine.store.get('minimizeToTray') && tray) {
      e.preventDefault();
      win.hide();
    }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('closed', () => (win = null));
}

function createTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(trayIconPath));
  } catch {
    return;
  }
  tray.setToolTip('LocalSendPlus');
  const menu = Menu.buildFromTemplate([
    { label: 'Open LocalSendPlus', click: showWindow },
    { label: 'Scan for devices', click: () => engine.scanNow({}).catch(() => {}) },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', showWindow);
}

function notify(title, body) {
  if (!engine.store.get('notifications') || !Notification.isSupported()) return;
  if (win && win.isFocused()) return;
  const n = new Notification({ title, body, icon: iconPath });
  n.on('click', showWindow);
  n.show();
}

function wireEngine() {
  for (const ev of ['devices', 'transfer', 'scan', 'history', 'interfaces', 'settings', 'server-status', 'share', 'share-request-cancel']) engine.on(ev, (d) => send(ev, d));
  engine.on('share-request', (r) => {
    send('share-request', r);
    notify('Someone wants to download your shared files', `${r.ip} is asking for access. Open LocalSendPlus to allow or deny.`);
    if (win && !win.isFocused()) {
      showWindow();
      win.flashFrame(true);
    }
  });
  engine.on('receive-request', (r) => {
    send('receive-request', r);
    notify(`${r.sender.alias} wants to send you ${r.isMessage ? 'a message' : r.count === 1 ? '1 file' : `${r.count} files`}`, 'Open LocalSendPlus to accept or decline.');
    if (win && !win.isFocused()) {
      showWindow();
      win.flashFrame(true);
    }
  });
  engine.on('receive-request-cancel', (id) => send('receive-request-cancel', id));
  engine.on('message-received', ({ text, peer }) => {
    if (engine.store.get('autoCopyText')) clipboard.writeText(text);
    send('message-received', { text, peer, copied: engine.store.get('autoCopyText') });
    notify(`Message from ${peer.alias}`, text.slice(0, 120));
  });
  engine.on('receive-complete', (t) => {
    if (!t.isMessage && t.status === 'finished') notify(`Received from ${t.peer.alias}`, `${t.files.filter((f) => f.status === 'done').length} item(s) saved`);
  });
  engine.on('error', (e) => send('error', { message: e.message, code: e.code }));
}

function describe(p) {
  return fs.promises.stat(p).then(async (st) => {
    if (st.isDirectory()) {
      const info = await folderInfo(p);
      return { id: crypto.randomUUID(), kind: 'folder', path: p, name: path.basename(p), count: info.count, size: info.size };
    }
    return { id: crypto.randomUUID(), kind: 'file', path: p, name: path.basename(p), size: st.size };
  }).catch(() => null);
}

function registerIpc() {
  const h = (name, fn) => ipcMain.handle(`sa:${name}`, (_e, ...a) => fn(...a));

  h('getState', () => ({ ...engine.getState(), app: { version: app.getVersion(), platform: process.platform, demo, machineName: os.hostname(), canAutoStart: app.isPackaged, portable } }));

  const pick = async (properties, filters) => {
    const r = await dialog.showOpenDialog(win, { properties, filters });
    if (r.canceled) return [];
    return (await Promise.all(r.filePaths.map(describe))).filter(Boolean);
  };
  h('pickFiles', () => pick(['openFile', 'multiSelections']));
  h('pickMedia', () => pick(['openFile', 'multiSelections'], [
    { name: 'Photos and videos', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'bmp', 'mp4', 'mov', 'mkv', 'avi', 'webm'] },
    { name: 'All files', extensions: ['*'] },
  ]));
  h('pickFolders', () => pick(['openDirectory', 'multiSelections']));
  h('describePaths', async (paths) => (await Promise.all(paths.filter(Boolean).map(describe))).filter(Boolean));

  h('readClipboard', async () => {
    const out = { text: null, image: null, files: [] };
    const img = clipboard.readImage();
    if (!img.isEmpty()) {
      const dir = path.join(os.tmpdir(), 'LocalSendPlus');
      fs.mkdirSync(dir, { recursive: true });
      const name = `clipboard-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
      const p = path.join(dir, name);
      fs.writeFileSync(p, img.toPNG());
      out.image = { id: crypto.randomUUID(), kind: 'image', path: p, name, size: fs.statSync(p).size };
    }
    try {
      if (process.platform === 'win32' && clipboard.has('FileNameW')) {
        const raw = clipboard.readBuffer('FileNameW').toString('ucs2').replace(/\0+$/, '');
        if (raw && fs.existsSync(raw)) {
          const d = await describe(raw);
          if (d) out.files.push(d);
        }
      }
    } catch { /* not a file list */ }
    const text = clipboard.readText();
    if (text && text.trim() && !out.files.length) out.text = text;
    return out;
  });

  h('saveImageData', (dataUrl, name) => {
    const m = /^data:image\/(\w+);base64,(.+)$/.exec(dataUrl || '');
    if (!m) return null;
    const dir = path.join(os.tmpdir(), 'LocalSendPlus');
    fs.mkdirSync(dir, { recursive: true });
    const fname = name || `pasted-${Date.now()}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
    const p = path.join(dir, fname.replace(/[\\/:*?"<>|]/g, '_'));
    fs.writeFileSync(p, Buffer.from(m[2], 'base64'));
    return { id: crypto.randomUUID(), kind: 'image', path: p, name: path.basename(p), size: fs.statSync(p).size };
  });

  h('thumbnail', async (p) => {
    try {
      const img = await nativeImage.createThumbnailFromPath(p, { width: 128, height: 128 });
      return img.isEmpty() ? null : img.toDataURL();
    } catch {
      return null;
    }
  });

  h('send', async (deviceIds, items, pin) => {
    const ids = [];
    for (const d of [].concat(deviceIds)) ids.push(await engine.send(d, items, { pin }));
    return ids;
  });
  h('retrySend', (id, pin) => engine.retrySend(id, pin));
  h('shareStart', async (items, opts) => {
    try {
      return { ok: true, share: await engine.startShare(items, opts || {}) };
    } catch (e) {
      return { ok: false, error: e.code === 'EADDRINUSE' ? 'No free port for the share link - change the share port in Settings > Network.' : e.message };
    }
  });
  h('shareStop', () => engine.stopShare());
  h('respondShare', (id, accept) => engine.respondShare(id, accept));
  h('qr', (text) => require('qrcode').toString(String(text), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }));
  h('cancelTransfer', (id) => engine.cancelTransfer(id));
  h('respondReceive', (id, opts) => engine.respondReceive(id, opts || {}));
  h('chooseDestination', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: engine.store.get('destination') });
    return r.canceled ? null : r.filePaths[0];
  });
  h('scanNow', (opts) => engine.scanNow(opts || {}).catch(() => 0));
  h('cancelScan', () => engine.cancelScan());
  h('addHost', async (host, port) => {
    try {
      return { ok: true, device: await engine.addHost(host, port) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  h('removeHost', (id) => engine.store.patch({ hosts: engine.store.get('hosts').filter((x) => x.id !== id) }));
  h('toggleFavorite', (id) => engine.toggleFavorite(id));
  h('suggestNetworks', () => engine.suggestNetworks());
  h('updateSettings', async (patch) => {
    await engine.updateSettings(patch);
    if ('theme' in patch) nativeTheme.themeSource = patch.theme === 'oled' ? 'dark' : patch.theme;
    if ('launchAtLogin' in patch) setAutoStart(!!patch.launchAtLogin);
    return engine.publicSettings();
  });
  h('deleteHistory', (id) => engine.deleteHistory(id));
  h('openPath', (p) => shell.openPath(p));
  h('showInFolder', (p) => { if (fs.existsSync(p)) shell.showItemInFolder(p); else shell.openPath(path.dirname(p)); });
  h('copyText', (t) => clipboard.writeText(String(t)));
  h('randomAlias', () => randomAlias());


  const ruleName = 'LocalSendPlus';
  h('firewallStatus', () => new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({ supported: false });
    execFile('netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${ruleName}`], { windowsHide: true }, (err, out) => {
      resolve({ supported: true, enabled: !err && /Enabled:\s+Yes/i.test(out || ''), port: engine.store.get('port') });
    });
  }));
  h('enableFirewall', () => new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({ ok: false });
    const port = engine.store.get('port');
    const script = [
      `netsh advfirewall firewall delete rule name='${ruleName}' | Out-Null`,
      `netsh advfirewall firewall add rule name='${ruleName}' dir=in action=allow protocol=TCP localport=${port} profile=any | Out-Null`,
      `netsh advfirewall firewall add rule name='${ruleName}' dir=in action=allow protocol=UDP localport=${port} profile=any | Out-Null`,
    ].join('; ');
    const enc = Buffer.from(script, 'utf16le').toString('base64');
    execFile('powershell.exe', ['-NoProfile', '-Command', `Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','${enc}'`], { windowsHide: true }, (err) => resolve({ ok: !err }));
  }));
}

async function seedDemo() {
  const now = Date.now();
  const mk = (alias, ip, type, model, source, net, rtt) => engine.devices.set(ip, { id: ip, alias, deviceModel: model, deviceType: type, fingerprint: ip, ip, port: 53317, protocol: 'https', source, net, rtt, lastSeen: now, missed: 0, online: true });
  mk('Nice Orange', '192.168.1.42', 'mobile', 'Samsung', 'multicast', { kind: 'lan', label: 'Local network' }, 4);
  mk('Secret Banana', '192.168.1.77', 'desktop', 'Windows', 'multicast', { kind: 'lan', label: 'Local network' }, 2);
  mk('London Build Server', '10.20.4.15', 'server', 'Linux', 'scan', { kind: 'vpn', label: 'Branch VPN' }, 38);
  mk('Priya\u2019s Laptop', '10.20.4.88', 'desktop', 'macOS', 'scan', { kind: 'vpn', label: 'Branch VPN' }, 41);
  mk('Lab Pi', '172.16.9.12', 'headless', 'Linux', 'scan', { kind: 'routed', label: 'Lab network' }, 63);
  engine.store.patch({
    favorites: [{ fingerprint: '192.168.1.77', alias: 'Secret Banana', ip: '192.168.1.77', port: 53317, deviceType: 'desktop' }],
    networks: [
      { id: 'n1', name: 'Branch VPN', cidr: '10.20.4.0/24', kind: 'vpn', enabled: true },
      { id: 'n2', name: 'Lab network', cidr: '172.16.9.0/24', enabled: true },
      { id: 'n3', name: 'Datacentre (via router)', cidr: '10.50.0.0/22', enabled: false },
    ],
    hosts: [{ id: 'h1', host: 'buildbox.corp.example', port: 53317, alias: 'London Build Server' }],
  });
  engine.emit('devices', engine.deviceList());
  engine.emit('settings', engine.publicSettings());
  engine.emit('history', engine.history);
  engine.scan.networks = { n1: { lastScan: now - 120000, found: 2, hosts: 254 }, n2: { lastScan: now - 120000, found: 1, hosts: 254 } };
  engine.history.unshift(
    { id: 'd1', time: now - 3600e3, direction: 'receive', peer: { alias: 'Priya\u2019s Laptop', ip: '10.20.4.88', deviceType: 'desktop' }, status: 'finished', kind: 'files', count: 3, size: 18400000, files: [{ name: 'Q3-report.pdf', size: 4100000 }, { name: 'design.fig', size: 12000000 }], destination: engine.store.get('destination') },
    { id: 'd2', time: now - 7200e3, direction: 'send', peer: { alias: 'Nice Orange', ip: '192.168.1.42', deviceType: 'mobile' }, status: 'finished', kind: 'text', text: 'https://example.com/meeting-notes', count: 1, size: 33, files: [] }
  );
}

// Start with Windows: registers the packaged exe under the user's Run key, launched hidden in the tray.
const AUTOSTART = { path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath, args: ['--hidden'] };
function setAutoStart(on) {
  if (!app.isPackaged || demo || uitest || (process.platform !== 'win32' && process.platform !== 'darwin')) return;
  try { app.setLoginItemSettings({ openAtLogin: on, ...AUTOSTART }); } catch { /* not supported */ }
}
// Windows is the source of truth: if the user switched the entry off in Task Manager > Startup apps,
// reflect that in the toggle instead of silently re-enabling it.
function syncAutoStart() {
  if (!app.isPackaged || demo || uitest) return;
  const want = !!engine.store.get('launchAtLogin');
  try {
    const st = app.getLoginItemSettings(AUTOSTART);
    const actual = process.platform === 'win32' ? !!st.openAtLogin && st.executableWillLaunchAtLogin !== false : !!st.openAtLogin;
    if (want && !actual && st.openAtLogin) engine.store.patch({ launchAtLogin: false });
    else if (want && !st.openAtLogin) setAutoStart(true);
    else if (!want && st.openAtLogin) setAutoStart(false);
  } catch { /* ignore */ }
}

app.whenReady().then(async () => {
  const userData = app.getPath('userData');
  // A portable instance is identified by the PC it runs on: its device name follows the host name and its
  // certificate (fingerprint) is kept per host, so the same folder used on two PCs never presents one identity twice.
  const dataDir = portable ? portableData : path.join(userData, 'data');
  const firstPortableRun = portable && !fs.existsSync(path.join(dataDir, 'settings.json'));
  engine = new Engine({
    dir: dataDir,
    identityKey: portable ? os.hostname() : '',
    overrides: firstPortableRun ? { destination: path.join(exeDir, 'Received') } : {},
  });
  syncAutoStart();
  if (demo) engine.store.patch({ discovery: { multicast: false, scanLocalSubnets: false, scanRemote: false }, firstRun: false, port: 53399 });
  if (uitest) engine.store.patch({ discovery: { multicast: false, scanLocalSubnets: false, scanRemote: false }, firstRun: false, port: 53400, quickSave: 'off', destination: path.join(app.getPath('userData'), 'received') });
  nativeTheme.themeSource = engine.store.get('theme') === 'oled' ? 'dark' : engine.store.get('theme');
  registerIpc();
  wireEngine();
  createWindow();
  createTray();
  try {
    await engine.start();
  } catch (e) {
    send('error', { message: `Could not start the receiver: ${e.message}` });
  }
  if (demo) await seedDemo();
  if (engine.store.get('firstRun')) engine.store.patch({ firstRun: false });
  if (uitest) require('./scripts/uitest')(win, engine, () => { quitting = true; app.quit(); });
  if (shotDir) require('./scripts/shots')(win, shotDir, () => { quitting = true; app.quit(); });
});

app.on('second-instance', showWindow);
app.on('activate', showWindow);
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => { engine?.stop().catch(() => {}); });
app.on('window-all-closed', () => { if (quitting || !tray) app.quit(); });
