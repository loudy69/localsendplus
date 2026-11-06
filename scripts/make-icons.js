'use strict';
// Run with: electron scripts/make-icons.js  -> writes assets/icon.png, icon.ico, tray.png
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { logoSvg } = require('../src/renderer/icons');

const out = path.join(__dirname, '..', 'assets');
const tile = (size) => `<div style="width:${size}px;height:${size}px;border-radius:${size * 0.22}px;background:linear-gradient(135deg,#00796b,#26c6b0);display:grid;place-items:center;color:#fff;--surface:#0b8f80">${logoSvg(Math.round(size * 0.72))}</div>`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = 6 + pngs.length * 16;
  const entries = pngs.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });
  const page = path.join(os.tmpdir(), 'sa-icon.html');
  fs.writeFileSync(page, '<!doctype html><body style="margin:0;background:transparent;overflow:hidden"></body>');
  const win = new BrowserWindow({ show: true, x: 40, y: 40, alwaysOnTop: true, width: 256, height: 256, useContentSize: true, transparent: true, frame: false, skipTaskbar: true, resizable: false });
  await win.loadFile(page);
  const pngs = [];
  for (const size of [16, 24, 32, 48, 64, 128, 256]) {
    await win.webContents.executeJavaScript(`document.body.innerHTML = ${JSON.stringify(tile(size))}`);
    await sleep(350);
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
    pngs.push({ size, data: img.toPNG() });
  }
  win.destroy();
  fs.writeFileSync(path.join(out, 'icon.png'), pngs.find((p) => p.size === 256).data);
  fs.writeFileSync(path.join(out, 'tray.png'), pngs.find((p) => p.size === 32).data);
  fs.writeFileSync(path.join(out, 'icon.ico'), ico(pngs));
  console.log('icons written');
  app.quit();
});
