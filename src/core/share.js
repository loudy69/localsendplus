'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { VERSION, API, normalizeDeviceType } = require('./protocol');
const { PinGuard, sendJson } = require('./util');

const MAX_PENDING = 5;
const SESSION_TTL_MS = 12 * 3600e3;

// Reverse transfer ("share via link") from LocalSend protocol section 5.
// A browser (or any HTTP client) asks for the file list with POST prepare-download and then pulls
// each file with GET download. Plain HTTP is used because browsers reject self-signed certificates.
class ShareManager extends EventEmitter {
  constructor({ getInfo, ask }) {
    super();
    this.getInfo = getInfo;
    this.ask = ask;
    this.http = null;
    this.port = null;
    this.entries = new Map();
    this.sessions = new Map();
    this.approved = new Set();
    this.pending = new Map();
    this.pinGuard = new PinGuard(() => this.pin);
    this.pin = '';
    this.autoAccept = false;
    this.expiresAt = null;
    this._timer = null;
    this.active = false;
  }

  async start({ entries, pin = '', autoAccept = false, expiresMinutes = 0, port = 53318 }) {
    await this.stop();
    if (!entries.length) throw new Error('Nothing to share');
    this.entries = new Map(entries.map((e) => [e.id, e]));
    this.pin = String(pin || '');
    this.autoAccept = !!autoAccept;
    this.sessions.clear();
    this.approved.clear();
    this.pinGuard = new PinGuard(() => this.pin);
    this.startedAt = Date.now();
    this.expiresAt = expiresMinutes > 0 ? Date.now() + expiresMinutes * 60_000 : null;
    this.downloads = 0;
    this.bytes = 0;

    const handler = (req, res) => {
      this.handle(req, res).then((handled) => {
        if (!handled && !res.headersSent) sendJson(res, 404, { message: 'Not found' });
      }).catch((err) => {
        if (res.headersSent) res.destroy();
        else sendJson(res, err.status || 500, { message: err.message || 'Unknown error by sender' });
      });
    };
    let lastErr;
    for (let p = port; p < port + 10; p++) {
      const srv = http.createServer(handler);
      srv.keepAliveTimeout = 15_000;
      srv.requestTimeout = 0;
      try {
        await new Promise((resolve, reject) => {
          srv.once('error', reject);
          srv.listen(p, '0.0.0.0', () => {
            srv.off('error', reject);
            resolve();
          });
        });
        this.http = srv;
        this.port = p;
        break;
      } catch (e) {
        lastErr = e;
        try { srv.close(); } catch { /* not listening */ }
        if (e.code !== 'EADDRINUSE') break;
      }
    }
    if (!this.http) throw lastErr || new Error('Could not start the share server');
    this.http.on('error', (e) => this.emit('error', e));
    this.active = true;
    if (this.expiresAt) {
      this._timer = setTimeout(() => this.stop(), this.expiresAt - Date.now());
      this._timer.unref?.();
    }
    this.emit('change');
  }

  async stop() {
    clearTimeout(this._timer);
    const was = this.active;
    this.active = false;
    for (const p of this.pending.values()) p.resolve(false);
    this.pending.clear();
    this.sessions.clear();
    this.approved.clear();
    const srv = this.http;
    this.http = null;
    this.port = null;
    if (srv) {
      srv.closeAllConnections?.();
      await new Promise((r) => srv.close(() => r()));
    }
    if (was) this.emit('change');
  }

  publicState() {
    return {
      active: this.active,
      port: this.port,
      pin: !!this.pin,
      autoAccept: this.autoAccept,
      expiresAt: this.expiresAt,
      startedAt: this.startedAt || null,
      downloads: this.downloads || 0,
      bytes: this.bytes || 0,
      files: [...this.entries.values()].map((e) => ({ id: e.id, name: e.fileName, size: e.size })),
      clients: [...this.approved],
    };
  }

  _info() {
    const { alias, deviceModel, deviceType, fingerprint } = this.getInfo();
    return { alias, version: VERSION, deviceModel, deviceType: normalizeDeviceType(deviceType), fingerprint, download: true };
  }

  _publicFiles() {
    const out = {};
    for (const e of this.entries.values()) {
      out[e.id] = { id: e.id, fileName: e.fileName, size: e.size, fileType: e.fileType, sha256: e.sha256 || null, preview: e.preview || null };
    }
    return out;
  }

  // Returns true when the request belonged to the download API or the browser page.
  async handle(req, res) {
    if (!this.active) return false;
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/i, '');
    if (req.method === 'GET' && p === '/') {
      this._page(res);
      return true;
    }
    if (req.method === 'POST' && p === `${API}/prepare-download`) {
      await this._prepare(req, res, url, ip);
      return true;
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && p === `${API}/download`) {
      this._download(req, res, url, ip);
      return true;
    }
    return false;
  }

  async _prepare(req, res, url, ip) {
    req.resume();
    const sid = url.searchParams.get('sessionId');
    const existing = sid && this.sessions.get(sid);
    if (existing && existing.ip === ip) {
      return sendJson(res, 200, { info: this._info(), sessionId: sid, files: this._publicFiles() });
    }
    const pin = this.pinGuard.check(ip, url.searchParams.get('pin'));
    if (!pin.ok) return sendJson(res, pin.status, { message: pin.status === 429 ? 'Too many requests' : 'PIN required / Invalid PIN' });

    let allowed = this.autoAccept || this.approved.has(ip);
    if (!allowed) {
      let pend = this.pending.get(ip);
      if (!pend) {
        if (this.pending.size >= MAX_PENDING) return sendJson(res, 429, { message: 'Too many requests' });
        pend = {};
        pend.promise = new Promise((resolve) => { pend.resolve = resolve; });
        this.pending.set(ip, pend);
        Promise.resolve(this.ask({ ip, userAgent: String(req.headers['user-agent'] || '').slice(0, 160) }))
          .catch(() => false)
          .then((ok) => { this.pending.delete(ip); pend.resolve(!!ok); });
      }
      let gone = false;
      res.on('close', () => { if (!res.writableEnded) gone = true; });
      allowed = await pend.promise;
      if (gone) return;
    }
    if (!this.active) return sendJson(res, 403, { message: 'Rejected' });
    if (!allowed) return sendJson(res, 403, { message: 'Rejected' });

    this.approved.add(ip);
    for (const [k, v] of this.sessions) if (Date.now() - v.at > SESSION_TTL_MS) this.sessions.delete(k);
    const sessionId = crypto.randomUUID();
    this.sessions.set(sessionId, { ip, at: Date.now() });
    this.emit('change');
    sendJson(res, 200, { info: this._info(), sessionId, files: this._publicFiles() });
  }

  _download(req, res, url, ip) {
    const q = url.searchParams;
    const sid = q.get('sessionId');
    const fileId = q.get('fileId');
    const sess = sid && this.sessions.get(sid);
    const entry = fileId && this.entries.get(fileId);
    if (!sess || !entry) return sendJson(res, 400, { message: 'Missing parameters' });
    if (sess.ip !== ip) return sendJson(res, 403, { message: 'Invalid token or IP address' });
    sess.at = Date.now();

    let size = entry.size;
    if (entry.path) {
      try { size = fs.statSync(entry.path).size; } catch { return sendJson(res, 500, { message: 'Unknown error by sender' }); }
    }
    let start = 0;
    let end = size - 1;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    let status = 200;
    if (range && (range[1] || range[2])) {
      if (range[1]) {
        start = Number(range[1]);
        if (range[2]) end = Math.min(end, Number(range[2]));
      } else {
        start = Math.max(0, size - Number(range[2]));
      }
      if (start > end || start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        return res.end();
      }
      status = 206;
    }
    const length = size ? end - start + 1 : 0;
    const base = path.basename(String(entry.fileName).replace(/\\/g, '/'));
    const headers = {
      'Content-Type': entry.fileType || 'application/octet-stream',
      'Content-Length': length,
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `attachment; filename="${base.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(base)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    };
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || !length) return res.end();

    let sent = 0;
    const src = entry.buffer ? null : fs.createReadStream(entry.path, { start, end });
    res.on('close', () => {
      this.bytes += sent;
      if (status === 200 && sent === length && length === entry.size) {
        this.downloads++;
        this.emit('file-done', { sessionId: sid, ip, entry });
      }
      this.emit('change');
      src?.destroy();
    });
    if (src) {
      src.on('data', (c) => { sent += c.length; });
      src.on('error', () => res.destroy());
      src.pipe(res);
    } else {
      sent = length;
      res.end(entry.buffer.subarray(start, end + 1));
    }
  }

  _page(res) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const body = PAGE.replace(/__NONCE__/g, nonce);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'`,
    });
    res.end(body);
  }
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>LocalSendPlus</title>
<style nonce="__NONCE__">
:root{color-scheme:light dark;--bg:#f4faf9;--fg:#14201f;--card:#fff;--line:#cfdedb;--pri:#0b6b63}
@media (prefers-color-scheme:dark){:root{--bg:#0e1514;--fg:#dbe8e6;--card:#162120;--line:#2a3a38;--pri:#4fd1c5}}
body{margin:0;font:16px/1.45 system-ui,Segoe UI,sans-serif;background:var(--bg);color:var(--fg)}
main{max-width:640px;margin:0 auto;padding:28px 18px}
h1{font-size:22px;margin:0 0 4px}p{margin:6px 0 16px;opacity:.8}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:6px 14px}
.f{display:flex;align-items:center;gap:12px;padding:12px 0;border-top:1px solid var(--line)}.f:first-child{border-top:0}
.f a{flex:1;color:var(--pri);word-break:break-all;text-decoration:none;font-weight:600}.f span{opacity:.7;font-size:14px;white-space:nowrap}
button,input{font:inherit;border-radius:999px;border:1px solid var(--line);padding:10px 18px;background:var(--card);color:var(--fg)}
button{background:var(--pri);color:#fff;border:0;cursor:pointer;font-weight:600}
@media (prefers-color-scheme:dark){button{color:#00201d}}
form{display:flex;gap:8px;margin:10px 0}input{flex:1;min-width:0}.err{color:#c0392b}[hidden]{display:none!important}
</style></head><body><main>
<h1 id="t">LocalSendPlus</h1><p id="s">Connecting…</p>
<form id="pin" hidden><input id="pv" type="password" inputmode="numeric" placeholder="PIN" autocomplete="off"><button>Unlock</button></form>
<div class="card" id="files" hidden></div>
<p><button id="all" hidden>Download all</button></p>
</main>
<script nonce="__NONCE__">
const API='/api/localsend/v2',$=i=>document.getElementById(i);
let sid=sessionStorage.getItem('lsp-sid')||'';
const fmt=n=>{const u=['B','KB','MB','GB','TB'];let i=0;while(n>=1024&&i<4){n/=1024;i++}return (i?n.toFixed(1):n)+' '+u[i]};
const say=(m,e)=>{$('s').textContent=m;$('s').className=e?'err':''};
async function load(pin){
  say('Waiting for the owner to approve this request…');
  const q=new URLSearchParams();if(pin)q.set('pin',pin);if(sid)q.set('sessionId',sid);
  let r;try{r=await fetch(API+'/prepare-download?'+q,{method:'POST'})}catch{return say('Could not reach the device.',1)}
  if(r.status===401){$('pin').hidden=false;$('pv').focus();return say(pin?'That PIN was not accepted.':'Enter the PIN to continue.',!!pin)}
  if(r.status===403)return say('The owner declined this request.',1);
  if(r.status===429)return say('Too many attempts. Try again in a few minutes.',1);
  if(!r.ok)return say('Something went wrong ('+r.status+').',1);
  const j=await r.json();sid=j.sessionId;sessionStorage.setItem('lsp-sid',sid);
  $('pin').hidden=true;$('t').textContent=j.info.alias+' shared files';
  const list=Object.values(j.files);say(list.length+(list.length===1?' file':' files')+' available');
  const box=$('files');box.textContent='';box.hidden=false;
  const link=f=>API+'/download?sessionId='+encodeURIComponent(sid)+'&fileId='+encodeURIComponent(f.id);
  for(const f of list){const row=document.createElement('div');row.className='f';
    const a=document.createElement('a');a.href=link(f);a.download=f.fileName.split(/[\\\\/]/).pop();a.textContent=f.fileName;
    const s=document.createElement('span');s.textContent=fmt(f.size);row.append(a,s);box.append(row)}
  $('all').hidden=list.length<2;
  $('all').onclick=()=>list.forEach((f,i)=>setTimeout(()=>{const a=document.createElement('a');a.href=link(f);a.download='';document.body.append(a);a.click();a.remove()},i*500));
}
$('pin').addEventListener('submit',e=>{e.preventDefault();load($('pv').value)});
load();
</script></body></html>`;

module.exports = { ShareManager };
