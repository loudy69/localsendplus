#!/usr/bin/env node
'use strict';
// LocalSendPlus Web - the full LocalSendPlus engine behind a browser UI. Nothing to install: run it (the Windows
// bundle ships its own Node.js) and open the printed address. The PC running it is the endpoint other devices see
// (it takes the PC name), and the browser - local, over the LAN or over a VPN - is its remote control.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { Engine } = require('../src/core/engine');
const { folderInfo } = require('../src/core/sender');
const firewall = require('../src/core/firewall');
const { randomAlias } = require('../src/core/store');
const pkg = require('../package.json');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const HELP = `LocalSendPlus Web ${pkg.version}

Usage: node web/server.js [options]

  --port <n>        port of the web UI (default 53320)
  --host <addr>     address to listen on (default 127.0.0.1 = this PC only)
  --lan             listen on every network adapter (includes VPN adapters)
  --https           serve the UI over HTTPS with this device's self-signed certificate
  --open            open the UI in the default browser
  --data <folder>   where settings, identity, and history live (default ./data beside this bundle)
  --token <value>   access token to use (default: generated once, kept in <data>/web-token.txt)
  --new-token       generate a new access token
  --no-auth         no access token (only allowed on 127.0.0.1)
  --allow-host <h>  extra Host header name to accept (reverse proxy / DNS name), repeatable
  --quick-save      accept incoming transfers without asking (use for unattended hosts; saved in settings)
  --engine-port <n> LocalSend protocol port (default 53317; use another if LocalSend is running on this PC; saved)
  --no-multicast    do not announce / listen on multicast (VPN and saved ranges still work; saved)
  -h, --help        show this help`;

function parseArgs(argv) {
  const o = { allowHost: [] };
  const flags = new Set(['lan', 'https', 'open', 'new-token', 'no-auth', 'quick-save', 'no-multicast', 'help']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') o.help = true;
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const k = eq > 0 ? a.slice(2, eq) : a.slice(2);
      const v = flags.has(k) ? true : eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (k === 'allow-host') o.allowHost.push(String(v).toLowerCase());
      else o[k] = v;
    }
  }
  return o;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function isLoopback(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return console.log(HELP);

  const dataDir = path.resolve(opts.data || path.join(ROOT, 'data'));
  fs.mkdirSync(dataDir, { recursive: true });
  const stagingRoot = path.join(dataDir, 'staging');
  fs.rmSync(stagingRoot, { recursive: true, force: true });
  fs.mkdirSync(stagingRoot, { recursive: true });

  const bindHost = opts.lan ? '0.0.0.0' : opts.host || '127.0.0.1';
  const port = Number(opts.port) || 53320;
  const useHttps = !!opts.https;
  if (opts['no-auth'] && !isLoopback(bindHost)) {
    console.error('--no-auth is only allowed when listening on 127.0.0.1.');
    process.exit(2);
  }

  // ---- access token
  const tokenFile = path.join(dataDir, 'web-token.txt');
  let token = typeof opts.token === 'string' ? opts.token : '';
  if (!token && !opts['new-token']) {
    try { token = fs.readFileSync(tokenFile, 'utf8').trim(); } catch { /* generate below */ }
  }
  if (!token) token = crypto.randomBytes(18).toString('base64url');
  if (!opts['no-auth']) fs.writeFileSync(tokenFile, token, { mode: 0o600 });

  // ---- engine (the PC name is the device name; the certificate is kept per host name)
  const firstRun = !fs.existsSync(path.join(dataDir, 'settings.json'));
  const overrides = {};
  if (firstRun) overrides.destination = path.join(ROOT, 'Received');
  if (opts['quick-save']) overrides.quickSave = 'on';
  if (opts['engine-port']) overrides.port = Number(opts['engine-port']);
  if (opts['no-multicast']) overrides.discovery = { multicast: false };
  const engine = new Engine({ dir: dataDir, identityKey: os.hostname(), overrides });
  if (firstRun) engine.store.patch({ firstRun: false });

  // ---- sessions
  const sessions = new Map();
  const newSession = () => {
    const id = crypto.randomBytes(24).toString('base64url');
    sessions.set(id, Date.now() + 30 * 24 * 3600e3);
    return id;
  };
  const sessionOk = (id) => {
    const exp = sessions.get(id);
    if (!exp) return false;
    if (exp < Date.now()) { sessions.delete(id); return false; }
    return true;
  };
  const tokenOk = (t) => {
    const a = crypto.createHash('sha256').update(String(t || '')).digest();
    const b = crypto.createHash('sha256').update(token).digest();
    return crypto.timingSafeEqual(a, b);
  };
  const fails = new Map();
  const throttled = (ip) => (fails.get(ip) || []).filter((t) => Date.now() - t < 60_000).length >= 8;
  const noteFail = (ip) => fails.set(ip, [...(fails.get(ip) || []).filter((t) => Date.now() - t < 60_000), Date.now()]);

  const allowedHosts = new Set(['localhost', os.hostname().toLowerCase(), ...opts.allowHost]);
  const hostOk = (hostHeader) => {
    const h = String(hostHeader || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    if (!h) return false;
    if (allowedHosts.has(h)) return true;
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':');
  };

  const cookieName = 'lsp_web';
  const cookieOf = (req) => {
    const m = new RegExp(`(?:^|;\\s*)${cookieName}=([^;]+)`).exec(req.headers.cookie || '');
    return m ? m[1] : '';
  };
  const setCookie = (res, id) => res.setHeader('Set-Cookie', `${cookieName}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${30 * 24 * 3600}${useHttps ? '; Secure' : ''}`);

  // ---- helpers
  const insideStaging = (p) => {
    const rp = path.resolve(String(p || ''));
    return rp.toLowerCase().startsWith((stagingRoot + path.sep).toLowerCase());
  };
  async function describe(p) {
    if (!insideStaging(p)) throw new Error('That file is not part of this session.');
    const st = await fs.promises.stat(p);
    if (st.isDirectory()) {
      const info = await folderInfo(p);
      return { id: crypto.randomUUID(), kind: 'folder', path: p, name: path.basename(p), count: info.count, size: info.size };
    }
    return { id: crypto.randomUUID(), kind: 'file', path: p, name: path.basename(p), size: st.size };
  }
  async function cleanItems(items) {
    const out = [];
    for (const it of items || []) {
      if (it.kind === 'text') out.push({ id: it.id, kind: 'text', text: String(it.text || '') });
      else {
        const d = await describe(it.path);
        out.push({ ...d, id: it.id || d.id, kind: it.kind === 'image' ? 'image' : d.kind });
      }
    }
    return out;
  }
  function safeRel(rel) {
    const parts = String(rel || '').split(/[\\/]+/).filter(Boolean);
    if (!parts.length || parts.length > 40) throw new Error('Invalid file name.');
    for (const p of parts) {
      if (p === '.' || p === '..' || /[<>:"|?*\u0000-\u001f]/.test(p) || WINDOWS_RESERVED.test(p) || p.length > 200) throw new Error('Invalid file name.');
    }
    return parts;
  }
  async function validDestination(p) {
    const d = String(p || '').trim();
    if (!d || !path.isAbsolute(d)) throw new Error('Enter a full folder path on the host PC, e.g. C:\\Inbox');
    await fs.promises.mkdir(d, { recursive: true });
    return path.resolve(d);
  }
  const receivedPaths = () => {
    const set = new Set();
    for (const e of engine.history) for (const f of e.files || []) if (f.path) set.add(path.resolve(f.path).toLowerCase());
    return set;
  };
  function downloadAllowed(p) {
    const rp = path.resolve(p).toLowerCase();
    if (receivedPaths().has(rp)) return true;
    const dest = path.resolve(engine.store.get('destination')).toLowerCase();
    return rp.startsWith(dest + path.sep);
  }

  // ---- API (same surface the desktop app exposes over IPC)
  const api = {
    getState: () => ({ ...engine.getState(), app: { version: pkg.version, platform: process.platform, demo: false, machineName: os.hostname(), canAutoStart: false, web: true } }),
    describePaths: async (paths) => (await Promise.all((paths || []).map((p) => describe(p).catch(() => null)))).filter(Boolean),
    saveImageData: async (dataUrl, name) => {
      const m = /^data:image\/(\w+);base64,(.+)$/.exec(dataUrl || '');
      if (!m) return null;
      const dir = path.join(stagingRoot, crypto.randomUUID());
      await fs.promises.mkdir(dir);
      const fname = (name || `pasted-${Date.now()}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`).replace(/[\\/:*?"<>|]/g, '_');
      const p = path.join(dir, fname);
      await fs.promises.writeFile(p, Buffer.from(m[2], 'base64'));
      return { ...(await describe(p)), kind: 'image' };
    },
    send: async (deviceIds, items, pin) => {
      const clean = await cleanItems(items);
      const ids = [];
      for (const d of [].concat(deviceIds)) ids.push(await engine.send(d, clean, { pin }));
      return ids;
    },
    retrySend: (id, pin) => engine.retrySend(id, pin),
    shareStart: async (items, o) => {
      try {
        return { ok: true, share: await engine.startShare(await cleanItems(items), o || {}) };
      } catch (e) {
        return { ok: false, error: e.code === 'EADDRINUSE' ? 'No free port for the share link - change the share port in Settings > Network.' : e.message };
      }
    },
    shareStop: () => engine.stopShare(),
    respondShare: (id, accept) => engine.respondShare(id, accept),
    qr: (text) => require('qrcode').toString(String(text), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }),
    cancelTransfer: (id) => engine.cancelTransfer(id),
    respondReceive: async (id, o) => {
      const r = { ...(o || {}) };
      if (r.destination) r.destination = await validDestination(r.destination);
      return engine.respondReceive(id, r);
    },
    validateDestination: (p) => validDestination(p),
    scanNow: (o) => engine.scanNow(o || {}).catch(() => 0),
    cancelScan: () => engine.cancelScan(),
    addHost: async (host, p) => {
      try {
        return { ok: true, device: await engine.addHost(host, p) };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
    removeHost: (id) => engine.store.patch({ hosts: engine.store.get('hosts').filter((x) => x.id !== id) }),
    toggleFavorite: (id) => engine.toggleFavorite(id),
    suggestNetworks: () => engine.suggestNetworks(),
    updateSettings: async (patch) => {
      patch = { ...patch };
      if (patch.destination !== undefined) patch.destination = await validDestination(patch.destination);
      delete patch.launchAtLogin;
      await engine.updateSettings(patch);
      return engine.publicSettings();
    },
    deleteHistory: (id) => engine.deleteHistory(id),
    randomAlias: () => randomAlias(),
    firewallStatus: () => firewall.status(engine.store.get('port')),
    enableFirewall: () => firewall.enable(engine.store.get('port')),
  };

  // ---- Server-sent events
  const clients = new Set();
  const emit = (type, data) => {
    const line = `data: ${JSON.stringify({ type, data })}\n\n`;
    for (const res of clients) res.write(line);
  };
  for (const ev of ['devices', 'transfer', 'scan', 'history', 'interfaces', 'settings', 'server-status', 'share', 'share-request-cancel', 'receive-request', 'share-request', 'receive-request-cancel']) engine.on(ev, (d) => emit(ev, d));
  engine.on('message-received', ({ text, peer }) => emit('message-received', { text, peer, copied: false }));
  engine.on('error', (e) => emit('error', { message: e.message, code: e.code }));
  const beat = setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 20_000);

  // ---- static files
  const loginPage = (msg) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LocalSendPlus</title>
<style>body{font:16px system-ui,sans-serif;background:#0e1514;color:#dfe4e2;display:grid;place-items:center;min-height:100vh;margin:0}form{background:#18211f;padding:28px;border-radius:18px;width:min(380px,90vw)}h1{font-size:20px;margin:0 0 6px}p{color:#9fb0ab;margin:0 0 16px;font-size:14px}input{width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid #3a4a46;background:#0e1514;color:inherit;font:inherit}button{margin-top:14px;width:100%;padding:12px;border:0;border-radius:999px;background:#3fb8a8;color:#00201c;font:600 15px system-ui;cursor:pointer}.e{color:#ffb4ab;margin-top:10px;font-size:14px}</style></head>
<body><form method="post" action="/login"><h1>LocalSendPlus on ${os.hostname().replace(/[<>&"]/g, '')}</h1><p>Enter the access token shown when the server started (or kept in <code>data/web-token.txt</code>).</p><input name="token" type="password" autocomplete="off" autofocus placeholder="Access token"><button>Open</button>${msg ? `<div class="e">${msg}</div>` : ''}</form></body></html>`;

  let indexHtml = null;
  function getIndex() {
    if (indexHtml) return indexHtml;
    let html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
    html = html.replace("img-src 'self' data:", "img-src 'self' data: blob:")
      .replace('<script src="icons.js"></script>', '<script src="/sa-web.js"></script>\n  <script src="icons.js"></script>');
    indexHtml = html;
    return html;
  }

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...headers });
    res.end(body);
  }
  const json = (res, status, obj) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json' });

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let n = 0;
      req.on('data', (c) => {
        n += c.length;
        if (n > limit) { reject(new Error('Request too large')); req.destroy(); } else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async function handle(req, res) {
    const ip = req.socket.remoteAddress || '';
    if (!hostOk(req.headers.host)) return send(res, 421, 'Unrecognised Host header. Start the server with --allow-host <name> to use this name.');
    const url = new URL(req.url, 'http://x');
    const authed = opts['no-auth'] || sessionOk(cookieOf(req));

    if (req.method === 'POST' && url.pathname === '/login') {
      if (throttled(ip)) return send(res, 429, loginPage('Too many attempts - wait a minute.'), { 'Content-Type': 'text/html; charset=utf-8' });
      const form = new URLSearchParams(await readBody(req, 4096));
      if (tokenOk(form.get('token'))) {
        setCookie(res, newSession());
        return send(res, 303, '', { Location: '/' });
      }
      noteFail(ip);
      return send(res, 401, loginPage('That token is not right.'), { 'Content-Type': 'text/html; charset=utf-8' });
    }
    if (req.method === 'GET' && url.pathname === '/' && url.searchParams.has('token')) {
      if (throttled(ip)) return send(res, 429, 'Too many attempts');
      if (tokenOk(url.searchParams.get('token'))) {
        setCookie(res, newSession());
        return send(res, 303, '', { Location: '/' });
      }
      noteFail(ip);
      return send(res, 401, loginPage('That token is not right.'), { 'Content-Type': 'text/html; charset=utf-8' });
    }
    if (!authed) {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return send(res, 200, loginPage(''), { 'Content-Type': 'text/html; charset=utf-8' });
      return json(res, 401, { error: 'Not signed in' });
    }

    if (req.method === 'POST' || url.pathname.startsWith('/api/')) {
      // Cookies are SameSite=Strict; this header and the Origin check close the remaining cross-site paths.
      if (req.method === 'POST' && req.headers['x-lsp'] !== '1') return json(res, 403, { error: 'Missing header' });
      const origin = req.headers.origin;
      if (origin && new URL(origin).host.toLowerCase() !== String(req.headers.host).toLowerCase()) return json(res, 403, { error: 'Cross-origin request blocked' });
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(': hello\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/upload') {
      try {
        const batch = (url.searchParams.get('batch') || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64) || crypto.randomUUID();
        const parts = safeRel(url.searchParams.get('rel'));
        const batchDir = path.join(stagingRoot, batch);
        const target = path.join(batchDir, ...parts);
        if (!insideStaging(target)) throw new Error('Invalid file name.');
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await new Promise((resolve, reject) => {
          const out = fs.createWriteStream(target);
          req.pipe(out);
          out.on('finish', resolve);
          out.on('error', reject);
          req.on('error', reject);
          req.on('aborted', () => { out.destroy(); reject(new Error('Upload cancelled')); });
        });
        const st = await fs.promises.stat(target);
        return json(res, 200, { ok: true, batch, path: target, size: st.size, top: path.join(batchDir, parts[0]), name: parts[parts.length - 1], isNested: parts.length > 1 });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      const name = url.pathname.slice(5);
      if (!Object.prototype.hasOwnProperty.call(api, name)) return json(res, 404, { error: 'Unknown call' });
      try {
        const body = JSON.parse((await readBody(req, 80 * 1024 * 1024)) || '{}');
        const result = await api[name](...(Array.isArray(body.args) ? body.args : []));
        return json(res, 200, { result: result === undefined ? null : result });
      } catch (e) {
        return json(res, 200, { error: e.message || String(e) });
      }
    }

    if (req.method === 'GET' && url.pathname === '/dl') {
      const p = url.searchParams.get('p') || '';
      try {
        if (!downloadAllowed(p)) return send(res, 403, 'Not a received file');
        const st = await fs.promises.stat(p);
        if (!st.isFile()) return send(res, 404, 'Not found');
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(p))}`, 'X-Content-Type-Options': 'nosniff' });
        return fs.createReadStream(p).pipe(res);
      } catch {
        return send(res, 404, 'Not found');
      }
    }

    if (req.method === 'GET') {
      if (url.pathname === '/' || url.pathname === '/index.html') return send(res, 200, getIndex(), { 'Content-Type': MIME['.html'] });
      if (url.pathname === '/sa-web.js') return send(res, 200, fs.readFileSync(path.join(__dirname, 'sa-web.js')), { 'Content-Type': MIME['.js'] });
      if (url.pathname === '/favicon.ico') return send(res, 200, fs.readFileSync(path.join(ROOT, 'assets', 'icon.png')), { 'Content-Type': 'image/png' });
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const file = path.resolve(RENDERER, rel);
      if (file.startsWith(RENDERER + path.sep) && MIME[path.extname(file)] && fs.existsSync(file)) return send(res, 200, fs.readFileSync(file), { 'Content-Type': MIME[path.extname(file)] });
    }
    return send(res, 404, 'Not found');
  }

  const onReq = (req, res) => handle(req, res).catch((e) => { try { json(res, 500, { error: e.message }); } catch { /* socket gone */ } });
  const server = useHttps ? https.createServer({ key: engine.identity.key, cert: engine.identity.cert }, onReq) : http.createServer(onReq);
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bindHost, resolve);
  }).catch((e) => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${port} is already in use - choose another with --port.` : e.message);
    process.exit(1);
  });

  await engine.start();

  const scheme = useHttps ? 'https' : 'http';
  const query = opts['no-auth'] ? '' : `/?token=${token}`;
  const addrs = bindHost === '0.0.0.0'
    ? ['localhost', ...Object.values(os.networkInterfaces()).flat().filter((i) => i.family === 'IPv4' && !i.internal).map((i) => i.address)]
    : [bindHost];
  console.log(`LocalSendPlus Web ${pkg.version} - this PC is "${engine.getInfo().alias}" (fingerprint ${engine.identity.fingerprint.slice(0, 12)}...)`);
  console.log(`Receiving on port ${engine.store.get('port')}; files are saved to ${engine.store.get('destination')}`);
  console.log('Open the UI at:');
  addrs.forEach((a) => console.log(`  ${scheme}://${a}:${port}${query}`));
  if (opts['no-auth']) console.log('(no access token - loopback only)');
  if (useHttps) console.log('The certificate is self-signed: accept the browser warning once.');
  else if (!isLoopback(bindHost)) console.log('Note: plain HTTP. Use it only inside a trusted network or a VPN, or add --https.');
  if (opts.open) {
    const target = `${scheme}://${isLoopback(bindHost) || bindHost === '0.0.0.0' ? 'localhost' : bindHost}:${port}${query}`;
    if (process.platform === 'win32') execFile('rundll32', ['url.dll,FileProtocolHandler', target]);
    else execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [target]);
  }

  const cleanup = setInterval(() => {
    for (const d of fs.readdirSync(stagingRoot)) {
      const p = path.join(stagingRoot, d);
      try { if (Date.now() - fs.statSync(p).mtimeMs > 24 * 3600e3) fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }, 3600e3);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(beat);
    clearInterval(cleanup);
    for (const res of clients) res.end();
    server.close();
    await engine.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
