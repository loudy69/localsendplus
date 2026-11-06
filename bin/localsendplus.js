#!/usr/bin/env node
'use strict';
// LocalSendPlus command-line client - send, receive and share without the desktop window.
// Talks LocalSend protocol v2.2, so it works with LocalSend and LocalSendPlus on any platform.
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const readline = require('readline');
const { Engine } = require('../src/core/engine');
const { VERSION } = require('../src/core/protocol');

const HELP = `LocalSendPlus CLI (protocol v${VERSION})

Usage:
  localsendplus devices [--wait <seconds>]
  localsendplus send --to <alias|ip[:port]> [--pin <pin>] <file-or-folder...>
  localsendplus send --to <alias|ip[:port]> --text <message|->
  localsendplus receive [--dir <folder>] [--yes] [--once] [--pin <pin>] [--port <n>]
  localsendplus share [--pin <pin>] [--yes] [--minutes <n>] [--port <n>] <file-or-folder...>

Options:
  --alias <name>   device name shown to others
  --home <folder>  where settings are kept (default ~/.localsendplus, or $LOCALSENDPLUS_HOME)
  --yes            accept incoming requests without asking
  -h, --help       show this help
  -v, --version    show the version

"-" as the text reads the message from stdin. Text longer than 64 KB is sent as a .txt file.`;

function parse(argv) {
  const opts = {};
  const rest = [];
  const flags = new Set(['yes', 'once', 'help', 'version']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') opts.help = true;
    else if (a === '-v') opts.version = true;
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const k = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (flags.has(k)) opts[k] = true;
      else opts[k] = eq > 0 ? a.slice(eq + 1) : argv[++i];
    } else rest.push(a);
  }
  return { opts, rest };
}

function freePort(preferred) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => {
      const t = net.createServer();
      t.listen(0, () => {
        const p = t.address().port;
        t.close(() => resolve(p));
      });
    });
    s.listen(preferred, () => s.close(() => resolve(preferred)));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${i ? n.toFixed(1) : n} ${u[i]}`;
};
const die = (msg, code = 1) => {
  console.error(`localsendplus: ${msg}`);
  process.exit(code);
};

async function makeEngine(opts, { server }) {
  const home = opts.home || process.env.LOCALSENDPLUS_HOME || path.join(os.homedir(), '.localsendplus');
  const overrides = { quickSave: opts.yes ? 'on' : 'off', destination: path.resolve(opts.dir || process.cwd()), pin: opts.receivePin || '' };
  if (opts.alias) overrides.alias = String(opts.alias).slice(0, 40);
  overrides.port = await freePort(Number(opts.port) || 53317);
  const engine = new Engine({ dir: path.join(home, 'data'), overrides, deviceType: 'headless' });
  engine.on('error', (e) => console.error(`warning: ${e.message}`));
  engine._refreshInterfaces();
  if (server) await engine.start();
  return engine;
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (a) => { rl.close(); resolve(/^y(es)?$/i.test(a.trim())); });
    rl.on('close', () => resolve(false));
  });
}

// Prompts one request at a time so overlapping questions do not interleave on the terminal.
function promptQueue() {
  let chain = Promise.resolve();
  return (question) => {
    const p = chain.then(() => ask(question));
    chain = p.catch(() => {});
    return p;
  };
}

async function cmdDevices(opts) {
  const engine = await makeEngine(opts, { server: true });
  await sleep(Math.max(1, Number(opts.wait) || 4) * 1000);
  const list = engine.deviceList().filter((d) => d.online);
  if (!list.length) console.log('No devices found.');
  for (const d of list) console.log(`${d.alias.padEnd(24)} ${`${d.ip}:${d.port}`.padEnd(22)} ${(d.deviceType || '').padEnd(9)} ${d.net.label}`);
  await engine.stop();
  process.exit(0);
}

async function resolveTarget(engine, to) {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3}|[a-z0-9.-]+\.[a-z]{2,})(?::(\d+))?$/i.exec(to);
  const byAlias = () => engine.deviceList().filter((d) => d.online && d.alias.toLowerCase() === to.toLowerCase());
  if (m && !byAlias().length) {
    try { return await engine.addHost(m[1], m[2]); } catch (e) { if (/^\d/.test(to)) throw e; }
  }
  for (let i = 0; i < 16; i++) {
    const hits = byAlias();
    if (hits.length > 1) throw new Error(`"${to}" matches ${hits.length} devices - use its IP address instead`);
    if (hits.length === 1) return hits[0];
    await sleep(500);
  }
  throw new Error(`No device named "${to}" was found. Run "localsendplus devices" to see what is reachable.`);
}

function describe(p) {
  let st;
  try { st = fs.statSync(p); } catch { die(`cannot read ${p}`); }
  const abs = path.resolve(p);
  return { kind: st.isDirectory() ? 'folder' : 'file', path: abs, name: path.basename(abs) };
}

async function cmdSend(opts, paths) {
  if (!opts.to) die('send needs --to <alias|ip>');
  const items = [];
  if (opts.text !== undefined) {
    let text = opts.text;
    if (text === '-') {
      const chunks = [];
      for await (const c of process.stdin) chunks.push(c);
      text = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
    }
    items.push({ kind: 'text', text });
  }
  for (const p of paths) items.push(describe(p));
  if (!items.length) die('nothing to send - pass files, folders or --text');

  const isIp = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(opts.to);
  const engine = await makeEngine(opts, { server: !isIp });
  let dev;
  try { dev = await resolveTarget(engine, opts.to); } catch (e) { die(e.message); }
  console.error(`Sending to ${dev.alias} (${dev.ip}:${dev.port})...`);

  let exitCode = 0;
  let pin = opts.pin;
  for (;;) {
    const id = await engine.send(dev.id, items, { pin });
    const t = await new Promise((resolve) => {
      const on = (tr) => {
        if (tr.id !== id) return;
        if (tr.endedAt || tr.status === 'pin-required') {
          engine.off('transfer', on);
          process.stderr.write('\r\x1b[K');
          return resolve(tr);
        }
        const pct = tr.total ? Math.floor((tr.done / tr.total) * 100) : 0;
        process.stderr.write(`\r${tr.status === 'waiting' ? 'Waiting for the receiver to accept...' : `${pct}%  ${fmt(tr.done)} / ${fmt(tr.total)}  ${tr.speed ? `${fmt(tr.speed)}/s` : ''}`}\x1b[K`);
      };
      engine.on('transfer', on);
    });
    if (t.status === 'pin-required') {
      if (!process.stdin.isTTY) die(t.error === 'Invalid PIN' ? 'invalid PIN' : 'the receiver requires a PIN (use --pin)', 2);
      pin = await new Promise((r) => { const rl = readline.createInterface({ input: process.stdin, output: process.stderr }); rl.question('PIN: ', (a) => { rl.close(); r(a.trim()); }); });
      continue;
    }
    if (t.status === 'finished') console.error(`Sent ${t.files.filter((f) => f.status === 'done').length} item(s) (${fmt(t.total)}).`);
    else { console.error(`${t.status === 'declined' ? 'Declined' : 'Failed'}: ${t.error || t.status}`); exitCode = t.status === 'declined' ? 3 : 1; }
    break;
  }
  await engine.stop();
  process.exit(exitCode);
}

async function cmdReceive(opts) {
  const engine = await makeEngine({ ...opts, receivePin: opts.pin }, { server: true });
  if (engine.serverError) die(engine.serverError);
  const q = promptQueue();
  engine.on('receive-request', async (r) => {
    const what = r.isMessage ? 'a message' : `${r.count} file(s) (${fmt(r.totalSize)})`;
    const ok = await q(`${r.sender.alias} (${r.sender.ip}) wants to send ${what}. Accept? [y/N] `);
    engine.respondReceive(r.id, { accept: ok });
  });
  engine.on('message-received', ({ text, peer }) => {
    console.log(`\n--- message from ${peer.alias} ---\n${text}\n---`);
    if (opts.once) engine.stop().then(() => process.exit(0));
  });
  engine.on('receive-complete', (t) => {
    if (t.isMessage) return;
    const ok = t.files.filter((f) => f.status === 'done');
    console.log(`Received ${ok.length} file(s) from ${t.peer.alias} -> ${t.destination}`);
    if (opts.once) engine.stop().then(() => process.exit(t.status === 'finished' ? 0 : 1));
  });
  const addrs = engine.interfaces().map((i) => i.address);
  console.log(`Listening as "${engine.store.get('alias')}" on port ${engine.store.get('port')} (${addrs.join(', ') || 'no network'})`);
  console.log(`Saving to ${engine.store.get('destination')}. Press Ctrl+C to stop.`);
  process.on('SIGINT', () => engine.stop().then(() => process.exit(0)));
}

async function cmdShare(opts, paths) {
  if (!paths.length) die('share needs at least one file or folder');
  const items = paths.map(describe);
  const engine = await makeEngine(opts, { server: false });
  const q = promptQueue();
  engine.on('share-request', async (r) => engine.respondShare(r.id, await q(`${r.ip} wants to download the shared files. Allow? [y/N] `)));
  let st;
  try {
    st = await engine.startShare(items, { pin: opts.pin || '', autoAccept: !!opts.yes, expiresMinutes: opts.minutes !== undefined ? Number(opts.minutes) : 0 });
  } catch (e) { die(e.message); }
  console.log(`Sharing ${st.files.length} item(s). Open one of these links in any browser:`);
  for (const u of st.urls) console.log(`  ${u.url}   (${u.name})`);
  if (st.urls[0]) console.log(await require('qrcode').toString(st.urls[0].url, { type: 'terminal', small: true }));
  if (opts.pin) console.log('Browsers must enter the PIN you set.');
  console.log('Press Ctrl+C to stop sharing.');
  process.on('SIGINT', () => engine.stop().then(() => process.exit(0)));
}

(async () => {
  const { opts, rest } = parse(process.argv.slice(2));
  const [cmd, ...args] = rest;
  if (opts.version) return console.log(require('../package.json').version);
  if (opts.help || !cmd) return console.log(HELP);
  if (cmd === 'devices') return cmdDevices(opts);
  if (cmd === 'send') return cmdSend(opts, args);
  if (cmd === 'receive') return cmdReceive(opts);
  if (cmd === 'share') return cmdShare(opts, args);
  die(`unknown command "${cmd}"\n\n${HELP}`);
})().catch((e) => die(e.message));
