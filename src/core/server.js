'use strict';
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Transform, pipeline } = require('stream');
const { EventEmitter } = require('events');
const { safeRelativePath, uniquePath, resolveInside, readJson, sendJson, stripV6, PinGuard } = require('./util');
const { VERSION, API, normalizeDeviceType, normalizeSha256, parseMetaDate } = require('./protocol');
const MAX_FILES = 200000;
const DECISION_TIMEOUT_MS = 120_000;
const SESSION_IDLE_MS = 3 * 60_000;

// Receiver side of the LocalSend v2.2 protocol (register / prepare-upload / upload / cancel / info),
// plus the Download API (prepare-download / download) while a share is active.
class ReceiveServer extends EventEmitter {
  constructor({ identity, getInfo, getSettings, decide, onPeer, share }) {
    super();
    this.identity = identity;
    this.getInfo = getInfo;
    this.getSettings = getSettings;
    this.decide = decide;
    this.onPeer = onPeer;
    this.share = share || null;
    this.server = null;
    this.session = null;
    this.pinGuard = new PinGuard(() => this.getSettings().pin);
    this.pending = new Set();
    this._idleTimer = setInterval(() => this._checkIdle(), 15_000);
    this._idleTimer.unref?.();
  }

  async start() {
    await this.stop();
    const s = this.getSettings();
    const handler = (req, res) => this._route(req, res).catch((err) => this._fail(res, err));
    this.server =
      s.protocol === 'http'
        ? http.createServer(handler)
        : https.createServer({ key: this.identity.key, cert: this.identity.cert }, handler);
    this.server.keepAliveTimeout = 30_000;
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 60_000;
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(s.port, '0.0.0.0', () => {
        this.server.off('error', reject);
        this.server.on('error', (e) => this.emit('error', e));
        resolve();
      });
    }).catch((e) => {
      this.server = null;
      throw e;
    });
  }

  async stop() {
    if (this.session) this._endSession('cancelled');
    if (!this.server) return;
    const srv = this.server;
    this.server = null;
    srv.closeAllConnections?.();
    await new Promise((r) => srv.close(() => r()));
  }

  _fail(res, err) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    sendJson(res, err.status || 500, { message: err.message || 'Unknown error' });
  }

  async _route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const ip = stripV6(req.socket.remoteAddress);

    if (req.method === 'GET' && (p === `${API}/info` || p === '/api/localsend/v1/info')) {
      const { alias, deviceModel, deviceType, fingerprint, download } = this.getInfo();
      return sendJson(res, 200, { alias, version: VERSION, deviceModel, deviceType, fingerprint, download });
    }
    if (this.share?.active && (p === `${API}/prepare-download` || p === `${API}/download` || (req.method === 'GET' && p === '/'))) {
      if (await this.share.handle(req, res)) return;
    }
    if (req.method === 'POST' && p === `${API}/register`) return this._register(req, res, ip);
    if (req.method === 'POST' && p === `${API}/prepare-upload`) return this._prepare(req, res, url, ip);
    if (req.method === 'POST' && p === `${API}/upload`) return this._upload(req, res, url, ip);
    if (req.method === 'POST' && p === `${API}/cancel`) return this._cancel(res, url, ip);
    if (req.method === 'GET' && p === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('LocalSendPlus is running. Open the desktop app to send files.');
    }
    sendJson(res, 404, { message: 'Not found' });
  }

  async _register(req, res, ip) {
    const body = await readJson(req, 1024 * 64);
    if (!body || typeof body.alias !== 'string') throw Object.assign(new Error('Invalid body'), { status: 400 });
    const info = this.getInfo();
    if (body.fingerprint !== info.fingerprint) {
      this.onPeer({ ...body, ip, deviceType: normalizeDeviceType(body.deviceType), protocol: body.protocol || 'https' }, 'register');
    }
    const { alias, deviceModel, deviceType, fingerprint, download } = info;
    sendJson(res, 200, { alias, version: VERSION, deviceModel, deviceType, fingerprint, download });
  }

  async _prepare(req, res, url, ip) {
    const pin = this.pinGuard.check(ip, url.searchParams.get('pin'));
    if (!pin.ok) return sendJson(res, pin.status, { message: pin.status === 429 ? 'Too many requests' : 'PIN required / Invalid PIN' });

    const body = await readJson(req);
    if (!body || !body.info || typeof body.info.alias !== 'string' || !body.files || typeof body.files !== 'object' || Array.isArray(body.files)) {
      return sendJson(res, 400, { message: 'Invalid body' });
    }
    const files = Object.values(body.files);
    // Nothing to transfer: the protocol answers with 204 (finished) instead of opening a session.
    if (!files.length) return res.writeHead(204).end();
    if (files.length > MAX_FILES) return sendJson(res, 400, { message: 'Invalid body' });
    for (const f of files) {
      if (!f || typeof f.id !== 'string' || typeof f.fileName !== 'string' || !Number.isFinite(f.size) || f.size < 0) {
        return sendJson(res, 400, { message: 'Invalid body' });
      }
    }
    if (this.session || this.pending.size) return sendJson(res, 409, { message: 'Blocked by another session' });

    const marker = {};
    this.pending.add(marker);
    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) ac.abort();
    });

    const sender = { ...body.info, ip, deviceType: normalizeDeviceType(body.info.deviceType), port: body.info.port || 53317, protocol: body.info.protocol || 'https' };
    if (sender.fingerprint !== this.getInfo().fingerprint) this.onPeer(sender, 'register');

    let decision;
    try {
      decision = await Promise.race([
        this.decide({ sender, files, signal: ac.signal }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), DECISION_TIMEOUT_MS).unref?.()),
      ]);
    } catch {
      decision = { accept: false };
    } finally {
      this.pending.delete(marker);
    }
    if (ac.signal.aborted) return;
    if (!decision || !decision.accept) return sendJson(res, 403, { message: 'Rejected' });

    const accepted = new Set(decision.fileIds || files.map((f) => f.id));
    const destDir = decision.destination || this.getSettings().destination;
    fs.mkdirSync(destDir, { recursive: true });

    const sessionId = crypto.randomUUID();
    const isMessage = files.length === 1 && files[0].fileType === 'text/plain' && typeof files[0].preview === 'string' && !!files[0].preview;
    const session = {
      id: sessionId,
      direction: 'receive',
      sender,
      destDir,
      isMessage,
      status: 'transferring',
      startedAt: Date.now(),
      lastActivity: Date.now(),
      files: new Map(),
      streams: new Set(),
    };
    const tokens = {};
    for (const f of files) {
      if (!accepted.has(f.id)) continue;
      const token = crypto.randomBytes(16).toString('hex');
      tokens[f.id] = token;
      session.files.set(f.id, { meta: f, token, status: 'waiting', received: 0, savedPath: null });
    }
    if (!session.files.size) return sendJson(res, 403, { message: 'Rejected' });
    this.session = session;
    this.emit('session', session);
    sendJson(res, 200, { sessionId, files: tokens });
  }

  async _upload(req, res, url, ip) {
    const s = this.session;
    const q = url.searchParams;
    const fileId = q.get('fileId');
    const token = q.get('token');
    if (!s || q.get('sessionId') !== s.id || !fileId || !token) return sendJson(res, 400, { message: 'Missing parameters' });
    const entry = s.files.get(fileId);
    if (!entry || entry.token !== token || ip !== s.sender.ip) return sendJson(res, 403, { message: 'Invalid token or IP address' });
    if (entry.status !== 'waiting') return sendJson(res, 409, { message: 'Blocked by another session' });

    entry.status = 'receiving';
    entry.received = 0;
    s.lastActivity = Date.now();
    const hash = crypto.createHash('sha256');
    const chunks = [];
    const message = s.isMessage;

    let target = null;
    let partial = null;
    let sink;
    if (message) {
      const { Writable } = require('stream');
      sink = new Writable({ write(chunk, _e, cb) { if (entry.received <= 1024 * 1024) chunks.push(chunk); cb(); } });
    } else {
      const parts = safeRelativePath(entry.meta.fileName);
      target = uniquePath(resolveInside(s.destDir, parts));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      partial = target + '.lsp-part';
      sink = fs.createWriteStream(partial);
    }

    const counter = new Transform({
      transform: (chunk, _e, cb) => {
        entry.received += chunk.length;
        s.lastActivity = Date.now();
        hash.update(chunk);
        this.emit('progress', s);
        cb(null, chunk);
      },
    });

    s.streams.add(req);
    const cleanup = () => {
      s.streams.delete(req);
      if (partial) fs.rm(partial, { force: true, maxRetries: 10, retryDelay: 100 }, () => {});
    };

    await new Promise((resolve) => {
      pipeline(req, counter, sink, (err) => {
        s.streams.delete(req);
        if (err || s.status !== 'transferring') {
          entry.status = 'failed';
          cleanup();
          if (!res.headersSent && !res.destroyed) sendJson(res, 500, { message: 'Unknown error by receiver' });
          this._maybeFinish(s);
          return resolve();
        }
        const digest = hash.digest('hex');
        const expected = normalizeSha256(entry.meta.sha256);
        if ((expected && expected !== digest) || entry.received !== entry.meta.size) {
          entry.status = 'failed';
          cleanup();
          sendJson(res, expected && expected !== digest ? 422 : 400, { message: expected && expected !== digest ? 'Checksum mismatch (sha256)' : 'Size mismatch' });
          this._maybeFinish(s);
          return resolve();
        }
        const done = () => {
          entry.status = 'done';
          if (message) {
            entry.text = Buffer.concat(chunks).toString('utf8');
          } else {
            entry.savedPath = target;
          }
          res.writeHead(200);
          res.end();
          this.emit('file-done', s, entry);
          this._maybeFinish(s);
          resolve();
        };
        if (message) return done();
        fs.rename(partial, target, (e) => {
          if (e) {
            entry.status = 'failed';
            cleanup();
            sendJson(res, 500, { message: 'Unknown error by receiver' });
            this._maybeFinish(s);
            return resolve();
          }
          partial = null;
          this._applyTimestamps(target, entry.meta.metadata);
          done();
        });
      });
    });
  }

  _applyTimestamps(file, meta) {
    if (!meta || typeof meta !== 'object' || this.getSettings().preserveTimestamps === false) return;
    const modified = parseMetaDate(meta.modified);
    if (!modified) return;
    const accessed = parseMetaDate(meta.accessed) || modified;
    try { fs.utimesSync(file, accessed, modified); } catch { /* best effort */ }
  }

  _cancel(res, url, ip) {
    const s = this.session;
    if (s && url.searchParams.get('sessionId') === s.id && ip === s.sender.ip) this._endSession('cancelled');
    res.writeHead(200);
    res.end();
  }

  _maybeFinish(s) {
    if (this.session !== s) return;
    const all = [...s.files.values()];
    if (all.every((f) => f.status === 'done' || f.status === 'failed')) {
      this._endSession(all.some((f) => f.status === 'failed') ? 'error' : 'finished');
    }
  }

  _endSession(status) {
    const s = this.session;
    if (!s) return;
    this.session = null;
    s.status = status;
    s.endedAt = Date.now();
    for (const r of s.streams) r.destroy();
    s.streams.clear();
    this.emit('session-end', s);
  }

  cancelActive() {
    this._endSession('cancelled');
  }

  _checkIdle() {
    const s = this.session;
    if (s && Date.now() - s.lastActivity > SESSION_IDLE_MS) this._endSession('error');
  }

  destroy() {
    clearInterval(this._idleTimer);
    return this.stop();
  }
}

module.exports = { ReceiveServer, API };

