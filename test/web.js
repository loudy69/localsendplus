'use strict';
// End-to-end test for LocalSendPlus Web: real server process + a second in-process engine as the peer.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');
const { spawn } = require('child_process');
const { Engine } = require('../src/core/engine');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-web-'));
const WEB_PORT = 53391;
const ENGINE_PORT = 55021;
const PEER_PORT = 55022;
const TOKEN = 'test-token-123';
const ok = (m) => console.log('  ✔', m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (fn, ms = 10000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(100);
  }
  throw new Error('timeout waiting for condition');
};

function req(method, p, { body, headers = {}, host } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: WEB_PORT, path: p, method, headers: { ...(host ? { Host: host } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.end(body);
  });
}

(async () => {
  const peer = new Engine({
    dir: path.join(tmp, 'peer'),
    overrides: { alias: 'Peer', port: PEER_PORT, quickSave: 'on', destination: path.join(tmp, 'peer-recv'), discovery: { multicast: false, scanLocalSubnets: false, scanRemote: false } },
  });
  await peer.start();

  const dataDir = path.join(tmp, 'web-data');
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'web', 'server.js'), '--port', String(WEB_PORT), '--data', dataDir, '--token', TOKEN, '--engine-port', String(ENGINE_PORT), '--no-multicast', '--quick-save'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  srv.stdout.on('data', (d) => (log += d));
  srv.stderr.on('data', (d) => (log += d));
  const done = (code) => { srv.kill(); peer.stop().catch(() => {}); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(code); };
  process.on('unhandledRejection', (e) => { console.error(e, '\n', log); done(1); });

  try {
    await wait(() => /Open the UI at/.test(log));
    ok(`server up; this PC is advertised as "${/this PC is "([^"]+)"/.exec(log)[1]}"`);
    assert.strictEqual(/this PC is "([^"]+)"/.exec(log)[1], os.hostname().trim().slice(0, 40));

    // --- auth
    let r = await req('GET', '/');
    assert.ok(r.status === 200 && /Access token/.test(r.body.toString()), 'login page without cookie');
    r = await req('POST', '/api/getState', { headers: { 'X-LSP': '1' }, body: '{}' });
    assert.strictEqual(r.status, 401);
    r = await req('GET', '/?token=wrong');
    assert.strictEqual(r.status, 401);
    r = await req('GET', `/?token=${TOKEN}`);
    assert.strictEqual(r.status, 303);
    const cookie = r.headers['set-cookie'][0].split(';')[0];
    assert.ok(/HttpOnly/.test(r.headers['set-cookie'][0]) && /SameSite=Strict/.test(r.headers['set-cookie'][0]));
    ok('token required; cookie is HttpOnly + SameSite=Strict');

    const H = { Cookie: cookie, 'X-LSP': '1', 'Content-Type': 'application/json' };
    const api = async (name, ...args) => {
      const x = await req('POST', '/api/' + name, { headers: H, body: JSON.stringify({ args }) });
      const j = JSON.parse(x.body.toString());
      if (j.error) throw new Error(j.error);
      return j.result;
    };

    // --- request hardening
    r = await req('POST', '/api/getState', { headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
    assert.strictEqual(r.status, 403, 'missing X-LSP header');
    r = await req('POST', '/api/getState', { headers: { ...H, Origin: 'http://evil.example' }, body: '{}' });
    assert.strictEqual(r.status, 403, 'cross-origin');
    r = await req('GET', '/', { headers: { Cookie: cookie }, host: 'evil.example' });
    assert.strictEqual(r.status, 421, 'DNS rebinding Host');
    ok('CSRF header, Origin and Host checks enforced');

    // --- UI assets
    r = await req('GET', '/', { headers: { Cookie: cookie } });
    const html = r.body.toString();
    assert.ok(html.includes('/sa-web.js'));
    for (const f of ['/core.js', '/styles.css', '/sa-web.js']) assert.strictEqual((await req('GET', f, { headers: { Cookie: cookie } })).status, 200, f);
    assert.strictEqual((await req('GET', '/..%2f..%2fpackage.json', { headers: { Cookie: cookie } })).status, 404);
    ok('renderer served with web bridge injected; traversal blocked');

    const st = await api('getState');
    assert.ok(st.app.web && st.info.alias === os.hostname().trim().slice(0, 40));
    assert.strictEqual(st.settings.port, ENGINE_PORT);

    // --- connect to the peer by address, upload a file + folder, send, verify
    const added = await api('addHost', '127.0.0.1', PEER_PORT);
    assert.ok(added.ok, added.error);
    const dev = added.device;
    ok('peer reached by address; handshake registered');

    const up = (rel, content, batch) => req('POST', `/api/upload?batch=${batch}&rel=${encodeURIComponent(rel)}`, { headers: { Cookie: cookie, 'X-LSP': '1' }, body: content }).then((x) => JSON.parse(x.body.toString()));
    const f1 = await up('hello.txt', 'hello from the browser', 'b1');
    assert.ok(f1.ok && f1.size === 22);
    const bad = await up('../../evil.txt', 'x', 'b2');
    assert.ok(bad.error, 'traversal upload rejected');
    const f2 = await up('Trip/a.txt', 'AAA', 'b3');
    await up('Trip/sub/b.bin', Buffer.alloc(5000, 7), 'b3');
    const [fileItem] = await api('describePaths', [f1.path]);
    const [folderItem] = await api('describePaths', [f2.top]);
    assert.ok(fileItem.kind === 'file' && folderItem.kind === 'folder' && folderItem.count === 2);
    assert.deepStrictEqual(await api('describePaths', [path.join(__dirname, '..', 'package.json')]), [], 'cannot describe host files outside staging');
    await assert.rejects(() => api('send', [dev.id], [{ kind: 'file', path: path.join(__dirname, '..', 'package.json') }]), /not part of this session/);
    ok('uploads staged safely; arbitrary host paths refused');

    await api('send', [dev.id], [fileItem, folderItem, { id: 't1', kind: 'text', text: 'ping' }].slice(0, 2));
    await wait(() => fs.existsSync(path.join(tmp, 'peer-recv', 'hello.txt')) && fs.existsSync(path.join(tmp, 'peer-recv', 'Trip', 'sub', 'b.bin')));
    assert.strictEqual(fs.readFileSync(path.join(tmp, 'peer-recv', 'hello.txt'), 'utf8'), 'hello from the browser');
    ok('file + folder sent from the host PC to the peer');

    // --- receive: peer sends to the web host (quick save), then download through /dl
    await api('updateSettings', { destination: path.join(tmp, 'web-recv') });
    const hostDev = await wait(async () => { try { return await peer.addHost('127.0.0.1', ENGINE_PORT); } catch { return null; } });
    fs.writeFileSync(path.join(tmp, 'reply.txt'), 'reply body');
    await peer.send(hostDev.id, [{ id: 'r1', kind: 'file', path: path.join(tmp, 'reply.txt'), name: 'reply.txt', size: 10 }]);
    const hist = await wait(async () => {
      const s = await api('getState');
      return s.history.find((e) => e.direction === 'receive' && e.status === 'finished');
    });
    const rp = hist.files[0].path;
    r = await req('GET', '/dl?p=' + encodeURIComponent(rp), { headers: { Cookie: cookie } });
    assert.ok(r.status === 200 && r.body.toString() === 'reply body');
    r = await req('GET', '/dl?p=' + encodeURIComponent(path.join(__dirname, '..', 'package.json')), { headers: { Cookie: cookie } });
    assert.strictEqual(r.status, 403);
    ok('received file downloadable; other host files are not');

    // --- events + settings validation
    const ev = await new Promise((resolve) => {
      const sse = http.request({ host: '127.0.0.1', port: WEB_PORT, path: '/api/events', headers: { Cookie: cookie } }, (res) => {
        res.setEncoding('utf8');
        res.on('data', (d) => { if (d.includes('"type"')) { resolve(d); sse.destroy(); } });
      });
      sse.end();
      api('updateSettings', { theme: 'dark' });
    });
    assert.ok(ev.includes('settings'));
    await assert.rejects(() => api('updateSettings', { destination: 'relative\\path' }), /full folder path/);
    ok('live events stream; destination must be an absolute path');

    console.log('\nAll web checks passed.');
    done(0);
  } catch (e) {
    console.error('FAILED:', e.stack || e, '\n--- server log ---\n', log);
    done(1);
  }
})();
