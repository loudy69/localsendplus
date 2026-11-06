'use strict';
// Builds the browser edition: release/localsendplus-web-<ver>-win-<arch>.zip (bundles its own Node.js - nothing to install).
// Usage: node scripts/package-web.js [x64|arm64]
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const pkg = require('../package.json');

const root = path.join(__dirname, '..');
const NODE_VERSION = 'v22.23.4';
const arch = process.argv[2] === 'arm64' ? 'arm64' : 'x64';

async function ensureNode() {
  const dir = path.join(root, 'build', `node-${arch}`);
  const exe = path.join(dir, 'node.exe');
  if (fs.existsSync(exe) && fs.readFileSync(path.join(dir, 'VERSION.txt'), 'utf8').trim() === NODE_VERSION) return dir;
  const name = `node-${NODE_VERSION}-win-${arch}`;
  const base = `https://nodejs.org/dist/${NODE_VERSION}`;
  console.log(`Downloading ${name}.zip ...`);
  const zip = Buffer.from(await (await fetch(`${base}/${name}.zip`)).arrayBuffer());
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const want = sums.split('\n').find((l) => l.endsWith(`${name}.zip`)).split(/\s+/)[0];
  if (crypto.createHash('sha256').update(zip).digest('hex') !== want) throw new Error('Node.js download failed its checksum');
  fs.mkdirSync(dir, { recursive: true });
  const tmpZip = path.join(dir, 'node.zip');
  fs.writeFileSync(tmpZip, zip);
  execFileSync('tar.exe', ['-xf', tmpZip, '-C', dir, '--strip-components=1', `${name}/node.exe`, `${name}/LICENSE`]);
  fs.renameSync(path.join(dir, 'LICENSE'), path.join(dir, 'NODE-LICENSE.txt'));
  fs.rmSync(tmpZip);
  fs.writeFileSync(path.join(dir, 'VERSION.txt'), NODE_VERSION);
  return dir;
}

const README = `LocalSendPlus Web ${pkg.version} - browser edition (${arch}, no installation)
==========================================================

What it is
  The complete LocalSendPlus engine running on this PC, controlled from a browser. This PC is the device other
  people see - it uses the PC's name - and the browser is only its remote control. You can open the UI on this PC,
  or on another machine on the LAN or across a VPN.

Start
  Start-LocalSendPlus-Web.cmd          this PC only (http://localhost:53320). Opens your browser.
  Start-LocalSendPlus-Web-LAN.cmd      reachable from the LAN / VPN adapters, protected by the access token, over HTTPS.
  Anything else:  node\\node.exe web\\server.js --help

Access token
  Generated on first start and kept in data\\web-token.txt. The start scripts open the browser with it; for another
  device type the token on the sign-in page (or open the full link the server prints). Use --new-token to rotate it.

Devices on a VPN or another subnet
  Networks > VPN & routed ranges: add the address range (or use Detect). Any VPN client that is already connected works.
  To reach THIS web UI across a VPN, start it with --lan (or --host <this PC's VPN address>) and open
  https://<that address>:53320 from the other side (accept the self-signed certificate once).

Sending and receiving
  - Files, folders and pasted images you pick in the browser are uploaded to this PC (data\\staging, removed after
    24 h) and sent from here. Only those uploads can be sent - the UI cannot browse or send other files on the PC.
  - Received files are saved on this PC (Received\\ by default). Download them from History > folder icon.
  - Nobody is at the PC to press Accept? Use --quick-save (accepts everything) or set a PIN in Settings > Receive.
  - Allow inbound TCP/UDP 53317 once under Settings > Network > Windows Firewall so other devices can reach you.

Data lives in data\\ (settings, history, per-PC certificate). The folder can be moved between PCs.
Linux/macOS: install Node.js 22+ and run ./start.sh.
`;

(async () => {
  const nodeDir = await ensureNode();
  const stage = path.join(root, 'dist', `LocalSendPlus-Web-${arch}`);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });

  for (const d of ['src', 'web', 'assets']) {
    fs.cpSync(path.join(root, d), path.join(stage, d), { recursive: true, filter: (s) => !/[\\/](tray\.png|e2e\.js)$/.test(s) });
  }
  fs.mkdirSync(path.join(stage, 'node'));
  fs.copyFileSync(path.join(nodeDir, 'node.exe'), path.join(stage, 'node', 'node.exe'));
  fs.copyFileSync(path.join(nodeDir, 'NODE-LICENSE.txt'), path.join(stage, 'node', 'LICENSE.txt'));

  const slim = { name: 'localsendplus-web', version: pkg.version, private: true, license: pkg.license, dependencies: pkg.dependencies };
  fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(slim, null, 2));
  fs.copyFileSync(path.join(root, 'package-lock.json'), path.join(stage, 'package-lock.json'));
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: stage, stdio: 'inherit', shell: true });
  fs.rmSync(path.join(stage, 'package-lock.json'), { force: true });

  const cmd = (lines) => lines.join('\r\n') + '\r\n';
  fs.writeFileSync(path.join(stage, 'Start-LocalSendPlus-Web.cmd'), cmd(['@echo off', 'title LocalSendPlus Web', 'cd /d "%~dp0"', '"%~dp0node\\node.exe" "%~dp0web\\server.js" --open %*', 'pause']));
  fs.writeFileSync(path.join(stage, 'Start-LocalSendPlus-Web-LAN.cmd'), cmd(['@echo off', 'title LocalSendPlus Web (LAN / VPN)', 'cd /d "%~dp0"', '"%~dp0node\\node.exe" "%~dp0web\\server.js" --lan --https --open %*', 'pause']));
  fs.writeFileSync(path.join(stage, 'start.sh'), '#!/bin/sh\ncd "$(dirname "$0")"\nexec node web/server.js --open "$@"\n');
  fs.writeFileSync(path.join(stage, 'README-WEB.txt'), README.replace(/\n/g, '\r\n'));

  const releaseDir = path.join(root, 'release');
  fs.mkdirSync(releaseDir, { recursive: true });
  const zip = path.join(releaseDir, `localsendplus-web-${pkg.version}-win-${arch}.zip`);
  fs.rmSync(zip, { force: true });
  execFileSync('tar.exe', ['-a', '-c', '-f', zip, '-C', path.dirname(stage), path.basename(stage)], { stdio: 'inherit' });
  console.log('Folder:', stage);
  console.log('Zip:   ', zip);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});