'use strict';
const { execFile } = require('child_process');

const RULE = 'LocalSendPlus';

function status(port) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({ supported: false });
    execFile('netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${RULE}`], { windowsHide: true }, (err, out) => {
      resolve({ supported: true, enabled: !err && /Enabled:\s+Yes/i.test(out || ''), port });
    });
  });
}

// Adds inbound TCP+UDP rules for the protocol port; Windows shows a UAC prompt on the host PC.
function enable(port) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({ ok: false });
    const p = Number(port) | 0;
    const script = [
      `netsh advfirewall firewall delete rule name='${RULE}' | Out-Null`,
      `netsh advfirewall firewall add rule name='${RULE}' dir=in action=allow protocol=TCP localport=${p} profile=any | Out-Null`,
      `netsh advfirewall firewall add rule name='${RULE}' dir=in action=allow protocol=UDP localport=${p} profile=any | Out-Null`,
    ].join('; ');
    const enc = Buffer.from(script, 'utf16le').toString('base64');
    execFile('powershell.exe', ['-NoProfile', '-Command', `Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','${enc}'`], { windowsHide: true }, (err) => resolve({ ok: !err }));
  });
}

module.exports = { status, enable };
