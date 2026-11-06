'use strict';
// Developer helper: drives the real UI against a headless peer (run with --uitest).
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { Engine } = require('../src/core/engine');

module.exports = async function uitest(win, appEngine, done) {
  const log = [];
  const ok = (m) => { log.push('PASS ' + m); };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-ui-'));
  const wait = async (fn, ms = 10000, what = 'condition') => {
    const t = Date.now();
    while (Date.now() - t < ms) {
      const v = await fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 80));
    }
    throw new Error('timeout: ' + what);
  };
  const run = (js) => win.webContents.executeJavaScript(js, true);
  const bob = new Engine({ dir: path.join(tmp, 'bob'), overrides: { alias: 'Bob', port: 55002, destination: path.join(tmp, 'bob-recv'), quickSave: 'on', discovery: { multicast: false, scanLocalSubnets: false, scanRemote: false } } });
  let failed = false;
  try {
    await new Promise((r) => setTimeout(r, 1500));
    await bob.server.start();
    const dev = await bob.addHost('127.0.0.1', 53400);
    assert.strictEqual(dev.alias, appEngine.store.get('alias'));
    await wait(() => run(`S.st.devices.some(d => d.alias === 'Bob')`), 8000, 'Bob in UI device list');
    await run(`go('send')`);
    await wait(() => run(`[...document.querySelectorAll('.device .name')].some(n => n.textContent === 'Bob')`), 5000, 'Bob tile rendered');
    ok('peer appears in the Send tab device list');

    // Bob -> app: text with accept prompt
    bob.send(dev.id, [{ kind: 'text', text: 'hello across the VPN 🚀' }]);
    await wait(() => run(`!![...S.dialogs.keys()].find(k => k.startsWith('request:'))`), 8000, 'request dialog');
    const reqText = await run(`document.querySelector('.dialog').textContent`);
    assert.ok(/Bob/.test(reqText) && /text message/.test(reqText), reqText);
    await run(`[...document.querySelectorAll('.dialog .btn')].find(b => /Accept/.test(b.textContent)).click()`);
    await wait(() => run(`!![...S.dialogs.keys()].find(k => k.startsWith('message:'))`), 8000, 'message dialog');
    assert.ok((await run(`document.querySelector('.msgbox').textContent`)).includes('hello across the VPN 🚀'));
    await run(`[...S.dialogs.keys()].forEach(k => closeDialog(k, true))`);
    ok('incoming text: prompt → accept → message dialog');

    // Bob -> app: folder with accept prompt
    const src = path.join(tmp, 'src', 'Photos');
    fs.mkdirSync(path.join(src, 'trip'), { recursive: true });
    fs.writeFileSync(path.join(src, 'a.txt'), 'AAA');
    fs.writeFileSync(path.join(src, 'trip', 'b.bin'), Buffer.alloc(2 * 1024 * 1024, 7));
    bob.send(dev.id, [{ kind: 'folder', path: src, name: 'Photos' }]);
    await wait(() => run(`!![...S.dialogs.keys()].find(k => k.startsWith('request:'))`), 8000, 'folder request');
    assert.ok(/2 files/.test(await run(`document.querySelector('.dialog').textContent`)));
    await run(`[...document.querySelectorAll('.dialog .btn')].find(b => /Accept/.test(b.textContent)).click()`);
    const recv = appEngine.store.get('destination');
    await wait(() => fs.existsSync(path.join(recv, 'Photos', 'trip', 'b.bin')), 8000, 'folder saved');
    await wait(() => run(`S.st.transfers.some(t => t.direction === 'receive' && t.status === 'finished')`), 8000, 'receive finished in UI');
    ok('incoming folder: structure preserved, transfer shown as finished');
    await run(`[...S.dialogs.keys()].forEach(k => closeDialog(k, true))`);

    // app -> Bob: file selected via real selection API, tile click
    fs.writeFileSync(path.join(tmp, 'doc.pdf'), Buffer.alloc(300000, 1));
    const items = await run(`sa.describePaths(${JSON.stringify([path.join(tmp, 'doc.pdf'), src])}).then(i => { addItems(i); return S.selection.length; })`);
    assert.strictEqual(items, 2);
    await run(`go('send')`);
    await run(`[...document.querySelectorAll('.device')].find(d => d.textContent.includes('Bob')).click()`);
    await wait(() => fs.existsSync(path.join(tmp, 'bob-recv', 'doc.pdf')) && fs.existsSync(path.join(tmp, 'bob-recv', 'Photos', 'a.txt')), 10000, 'files at Bob');
    await wait(() => run(`S.selection.length === 0`), 6000, 'selection cleared after success');
    ok('outgoing file + folder via tile click; selection cleared when finished');
    await run(`[...S.dialogs.keys()].forEach(k => closeDialog(k, true))`);

    // app -> Bob: text compose
    await run(`addItems([{ id: 'tx', kind: 'text', text: 'ping from the app' }])`);
    let got = null;
    bob.on('message-received', (m) => (got = m.text));
    await run(`[...document.querySelectorAll('.device')].find(d => d.textContent.includes('Bob')).click()`);
    await wait(() => got, 6000, 'text at Bob');
    assert.strictEqual(got, 'ping from the app');
    ok('outgoing text message');

    // history + settings round-trip
    await wait(() => run(`S.st.history.length >= 3`), 4000, 'history');
    await run(`setSetting({ alias: 'UI Test Box' })`);
    assert.strictEqual(appEngine.store.get('alias'), 'UI Test Box');
    ok('history populated; settings round-trip through IPC');

    // paste event with text
    await run(`go('send'); S.selection = []; renderSelection(); document.dispatchEvent(Object.assign(new Event('paste', { cancelable: true }), { clipboardData: { files: [], getData: (t) => t === 'text/plain' ? 'pasted from clipboard' : '' } })); true`);
    await wait(() => run(`S.selection.length === 1 && S.selection[0].kind === 'text'`), 3000, 'paste adds text');
    ok('paste event adds clipboard text to the selection');

    // range add flow via UI: sweep finds Bob
    bob.devices.clear();
    appEngine.devices.clear();
    appEngine.store.patch({ discovery: { scanRemote: true, scanPorts: [55002] } });
    await run(`rangeDialog()`);
    await run(`(() => { const d = document.querySelector('.dialog'); const ins = d.querySelectorAll('input'); ins[0].value = 'Loopback test'; ins[1].value = '127.0.0.1-127.0.0.2'; ins[1].dispatchEvent(new Event('input')); [...d.querySelectorAll('.btn')].find(b => /Add & scan/.test(b.textContent)).click(); })()`);
    await wait(() => appEngine.deviceList().some((d) => d.alias === 'Bob'), 10000, 'range scan finds Bob');
    assert.strictEqual(appEngine.deviceList().find((d) => d.alias === 'Bob').net.label, 'Loopback test');
    ok('Add range dialog → scan → peer discovered and labelled with the range name');

    // share via link: dialog → start → QR/links → approve a browser → download
    await run(`[...S.dialogs.keys()].forEach(k => closeDialog(k, true)); S.selection = []; addItems([{ id: 'sh1', kind: 'text', text: 'shared by link' }]); go('send'); shareDialog(); true`);
    assert.ok(/Start sharing/.test(await run(`document.querySelector('.dialog').textContent`)));
    await run(`[...document.querySelectorAll('.dialog .btn')].find(b => /Start sharing/.test(b.textContent)).click()`);
    await wait(() => run(`S.st.share && S.st.share.active && !!document.querySelector('.dialog .qr svg')`), 6000, 'share running with QR');
    const sh = await run(`S.st.share`);
    assert.ok(sh.urls.length && sh.port, 'share links listed');
    ok('Share via link: dialog starts the share and renders a QR code');
    const http = require('http');
    const call = (method, p, headers = {}) => new Promise((resolve, reject) => {
      const rq = http.request({ host: '127.0.0.1', port: sh.port, path: p, method, headers }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
      rq.on('error', reject);
      rq.end();
    });
    const pending = call('POST', '/api/localsend/v2/prepare-download');
    await wait(() => run(`!![...S.dialogs.keys()].find(k => k.startsWith('share-request:'))`), 6000, 'share request dialog');
    await run(`[...document.querySelectorAll('.dialog .btn')].find(b => /Allow/.test(b.textContent)).click()`);
    const resp = await pending;
    assert.strictEqual(resp.status, 200);
    const j = JSON.parse(resp.body);
    const fid = Object.keys(j.files)[0];
    const file = await call('GET', `/api/localsend/v2/download?sessionId=${j.sessionId}&fileId=${fid}`);
    assert.strictEqual(file.body, 'shared by link');
    ok('browser request prompts the owner; allowed download delivers the file');
    await run(`sa.shareStop()`);
    await wait(() => run(`!S.st.share.active`), 4000, 'share stopped');
    ok('Stop sharing closes the link');
  } catch (e) {
    failed = true;
    log.push('FAIL ' + (e.stack || e));
  }
  fs.writeFileSync(path.join(__dirname, '..', 'uitest-result.txt'), log.join('\n'));
  await bob.stop().catch(() => {});
  setTimeout(() => { done(); process.exitCode = failed ? 1 : 0; }, 300);
};
