'use strict';
const fs = require('fs');
const path = require('path');

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function cleanSegment(seg) {
  let s = seg.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '');
  if (!s) s = '_';
  if (RESERVED.test(s)) s = '_' + s;
  return s.slice(0, 200);
}

// Turns a sender-provided file name (possibly "folder/sub/file.txt") into a safe
// relative path that cannot escape the destination directory.
function safeRelativePath(fileName) {
  const parts = String(fileName || 'file')
    .split(/[\\/]+/)
    .filter((p) => p && p !== '.' && p !== '..' && !/^[a-zA-Z]:$/.test(p));
  if (!parts.length) parts.push('file');
  return parts.map(cleanSegment);
}

function uniquePath(full) {
  if (!fs.existsSync(full) && !fs.existsSync(full + '.lsp-part')) return full;
  const { dir, name, ext } = path.parse(full);
  for (let i = 1; i < 10000; i++) {
    const candidate = path.join(dir, `${name} (${i})${ext}`);
    if (!fs.existsSync(candidate) && !fs.existsSync(candidate + '.lsp-part')) return candidate;
  }
  return path.join(dir, `${name}-${Date.now()}${ext}`);
}

function resolveInside(root, parts) {
  const full = path.resolve(root, ...parts);
  const base = path.resolve(root);
  if (full !== base && !full.startsWith(base + path.sep)) throw new Error('Path escapes destination');
  return full;
}

const MIME = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.html': 'text/html', '.css': 'text/css', '.csv': 'text/csv',
  '.json': 'application/json', '.xml': 'application/xml', '.js': 'text/javascript', '.pdf': 'application/pdf',
  '.zip': 'application/zip', '.gz': 'application/gzip', '.7z': 'application/x-7z-compressed', '.tar': 'application/x-tar',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.heic': 'image/heic', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.apk': 'application/vnd.android.package-archive', '.exe': 'application/vnd.microsoft.portable-executable',
};
function mimeOf(name) {
  return MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
}

function stripV6(ip) {
  return String(ip || '').replace(/^::ffff:/i, '');
}

function readJson(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function formatBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

// Brute-force protection for PIN-protected endpoints: three wrong PINs lock an address out for five minutes.
class PinGuard {
  constructor(getPin) {
    this.getPin = getPin;
    this.fails = new Map();
  }

  check(ip, given) {
    const pin = this.getPin();
    if (!pin) return { ok: true };
    const rec = this.fails.get(ip) || { n: 0, until: 0 };
    if (rec.until > Date.now()) return { ok: false, status: 429 };
    if (given === pin) {
      this.fails.delete(ip);
      return { ok: true };
    }
    if (given !== null && given !== undefined) {
      rec.n += 1;
      if (rec.n >= 3) {
        rec.until = Date.now() + 5 * 60_000;
        rec.n = 0;
      }
      this.fails.set(ip, rec);
    }
    return { ok: false, status: 401 };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { safeRelativePath, uniquePath, resolveInside, mimeOf, stripV6, readJson, sendJson, formatBytes, sleep, PinGuard };
