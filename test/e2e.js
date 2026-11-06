'use strict';
// Headless end-to-end test: two LocalSendPlus engines talking over loopback.
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const assert = require('assert');
const { Engine } = require('../src/core/engine');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-test-'));
const mk = (name, port) => {
  const dest = path.join(tmp, name, 'received');
  return new Engine({
    dir: path.join(tmp, name, 'cfg'),
    overrides: {
      alias: name, port, destination: dest, quickSave: 'on',
      discovery: { multicast: false, scanLocalSubnets: false, scanRemote: true, scanPorts: [55001, 55002], concurrency: 16, timeoutMs: 400 },
    },
  });
};
const wait = async (fn, ms = 8000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timeout waiting for condition');
};
const ok = (m) => console.log('  ✔', m);

(async () => {
  // 0b. per-host identity
  {
    const { loadIdentity } = require('../src/core/identity');
    const idDir = path.join(tmp, 'ident');
    fs.mkdirSync(idDir, { recursive: true });
    const a = loadIdentity(idDir, 'PC-A');
    const b = loadIdentity(idDir, 'PC-B');
    assert.notStrictEqual(a.fingerprint, b.fingerprint);
    assert.strictEqual(loadIdentity(idDir, 'pc-a').fingerprint, a.fingerprint);
    ok('certificate identity is kept per host name');
  }
  // 0. device name follows the computer name unless the user chose their own
  {
    const { Store, machineName } = require('../src/core/store');
    const host = os.hostname().trim().slice(0, 40);
    assert.strictEqual(machineName(), host);
    const d1 = path.join(tmp, 'name1');
    assert.strictEqual(new Store(d1).get('alias'), host);
    fs.writeFileSync(path.join(d1, 'settings.json'), JSON.stringify({ alias: 'Nice Orange' }));
    assert.strictEqual(new Store(d1).get('alias'), host);
    const d2 = path.join(tmp, 'name2');
    fs.mkdirSync(d2, { recursive: true });
    fs.writeFileSync(path.join(d2, 'settings.json'), JSON.stringify({ alias: "Mark's Laptop" }));
    assert.strictEqual(new Store(d2).get('alias'), "Mark's Laptop");
    const eng = new Engine({ dir: path.join(tmp, 'name3'), overrides: { discovery: { multicast: false, scanLocalSubnets: false, scanRemote: false } } });
    await eng.updateSettings({ alias: 'Desk PC' });
    assert.ok(eng.store.get('aliasCustom') && eng.getInfo().alias === 'Desk PC');
    eng.store.flush();
    assert.strictEqual(new Store(path.join(tmp, 'name3')).get('alias'), 'Desk PC');
    await eng.updateSettings({ alias: '  ' });
    assert.ok(!eng.store.get('aliasCustom') && eng.getInfo().alias === host);
    ok(`device name defaults to the computer name (${host}); legacy random names migrate; custom names are kept`);
  }

  const A = mk('Alice', 55001);
  const B = mk('Bob', 55002);
  await A.server.start();
  await B.server.start();
  const destA = A.store.get('destination');

  // 1. manual add + mutual discovery
  const dev = await B.addHost('127.0.0.1', 55001);
  assert.strictEqual(dev.alias, 'Alice');
  await wait(() => A.deviceList().some((d) => d.alias === 'Bob'));
  ok('manual add registers both sides (two-way handshake)');

  // 2. send text, file, folder
  const src = path.join(tmp, 'src');
  fs.mkdirSync(path.join(src, 'proj', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(src, 'hello.txt'), 'hello world');
  fs.writeFileSync(path.join(src, 'proj', 'a.txt'), 'A');
  fs.writeFileSync(path.join(src, 'proj', 'sub', 'b.bin'), crypto32());
  fs.writeFileSync(path.join(src, 'proj', 'empty.txt'), '');
  function crypto32() { return require('crypto').randomBytes(3 * 1024 * 1024); }

  let msgText = null;
  A.on('message-received', (m) => (msgText = m.text));
  let id = await B.send(dev.id, [{ kind: 'text', text: 'Paste me ✨ across the VPN' }]);
  await wait(() => B.transfers.get(id).status === 'finished');
  await wait(() => msgText);
  assert.strictEqual(msgText, 'Paste me ✨ across the VPN');
  ok('text / paste message delivered');

  id = await B.send(dev.id, [{ kind: 'file', path: path.join(src, 'hello.txt'), name: 'hello.txt' }, { kind: 'folder', path: path.join(src, 'proj'), name: 'proj' }]);
  await wait(() => B.transfers.get(id).status === 'finished');
  assert.strictEqual(fs.readFileSync(path.join(destA, 'hello.txt'), 'utf8'), 'hello world');
  assert.strictEqual(fs.readFileSync(path.join(destA, 'proj', 'a.txt'), 'utf8'), 'A');
  assert.ok(fs.readFileSync(path.join(destA, 'proj', 'sub', 'b.bin')).equals(fs.readFileSync(path.join(src, 'proj', 'sub', 'b.bin'))));
  assert.ok(fs.existsSync(path.join(destA, 'proj', 'empty.txt')));
  ok('file + folder (nested, binary, empty file) transferred intact');

  // duplicate names get uniquified
  id = await B.send(dev.id, [{ kind: 'file', path: path.join(src, 'hello.txt'), name: 'hello.txt' }]);
  await wait(() => B.transfers.get(id).status === 'finished');
  assert.ok(fs.existsSync(path.join(destA, 'hello (1).txt')));
  ok('name collisions are de-duplicated');
  assert.ok(A.history.length >= 3 && B.history.length >= 3);
  ok('history recorded on both ends');

  // 3. PIN
  await A.updateSettings({ pin: '1234' });
  id = await B.send(dev.id, [{ kind: 'text', text: 'pin test' }]);
  await wait(() => B.transfers.get(id).status === 'pin-required');
  await B.retrySend(id, '0000');
  await wait(() => B.transfers.get(id).status === 'pin-required');
  await B.retrySend(id, '1234');
  await wait(() => B.transfers.get(id).status === 'finished');
  await A.updateSettings({ pin: '' });
  ok('PIN required / wrong PIN / correct PIN');

  // 4. decline then accept via UI hook
  await A.updateSettings({ quickSave: 'off' });
  A.once('receive-request', (r) => A.respondReceive(r.id, { accept: false }));
  id = await B.send(dev.id, [{ kind: 'text', text: 'nope' }]);
  await wait(() => B.transfers.get(id).status === 'declined');
  ok('receiver can decline');
  A.once('receive-request', (r) => { assert.strictEqual(r.count, 1); A.respondReceive(r.id, { accept: true }); });
  id = await B.send(dev.id, [{ kind: 'file', path: path.join(src, 'proj', 'a.txt'), name: 'a.txt' }]);
  await wait(() => B.transfers.get(id).status === 'finished');
  ok('receiver can accept after prompt');
  await A.updateSettings({ quickSave: 'on' });

  // 5. path traversal
  const evil = await rawPrepare(55001, { '../../evil.txt': 'x', 'C:\\Windows\\evil2.txt': 'y', 'a/../../evil3.txt': 'z' });
  assert.strictEqual(evil.status, 200);
  for (const [fid, tok] of Object.entries(evil.json.files)) {
    const ur = await rawUpload(55001, evil.json.sessionId, fid, tok, Object.values({ f0: 'x', f1: 'y', f2: 'z' })[Number(fid.slice(1))]); assert.strictEqual(ur.status, 200);
  }
  const outside = [path.join(tmp, 'Alice', 'evil.txt'), path.join(tmp, 'evil.txt')];
  assert.ok(!outside.some(fs.existsSync));
  const all = listAll(destA).map((p) => path.relative(destA, p));
  assert.ok(all.some((p) => p.endsWith('evil.txt')) && all.every((p) => !p.startsWith('..')));
  ok('path traversal attempts stay inside destination');

  // 6. busy
  await A.updateSettings({ quickSave: 'off' });
  let held;
  A.once('receive-request', (r) => (held = r));
  const p1 = B.send(dev.id, [{ kind: 'text', text: 'first' }]);
  await wait(() => held);
  const id2 = await B.send(dev.id, [{ kind: 'text', text: 'second' }]);
  await wait(() => B.transfers.get(id2).status === 'error' && /busy/.test(B.transfers.get(id2).error));
  A.respondReceive(held.id, { accept: false });
  await p1;
  await A.updateSettings({ quickSave: 'on' });
  ok('concurrent session is rejected with 409 busy');

  // 7. subnet sweep discovers peers (VPN-style scan) and classifies the network
  B.devices.clear();
  B.store.patch({ networks: [{ id: 'n1', name: 'Branch VPN', cidr: '127.0.0.1-127.0.0.3', enabled: true }] });
  const found = await B.scanNow({});
  assert.ok(found >= 1, 'sweep should find Alice');
  const alice = B.deviceList().find((d) => d.alias === 'Alice');
  assert.ok(alice, 'Alice in list');
  assert.strictEqual(alice.net.label, 'Branch VPN');
  ok(`CIDR/range sweep discovered peer; labelled "${alice.net.label}"`);

  // 8. cancel mid-transfer
  fs.writeFileSync(path.join(src, 'big.bin'), Buffer.alloc(200 * 1024 * 1024, 1));
  id = await B.send(alice.id, [{ kind: 'file', path: path.join(src, 'big.bin'), name: 'big.bin' }]);
  await wait(() => B.transfers.get(id).status === 'transferring' && B.transfers.get(id).files[0].done > 1024 * 1024);
  B.cancelTransfer(id);
  await wait(() => B.transfers.get(id).status === 'cancelled');
  await wait(() => !A.server.session);
  await wait(() => !listAll(destA).some((p) => p.includes('big')));
  ok('sender cancel aborts and cleans partial file');

  // ---- protocol 2.2 conformance
  let r = await raw({ port: 55001, path: '/api/localsend/v2/info' });
  assert.strictEqual(JSON.parse(r.body).version, '2.2');
  assert.strictEqual(JSON.parse(r.body).download, false);
  ok('advertises protocol version 2.2');

  r = await raw({ port: 55001, method: 'POST', path: '/api/localsend/v2/prepare-upload', body: JSON.stringify({ info: { alias: 'x', fingerprint: 'q', deviceType: 'toaster' }, files: {} }), headers: { 'Content-Type': 'application/json' } });
  assert.strictEqual(r.status, 204);
  r = await raw({ port: 55001, method: 'POST', path: '/api/localsend/v2/prepare-upload', body: '{"info":{"alias":"x"}}', headers: { 'Content-Type': 'application/json' } });
  assert.strictEqual(r.status, 400);
  ok('empty file list answers 204, malformed body answers 400');

  const good = require('crypto').createHash('sha256').update('checksum me').digest('hex');
  for (const [sha, expect] of [[good, 200], ['0'.repeat(64), 422]]) {
    const prep = await rawPrepareMeta(55001, { id: 'c1', fileName: `sum-${expect}.txt`, size: 11, fileType: 'text/plain', sha256: sha });
    assert.strictEqual(prep.status, 200);
    const up = await rawUpload(55001, prep.json.sessionId, 'c1', prep.json.files.c1, 'checksum me');
    assert.strictEqual(up.status, expect);
    await wait(() => !A.server.session);
  }
  assert.ok(fs.existsSync(path.join(destA, 'sum-200.txt')) && !fs.existsSync(path.join(destA, 'sum-422.txt')));
  ok('sha256 verified on upload (422 on mismatch, file discarded)');

  const old = new Date('2020-02-03T04:05:06Z');
  fs.writeFileSync(path.join(src, 'old.txt'), 'old');
  fs.utimesSync(path.join(src, 'old.txt'), old, old);
  id = await B.send(alice.id, [{ kind: 'file', path: path.join(src, 'old.txt'), name: 'old.txt' }]);
  await wait(() => B.transfers.get(id).status === 'finished');
  assert.strictEqual(Math.round(fs.statSync(path.join(destA, 'old.txt')).mtimeMs / 1000), Math.round(old.getTime() / 1000));
  ok('modified time preserved via file metadata');

  const sums = [{ buffer: Buffer.from('a'), size: 1 }, { path: path.join(src, 'old.txt'), size: 3 }];
  await require('../src/core/sender').addChecksums(sums, 'auto', new AbortController().signal);
  assert.ok(sums.every((e) => /^[0-9a-f]{64}$/.test(e.sha256)));
  ok('sender computes sha256 for outgoing files');

  const bigText = 'x'.repeat(70 * 1024);
  const [bigEntry] = await require('../src/core/sender').expandItems([{ kind: 'text', text: bigText }]);
  assert.strictEqual(bigEntry.preview, null);
  ok('text over 64 KB is sent as a file, not an inline message');

  // ---- Download API / share via link (protocol section 5)
  fs.writeFileSync(path.join(src, 'share-a.txt'), '0123456789');
  fs.writeFileSync(path.join(src, 'share-b.bin'), Buffer.alloc(1024, 7));
  await A.updateSettings({ sharePort: 55010 });
  const asked = [];
  A.on('share-request', (q) => { asked.push(q); setTimeout(() => A.respondShare(q.id, q.ip === '127.0.0.1' && asked.length !== 1), 30); });
  const st = await A.startShare([{ kind: 'file', path: path.join(src, 'share-a.txt'), name: 'share-a.txt' }, { kind: 'file', path: path.join(src, 'share-b.bin'), name: 'share-b.bin' }, { kind: 'text', text: 'shared note' }], { pin: '4321', expiresMinutes: 5 });
  assert.ok(st.active && st.port >= 55010 && st.files.length === 3 && st.pin);
  const web = (o) => raw({ proto: 'http', port: st.port, ...o });
  r = await web({ path: '/' });
  assert.strictEqual(r.status, 200);
  assert.ok(/text\/html/.test(r.headers['content-type']) && /nonce-/.test(r.headers['content-security-policy']));
  assert.strictEqual(JSON.parse((await raw({ port: 55001, path: '/api/localsend/v2/info' })).body).download, true);
  ok('share starts a plain-HTTP browser page and advertises download:true');

  r = await web({ method: 'POST', path: '/api/localsend/v2/prepare-download' });
  assert.strictEqual(r.status, 401);
  r = await web({ method: 'POST', path: '/api/localsend/v2/prepare-download?pin=4321' });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(asked.length, 1);
  ok('prepare-download requires the PIN and the owner can reject (403)');

  r = await web({ method: 'POST', path: '/api/localsend/v2/prepare-download?pin=4321' });
  assert.strictEqual(r.status, 200);
  const dl = JSON.parse(r.body);
  assert.ok(dl.sessionId && dl.info.download === true && Object.keys(dl.files).length === 3);
  const fa = Object.values(dl.files).find((f) => f.fileName === 'share-a.txt');
  r = await web({ path: `/api/localsend/v2/download?sessionId=${dl.sessionId}&fileId=${fa.id}` });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body, '0123456789');
  assert.ok(/attachment/.test(r.headers['content-disposition']));
  r = await web({ path: `/api/localsend/v2/download?sessionId=${dl.sessionId}&fileId=${fa.id}`, headers: { Range: 'bytes=3-5' } });
  assert.strictEqual(r.status, 206);
  assert.strictEqual(r.body, '345');
  r = await web({ path: `/api/localsend/v2/download?sessionId=nope&fileId=${fa.id}` });
  assert.strictEqual(r.status, 400);
  r = await web({ method: 'POST', path: `/api/localsend/v2/prepare-download?sessionId=${dl.sessionId}` });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(JSON.parse(r.body).sessionId, dl.sessionId);
  assert.strictEqual(asked.length, 2);
  ok('approved session downloads files (with Range), refresh keeps the session');

  r = await raw({ port: 55001, method: 'POST', path: `/api/localsend/v2/prepare-download?sessionId=${dl.sessionId}` });
  assert.strictEqual(r.status, 200);
  ok('Download API is also served on the main protocol port');

  for (let i = 0; i < 3; i++) await raw({ proto: 'http', port: st.port, method: 'POST', path: '/api/localsend/v2/prepare-download?pin=bad' });
  r = await web({ method: 'POST', path: '/api/localsend/v2/prepare-download?pin=4321' });
  assert.strictEqual(r.status, 429);
  r = await web({ method: 'POST', path: '/api/localsend/v2/upload?sessionId=x&fileId=y&token=z', body: 'x' });
  assert.strictEqual(r.status, 404);
  ok('share server never exposes the upload API');
  assert.ok(A.history.some((h) => h.peer.alias === 'Web download'));
  ok('browser downloads are logged to history');

  await A.stopShare();
  await assert.rejects(web({ path: '/' }));
  assert.strictEqual(JSON.parse((await raw({ port: 55001, path: '/api/localsend/v2/info' })).body).download, false);
  ok('stopping the share closes the server');

  await A.stop();
  await B.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\nAll end-to-end checks passed.');
  process.exit(0);
})().catch((e) => {
  console.error('\nFAILED:', e);
  process.exit(1);
});

function listAll(d) {
  const out = [];
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) out.push(...listAll(p));
    else out.push(p);
  }
  return out;
}

function rawPrepareMeta(port, meta) {
  return rawReq(port, '/api/localsend/v2/prepare-upload', JSON.stringify({ info: { alias: 'sum', fingerprint: 'sumfp', port: 1, protocol: 'https' }, files: { [meta.id]: meta } }), 'application/json').then((r) => {
    r.json = JSON.parse(r.body);
    return r;
  });
}

function raw({ proto = 'https', port, method = 'GET', path: p, body, headers = {} }) {
  const lib = proto === 'http' ? require('http') : https;
  return new Promise((resolve, reject) => {
    const req = lib.request({ host: '127.0.0.1', port, path: p, method, rejectUnauthorized: false, agent: false, headers: { ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function rawPrepare(port, names) {
  const files = {};
  Object.entries(names).forEach(([n, c], i) => (files['f' + i] = { id: 'f' + i, fileName: n, size: Buffer.byteLength(c), fileType: 'text/plain' }));
  return rawReq(port, '/api/localsend/v2/prepare-upload', JSON.stringify({ info: { alias: 'evil', fingerprint: 'zzz', port: 1, protocol: 'https' }, files }), 'application/json').then((r) => {
    r.json = JSON.parse(r.body);
    return r;
  });
}
function rawUpload(port, sid, fid, tok, body) {
  return rawReq(port, `/api/localsend/v2/upload?sessionId=${sid}&fileId=${fid}&token=${tok}`, body, 'text/plain');
}
function rawReq(port, p, body, type) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port, path: p, method: 'POST', rejectUnauthorized: false, headers: { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.end(body);
  });
}



