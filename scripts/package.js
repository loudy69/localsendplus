'use strict';
// Builds the portable (no install) desktop edition for Windows x64 (default) or arm64.
// Usage: node scripts/package.js [x64|arm64]   -> release/localsendplus-portable-<ver>-win-<arch>.zip
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const pkg = require('../package.json');

const PORTABLE_README = (arch) => `LocalSendPlus ${pkg.version} - portable (${arch}, no installation)
=====================================================

Run localsendplus.exe. Nothing is installed and nothing is written outside this folder:
  data\\       settings, history, certificate   (delete to reset)
  Received\\   default folder for received files (change it under Settings > Receive)

This device is shown to others by the name of the PC it runs on. The certificate (fingerprint) is kept
per PC name, so you can carry the folder on a USB stick or sync drive and use it on several PCs.

Devices on a VPN or another subnet: Networks > VPN & routed ranges (add the tunnel's address range, or use
"Detect"). Works with any VPN client (WireGuard, OpenVPN, Tailscale, ...) that is already connected.

First use on a PC: allow it through the firewall (Settings > Network > Windows Firewall, needs admin once) so
other devices can reach you on TCP/UDP 53317.

Command line: localsendplus-cli.cmd --help     (devices, send, receive, share)
Browser edition: see the separate LocalSendPlus-Web bundle.
`;

const arch = process.argv[2] === 'arm64' ? 'arm64' : 'x64';

(async () => {
  const root = path.join(__dirname, '..');
  // electron-builder produces the unpacked x64 app (it downloads/extracts Electron reliably on x64 and Arm64 hosts).
  execFileSync(process.execPath, [path.join(root, 'node_modules', 'electron-builder', 'cli.js'), '--win', 'dir', `--${arch}`, '--publish', 'never'], { cwd: root, stdio: 'inherit' });
  const out = path.join(root, 'dist-installer', arch === 'arm64' ? 'win-arm64-unpacked' : 'win-unpacked');
  fs.rmSync(path.join(out, 'localsendplus-cli.cmd'), { force: true });  fs.writeFileSync(path.join(out, 'portable.txt'), 'This file switches LocalSendPlus into portable mode: all data stays in the "data" folder next to the exe.\r\n');
  fs.writeFileSync(path.join(out, 'README-PORTABLE.txt'), PORTABLE_README(arch).replace(/\n/g, '\r\n'));
  fs.writeFileSync(path.join(out, 'localsendplus-cli.cmd'), [
    '@echo off',
    'rem LocalSendPlus command-line client (portable). Run "localsendplus-cli --help" for usage.',
    'setlocal',
    'set ELECTRON_RUN_AS_NODE=1',
    'if "%LOCALSENDPLUS_HOME%"=="" set "LOCALSENDPLUS_HOME=%~dp0data\\cli"',
    '"%~dp0LocalSendPlus.exe" "%~dp0resources\\app.asar\\bin\\localsendplus.js" %*',
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n'));

  const releaseDir = path.join(root, 'release');
  fs.mkdirSync(releaseDir, { recursive: true });
  const zip = path.join(releaseDir, `localsendplus-portable-${pkg.version}-win-${arch}.zip`);
  fs.rmSync(zip, { force: true });
  const staged = path.join(root, 'dist', `LocalSendPlus-Portable-${arch}`);
  fs.mkdirSync(path.dirname(staged), { recursive: true });
  fs.rmSync(staged, { recursive: true, force: true });
  fs.cpSync(out, staged, { recursive: true });
  execFileSync('tar.exe', ['-a', '-c', '-f', zip, '-C', path.dirname(staged), path.basename(staged)], { stdio: 'inherit' });
  console.log('Folder:', staged);
  console.log('Zip:   ', zip);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});