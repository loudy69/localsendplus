'use strict';
const net = require('net');
const https = require('https');
const http = require('http');
const { API, VERSION } = require('./protocol');

function ownBody(info) {
  return {
    alias: info.alias,
    version: VERSION,
    deviceModel: info.deviceModel,
    deviceType: info.deviceType,
    fingerprint: info.fingerprint,
    port: info.port,
    protocol: info.protocol,
    download: !!info.download,
  };
}

function tcpOpen(ip, port, timeout) {
  return new Promise((resolve) => {
    const s = net.connect({ host: ip, port });
    let done = false;
    const end = (ok) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeout, () => end(false));
    s.once('connect', () => end(true));
    s.once('error', () => end(false));
  });
}

function postRegister(ip, port, protocol, info, timeout) {
  return new Promise((resolve) => {
    const lib = protocol === 'http' ? http : https;
    const body = JSON.stringify(ownBody(info));
    const req = lib.request(
      {
        host: ip,
        port,
        method: 'POST',
        path: `${API}/register`,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        rejectUnauthorized: false,
        agent: false,
        timeout,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve(null);
          try {
            const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            resolve(j && typeof j.alias === 'string' ? j : null);
          } catch {
            resolve(null);
          }
        });
        res.on('error', () => resolve(null));
      }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end(body);
  });
}

// Two-way register handshake: we introduce ourselves and learn about the peer in one call.
async function register({ ip, port, protocol }, info, timeout = 3000) {
  const order = protocol ? [protocol] : ['https', 'http'];
  for (const proto of order) {
    const started = Date.now();
    const j = await postRegister(ip, port, proto, info, timeout);
    if (j) {
      return { ...j, ip, port, protocol: proto, rtt: Date.now() - started };
    }
  }
  return null;
}

// Sweeps targets (async iterable of IPs) for LocalSendPlus / LocalSend peers.
async function sweep({ targets, ports, info, concurrency, timeout, signal, onFound, onProgress, total, isSelf }) {
  let done = 0;
  let found = 0;
  const iterator = targets[Symbol.iterator]();
  const worker = async () => {
    for (;;) {
      if (signal?.aborted) return;
      const n = iterator.next();
      if (n.done) return;
      const ip = n.value;
      for (const port of ports) {
        if (signal?.aborted) return;
        if (isSelf && isSelf(ip, port)) continue;
        if (!(await tcpOpen(ip, port, timeout))) continue;
        const dev = await register({ ip, port }, info, Math.max(timeout * 3, 2500));
        if (dev && dev.fingerprint !== info.fingerprint) {
          found++;
          onFound(dev);
        }
      }
      done++;
      if (onProgress && (done % 64 === 0 || done === total)) onProgress({ done, total, found });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  onProgress?.({ done: total, total, found });
  return found;
}

function* ipRange(start, end, skip) {
  const { intToIp } = require('./network');
  for (let n = start; n <= end; n++) {
    const ip = intToIp(n);
    if (skip && skip.has(ip)) continue;
    yield ip;
  }
}

module.exports = { register, sweep, ipRange, tcpOpen, ownBody };

