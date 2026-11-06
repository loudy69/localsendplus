'use strict';
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { mimeOf } = require('./util');
const { VERSION, API, TEXT_PREVIEW_LIMIT } = require('./protocol');

const AUTO_CHECKSUM_LIMIT = 64 * 1024 * 1024;

const httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true, maxSockets: 8 });
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 8 });

function request(device, method, pathAndQuery, { body, headers = {}, timeout = 0, agentOnly } = {}) {
  return new Promise((resolve, reject) => {
    const lib = device.protocol === 'http' ? http : https;
    const req = lib.request(
      {
        host: device.ip,
        port: device.port,
        method,
        path: pathAndQuery,
        headers,
        agent: device.protocol === 'http' ? httpAgent : httpsAgent,
        rejectUnauthorized: false,
        timeout: timeout || undefined,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = raw ? JSON.parse(raw) : null; } catch { /* not json */ }
          resolve({ status: res.statusCode, json, raw });
        });
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    if (body !== undefined) req.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    else req.end();
    if (agentOnly) agentOnly(req);
  });
}

// Walks a folder, returning files with posix-style relative names that start with the folder name.
async function walkFolder(root, onFile) {
  const base = path.basename(root);
  const stack = [{ abs: root, rel: base }];
  while (stack.length) {
    const { abs, rel } = stack.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const childAbs = path.join(abs, e.name);
      const childRel = `${rel}/${e.name}`;
      if (e.isDirectory()) stack.push({ abs: childAbs, rel: childRel });
      else if (e.isFile() || e.isSymbolicLink()) {
        try {
          const st = await fs.promises.stat(childAbs);
          if (st.isFile()) onFile({ path: childAbs, relName: childRel, size: st.size, modified: st.mtime, accessed: st.atime });
          else if (st.isDirectory()) stack.push({ abs: childAbs, rel: childRel });
        } catch {
          /* unreadable */
        }
      }
    }
  }
}

async function folderInfo(root) {
  let count = 0;
  let size = 0;
  await walkFolder(root, (f) => {
    count++;
    size += f.size;
  });
  return { count, size };
}

// Expands UI selection descriptors into protocol file entries.
async function expandItems(items) {
  const out = [];
  for (const it of items) {
    if (it.kind === 'text') {
      const text = String(it.text);
      const buf = Buffer.from(text, 'utf8');
      const inline = buf.length <= TEXT_PREVIEW_LIMIT;
      out.push({ id: crypto.randomUUID(), fileName: `${crypto.randomUUID()}.txt`, size: buf.length, fileType: 'text/plain', preview: inline ? text : null, buffer: buf });
    } else if (it.kind === 'file' || it.kind === 'image') {
      const st = await fs.promises.stat(it.path);
      out.push({ id: crypto.randomUUID(), fileName: it.name || path.basename(it.path), size: st.size, fileType: mimeOf(it.name || it.path), path: it.path, modified: st.mtime, accessed: st.atime });
    } else if (it.kind === 'folder') {
      await walkFolder(it.path, (f) =>
        out.push({ id: crypto.randomUUID(), fileName: f.relName, size: f.size, fileType: mimeOf(f.relName), path: f.path, modified: f.modified, accessed: f.accessed })
      );
    }
  }
  return out;
}

function sha256Of(entry, signal) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    if (entry.buffer) return resolve(hash.update(entry.buffer).digest('hex'));
    const rs = fs.createReadStream(entry.path);
    const abort = () => rs.destroy(Object.assign(new Error('cancelled'), { code: 'CANCELLED' }));
    signal?.addEventListener('abort', abort, { once: true });
    rs.on('data', (c) => hash.update(c));
    rs.on('error', reject);
    rs.on('end', () => {
      signal?.removeEventListener('abort', abort);
      resolve(hash.digest('hex'));
    });
  });
}

// Adds sha256 digests so the receiver can verify integrity (protocol 2.2, HTTP 422 on mismatch).
// mode: 'always' | 'auto' (files up to 64 MB) | 'off'
async function addChecksums(entries, mode, signal, onStart) {
  if (mode === 'off') return;
  const todo = entries.filter((e) => !e.sha256 && (mode === 'always' || e.size <= AUTO_CHECKSUM_LIMIT));
  if (!todo.length) return;
  onStart?.();
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      if (signal?.aborted) return;
      const e = todo[i++];
      try { e.sha256 = await sha256Of(e, signal); } catch (err) { if (err.code === 'CANCELLED') return; /* unreadable: send without checksum */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, todo.length) }, worker));
}

class SendError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// Sends a prepared list of entries to a device. `hooks.onUpdate(state)` is invoked on progress.
async function sendEntries({ device, info, entries, pin, hooks, signal, checksums = 'auto' }) {
  await addChecksums(entries, checksums, signal, () => hooks.status('preparing'));
  if (signal.aborted) throw new SendError('cancelled', 'Cancelled');
  const filesMeta = {};
  for (const e of entries) {
    filesMeta[e.id] = {
      id: e.id,
      fileName: e.fileName,
      size: e.size,
      fileType: e.fileType,
      sha256: e.sha256 || null,
      preview: e.preview || null,
      metadata: e.modified ? { modified: e.modified.toISOString(), accessed: (e.accessed || e.modified).toISOString() } : null,
    };
  }
  const q = pin ? `?pin=${encodeURIComponent(pin)}` : '';
  hooks.status('waiting');

  const prep = await request(
    device,
    'POST',
    `${API}/prepare-upload${q}`,
    { body: { info: { alias: info.alias, version: VERSION, deviceModel: info.deviceModel, deviceType: info.deviceType, fingerprint: info.fingerprint, port: info.port, protocol: info.protocol, download: !!info.download }, files: filesMeta }, headers: { 'Content-Type': 'application/json' }, agentOnly: (req) => signal.addEventListener('abort', () => req.destroy(Object.assign(new Error('cancelled'), { code: 'CANCELLED' })), { once: true }) }
  ).catch((e) => {
    if (signal.aborted) throw new SendError('cancelled', 'Cancelled');
    throw new SendError('unreachable', `Could not reach ${device.alias} (${e.code || e.message})`);
  });

  switch (prep.status) {
    case 200: break;
    case 204: return { finished: true };
    case 401: throw new SendError('pin', pin ? 'Invalid PIN' : 'PIN required', 401);
    case 403: throw new SendError('declined', 'The receiver declined the transfer', 403);
    case 409: throw new SendError('busy', 'The receiver is busy with another transfer', 409);
    case 429: throw new SendError('rate', 'Too many attempts, try again later', 429);
    default: throw new SendError('error', `Receiver error (${prep.status})`, prep.status);
  }
  const { sessionId, files: tokens } = prep.json || {};
  if (!sessionId || !tokens) throw new SendError('error', 'Invalid response from receiver');

  hooks.status('transferring');
  const queue = entries.filter((e) => tokens[e.id]);
  for (const e of entries) if (!tokens[e.id]) hooks.file(e.id, 'skipped');
  const inflight = new Set();
  let failure = null;

  const cancelRemote = () => request(device, 'POST', `${API}/cancel?sessionId=${encodeURIComponent(sessionId)}`, { timeout: 3000 }).catch(() => {});
  signal.addEventListener('abort', () => {
    for (const r of inflight) r.destroy(Object.assign(new Error('cancelled'), { code: 'CANCELLED' }));
    cancelRemote();
  }, { once: true });

  const uploadOne = (e) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new SendError('cancelled', 'Cancelled'));
      hooks.file(e.id, 'sending');
      const lib = device.protocol === 'http' ? http : https;
      const req = lib.request(
        {
          host: device.ip,
          port: device.port,
          method: 'POST',
          path: `${API}/upload?sessionId=${encodeURIComponent(sessionId)}&fileId=${encodeURIComponent(e.id)}&token=${encodeURIComponent(tokens[e.id])}`,
          headers: { 'Content-Type': e.fileType || 'application/octet-stream', 'Content-Length': e.size },
          agent: device.protocol === 'http' ? httpAgent : httpsAgent,
          rejectUnauthorized: false,
        },
        (res) => {
          res.resume();
          res.on('end', () => {
            inflight.delete(req);
            if (res.statusCode === 200) {
              hooks.file(e.id, 'done');
              resolve();
            } else {
              hooks.file(e.id, 'failed');
              reject(new SendError(res.statusCode === 422 ? 'checksum' : 'error', res.statusCode === 403 ? 'Cancelled by receiver' : res.statusCode === 422 ? 'The file arrived damaged (checksum mismatch)' : `Upload failed (${res.statusCode})`, res.statusCode));
            }
          });
        }
      );
      inflight.add(req);
      req.on('error', (err) => {
        inflight.delete(req);
        hooks.file(e.id, 'failed');
        reject(signal.aborted ? new SendError('cancelled', 'Cancelled') : new SendError('error', `Connection lost (${err.code || err.message})`));
      });
      if (e.buffer) {
        hooks.bytes(e.id, e.size);
        req.end(e.buffer);
        return;
      }
      const rs = fs.createReadStream(e.path);
      rs.on('data', (c) => hooks.bytes(e.id, c.length));
      rs.on('error', (err) => req.destroy(err));
      rs.pipe(req);
    });

  const concurrency = Math.min(3, Math.max(1, queue.length));
  let idx = 0;
  const worker = async () => {
    while (!failure && !signal.aborted) {
      const e = queue[idx++];
      if (!e) return;
      try {
        await uploadOne(e);
      } catch (err) {
        failure = failure || err;
        for (const r of inflight) r.destroy();
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  if (signal.aborted) throw new SendError('cancelled', 'Cancelled');
  if (failure) {
    cancelRemote();
    throw failure;
  }
  return { finished: true };
}

module.exports = { request, expandItems, folderInfo, walkFolder, sendEntries, addChecksums, SendError, API };
