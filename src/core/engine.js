'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { Store, machineName } = require('./store');
const { loadIdentity } = require('./identity');
const net = require('./network');
const { ReceiveServer } = require('./server');
const { ShareManager } = require('./share');
const { VERSION, normalizeDeviceType } = require('./protocol');
const { Discovery } = require('./discovery');
const { register, sweep, ipRange } = require('./scanner');
const sender = require('./sender');

const MAX_HISTORY = 500;

function deviceModelName() {
  return { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[process.platform] || os.platform();
}

class Engine extends EventEmitter {
  constructor({ dir, overrides = {}, deviceType = 'desktop', identityKey = '' }) {
    super();
    this.dir = dir;
    this.deviceType = deviceType;
    this.store = new Store(dir);
    if (Object.keys(overrides).length) this.store.patch(overrides);
    this.identity = loadIdentity(dir, identityKey);
    this.devices = new Map();
    this.transfers = new Map();
    this.pendingRequests = new Map();
    this.history = this._loadHistory();
    this.scan = { running: false, phase: '', label: '', done: 0, total: 0, found: 0, errors: [], networks: {} };
    this._scanAbort = null;
    this._timers = [];
    this._emitTimers = {};
    this._interfacesCache = [];
    this.shareRequests = new Map();
    this._shareHistory = new Map();

    this.share = new ShareManager({ getInfo: () => this.getInfo(), ask: (c) => this._askShare(c) });
    this.share.on('change', () => {
      if (!this.share.active) {
        for (const [id, p] of this.shareRequests) {
          p.resolve(false);
          this.emit('share-request-cancel', id);
        }
        this.shareRequests.clear();
        this._shareHistory.clear();
      }
      this.emit('share', this.shareState());
      this.discovery?.announce();
    });
    this.share.on('file-done', (d) => this._onShareDownload(d));
    this.share.on('error', (e) => this.emit('error', e));

    this.server = new ReceiveServer({
      identity: this.identity,
      share: this.share,
      getInfo: () => this.getInfo(),
      getSettings: () => this.store.get(),
      onPeer: (peer, source) => this.addPeer(peer, source),
      decide: (req) => this._decide(req),
    });
    this.server.on('session', (s) => this._onSession(s));
    this.server.on('progress', (s) => this._onSessionProgress(s));
    this.server.on('file-done', (s, f) => this._onSessionProgress(s, true));
    this.server.on('session-end', (s) => this._onSessionEnd(s));
    this.server.on('error', (e) => this.emit('error', e));

    this.discovery = new Discovery({ getInfo: () => this.getInfo(), getSettings: () => this.store.get() });
    this.discovery.on('peer', (p, src) => this.addPeer(p, src));
    this.discovery.on('error', (e) => this.emit('error', e));
    this.discovery.on('interfaces-changed', () => {
      this._refreshInterfaces();
      this._emitSoon('interfaces');
    });
  }

  // ------------------------------------------------------------ lifecycle
  async start() {
    this._refreshInterfaces();
    await this._startServer();
    await this.discovery.start();
    this.discovery.announce();
    this._emitSoon('interfaces');
    this._timers.push(setInterval(() => this._keepAlive(), 60_000));
    this._scheduleRescan();
    // Adapter descriptions (used to recognise VPN clients) come from PowerShell, which can be slow.
    net.refreshAdapters().then(() => {
      this._refreshInterfaces();
      this._emitSoon('interfaces');
    }).catch(() => {});
    this.scanNow({ quick: true }).catch(() => {});
  }

  async stop() {
    this._timers.forEach(clearInterval);
    this._timers = [];
    this._scanAbort?.abort();
    await this.share.stop();
    await this.discovery.stop();
    await this.server.destroy();
    this.store.flush();
  }

  async _startServer() {
    const port = this.store.get('port');
    try {
      await this.server.start();
      this.serverError = null;
    } catch (e) {
      this.serverError = e.code === 'EADDRINUSE'
        ? `Port ${port} is already in use - LocalSend or another LocalSendPlus may be running. Choose a different port under Settings > Network.`
        : e.message;
    }
    this.emit('server-status', this.serverError);
  }

  _scheduleRescan() {
    clearInterval(this._rescanTimer);
    const mins = Math.max(1, this.store.get('discovery').rescanMinutes || 5);
    this._rescanTimer = setInterval(() => {
      this.discovery.announce();
      if (!this.scan.running) this.scanNow({ background: true }).catch(() => {});
    }, mins * 60_000);
    this._rescanTimer.unref?.();
  }

  // ------------------------------------------------------------ identity / info
  _refreshInterfaces() {
    this._interfacesCache = net.listInterfaces({ deny: this.store.get('interfaceFilter').deny });
    return this._interfacesCache;
  }

  interfaces() {
    return this._interfacesCache;
  }

  getInfo() {
    const s = this.store.get();
    return {
      alias: s.alias,
      version: VERSION,
      deviceModel: deviceModelName(),
      deviceType: this.deviceType || 'desktop',
      fingerprint: this.identity.fingerprint,
      port: s.port,
      protocol: s.protocol,
      download: !!this.share?.active,
    };
  }

  _isSelf(ip, port) {
    return port === this.store.get('port') && this._interfacesCache.some((i) => i.address === ip);
  }

  // ------------------------------------------------------------ devices
  netOf(ip) {
    for (const i of this._interfacesCache) {
      if (net.inCidr(ip, i.cidr)) {
        return i.kind === 'vpn'
          ? { kind: 'vpn', label: `VPN (${i.name})` }
          : { kind: 'lan', label: 'Local network' };
      }
    }
    for (const n of this.store.get('networks')) {
      for (const part of String(n.cidr).split(/[,\s]+/).filter(Boolean)) {
        const t = net.parseTarget(part);
        const v = net.ipToInt(ip);
        if (t && v !== null && v >= t.start && v <= t.end) return { kind: n.kind === 'vpn' ? 'vpn' : 'routed', label: n.name || n.cidr };
      }
    }
    return net.isPrivate(ip) ? { kind: 'routed', label: 'Routed network' } : { kind: 'remote', label: 'Remote' };
  }

  addPeer(peer, source) {
    if (!peer || !peer.alias || !peer.ip) return null;
    const port = peer.port || 53317;
    if (peer.fingerprint === this.identity.fingerprint || this._isSelf(peer.ip, port)) return null;
    const id = peer.fingerprint || `${peer.ip}:${port}`;
    const now = Date.now();
    const prev = this.devices.get(id);
    const dev = {
      id,
      alias: peer.alias,
      deviceModel: peer.deviceModel || null,
      deviceType: normalizeDeviceType(peer.deviceType),
      fingerprint: peer.fingerprint || null,
      ip: peer.ip,
      port,
      protocol: peer.protocol || prev?.protocol || 'https',
      version: peer.version || null,
      source: prev && prev.source === 'manual' ? 'manual' : source,
      net: this.netOf(peer.ip),
      rtt: peer.rtt ?? prev?.rtt ?? null,
      lastSeen: now,
      missed: 0,
      online: true,
    };
    // Same device reachable through several routes: keep the lowest-latency one.
    if (prev && prev.ip !== dev.ip && prev.rtt != null && dev.rtt != null && now - prev.lastSeen < 120_000 && prev.rtt < dev.rtt) {
      dev.ip = prev.ip;
      dev.port = prev.port;
      dev.protocol = prev.protocol;
      dev.net = prev.net;
      dev.rtt = prev.rtt;
    }
    this.devices.set(id, dev);
    const fav = this.store.get('favorites').find((f) => f.fingerprint && f.fingerprint === dev.fingerprint);
    if (fav && (fav.ip !== dev.ip || fav.port !== dev.port)) {
      fav.ip = dev.ip;
      fav.port = dev.port;
      this.store.patch({ favorites: this.store.get('favorites') });
    }
    if (!prev) this._emitSoon('devices');
    else if (prev.ip !== dev.ip || prev.alias !== dev.alias || prev.online === false) this._emitSoon('devices');
    return dev;
  }

  deviceList() {
    const favs = this.store.get('favorites');
    const out = [...this.devices.values()].map((d) => ({ ...d, favorite: favs.some((f) => f.fingerprint && f.fingerprint === d.fingerprint) }));
    for (const f of favs) {
      if (!out.some((d) => d.fingerprint === f.fingerprint)) {
        out.push({ id: f.fingerprint, alias: f.alias, ip: f.ip, port: f.port, protocol: 'https', fingerprint: f.fingerprint, deviceType: f.deviceType || 'desktop', favorite: true, online: false, net: this.netOf(f.ip || '0.0.0.0'), source: 'favorite' });
      }
    }
    const rank = { lan: 0, vpn: 1, remote: 2, routed: 2 };
    return out.sort((a, b) => Number(b.online) - Number(a.online) || Number(b.favorite) - Number(a.favorite) || (rank[a.net.kind] ?? 3) - (rank[b.net.kind] ?? 3) || a.alias.localeCompare(b.alias));
  }

  toggleFavorite(id) {
    const d = this.devices.get(id) || this.deviceList().find((x) => x.id === id);
    if (!d || !d.fingerprint) return;
    const favs = this.store.get('favorites');
    const idx = favs.findIndex((f) => f.fingerprint === d.fingerprint);
    if (idx >= 0) favs.splice(idx, 1);
    else favs.push({ fingerprint: d.fingerprint, alias: d.alias, ip: d.ip, port: d.port, deviceType: d.deviceType });
    this.store.patch({ favorites: favs });
    this._emitSoon('devices');
  }

  async addHost(host, port) {
    const p = Number(port) || 53317;
    let ip = host.trim();
    if (!net.parseTarget(ip) || ip.includes('-') || ip.includes('/')) {
      const r = await dns.promises.lookup(ip, { family: 4 }).catch(() => null);
      if (!r) throw new Error(`Cannot resolve "${host}"`);
      ip = r.address;
    }
    const dev = await register({ ip, port: p }, this.getInfo(), 4000);
    if (!dev) throw new Error(`No LocalSendPlus or LocalSend device answered at ${host}:${p}`);
    const d = this.addPeer(dev, 'manual');
    const hosts = this.store.get('hosts');
    if (!hosts.some((h) => h.host === host.trim() && (h.port || 53317) === p)) {
      hosts.push({ id: crypto.randomUUID(), host: host.trim(), port: p, alias: dev.alias });
      this.store.patch({ hosts });
    }
    this._emitSoon('devices');
    return d;
  }

  async _keepAlive() {
    const now = Date.now();
    for (const d of [...this.devices.values()]) {
      if (now - d.lastSeen < 150_000) continue;
      const r = await register({ ip: d.ip, port: d.port, protocol: d.protocol }, this.getInfo(), 2500);
      if (r) {
        this.addPeer(r, d.source);
      } else {
        d.missed++;
        if (d.missed >= 2) {
          this.devices.delete(d.id);
          this._emitSoon('devices');
        }
      }
    }
  }

  // ------------------------------------------------------------ scanning
  _localTargets() {
    const targets = [];
    for (const i of this._interfacesCache) {
      if (i.kind === 'virtual') continue;
      let c = net.parseCidr(i.cidr);
      if (c.size > 1024) c = net.parseCidr(`${i.address.split('.').slice(0, 3).join('.')}.0/24`);
      targets.push({ label: i.kind === 'vpn' ? `VPN adapter ${i.name}` : `Local network ${c.cidr}`, start: c.start + 1, end: c.end - 1, count: c.size - 2 });
    }
    return targets;
  }

  _networkTargets() {
    const out = [];
    const errors = [];
    const max = this.store.get('discovery').maxHostsPerNetwork;
    for (const n of this.store.get('networks')) {
      if (!n.enabled) continue;
      for (const part of String(n.cidr).split(/[,\s]+/).filter(Boolean)) {
        const t = net.parseTarget(part);
        if (!t) {
          errors.push(`${n.name || n.cidr}: "${part}" is not a valid CIDR, range or IP`);
          continue;
        }
        if (t.count > max) {
          errors.push(`${n.name || part}: ${t.count.toLocaleString()} hosts exceeds the limit of ${max.toLocaleString()}`);
          continue;
        }
        out.push({ ...t, label: n.name || t.label, networkId: n.id });
      }
    }
    return { targets: out, errors };
  }

  async scanNow({ quick = false, background = false, only = null } = {}) {
    this._scanAbort?.abort();
    const ac = new AbortController();
    this._scanAbort = ac;
    const s = this.store.get();
    this._refreshInterfaces();
    this.discovery.syncMemberships();
    if (!background) this.discovery.announce();

    const plan = [];
    const errors = [];
    if (!only && s.discovery.scanLocalSubnets) plan.push(...this._localTargets());
    if (s.discovery.scanRemote || only) {
      const nt = this._networkTargets();
      errors.push(...nt.errors);
      plan.push(...nt.targets.filter((t) => !only || t.networkId === only));
    }
    const hosts = only ? [] : s.hosts;
    const total = plan.reduce((a, t) => a + t.count, 0) + hosts.length;
    this.scan = { ...this.scan, running: true, phase: 'scan', label: '', done: 0, total, found: 0, errors, startedAt: Date.now() };
    this._emitSoon('scan', 0);
    let base = 0;
    let found = 0;
    const isSelf = (ip, port) => this._isSelf(ip, port);
    const ports = [...new Set([...(s.discovery.scanPorts || [53317]), s.port])];
    const dcfg = s.discovery;

    try {
      for (const t of hosts) {
        if (ac.signal.aborted) break;
        this.scan.label = `${t.host}`;
        const r = await dns.promises.lookup(t.host, { family: 4 }).catch(() => null);
        const ip = r ? r.address : t.host;
        const dev = await register({ ip, port: t.port || 53317 }, this.getInfo(), 3000);
        if (dev) { this.addPeer(dev, 'manual'); found++; }
        base++;
        this.scan.done = base;
        this.scan.found = found;
      }
      for (const t of plan) {
        if (ac.signal.aborted) break;
        this.scan.label = t.label;
        const before = base;
        const n = await sweep({
          targets: ipRange(t.start, t.end),
          ports,
          info: this.getInfo(),
          concurrency: quick ? Math.min(128, dcfg.concurrency) : dcfg.concurrency,
          timeout: dcfg.timeoutMs,
          signal: ac.signal,
          total: t.count,
          isSelf,
          onFound: (dev) => { this.addPeer(dev, 'scan'); },
          onProgress: (p) => {
            this.scan.done = before + p.done;
            this.scan.found = found + p.found;
            this._emitSoon('scan', 250);
          },
        });
        found += n;
        base += t.count;
        if (t.networkId) {
          this.scan.networks[t.networkId] = { lastScan: Date.now(), found: n, hosts: t.count };
        }
      }
    } finally {
      if (this._scanAbort === ac) {
        this.scan = { ...this.scan, running: false, phase: '', label: '', done: this.scan.total, found };
        this._emitSoon('scan', 0);
      }
    }
    return found;
  }

  cancelScan() {
    this._scanAbort?.abort();
    this.scan = { ...this.scan, running: false };
    this._emitSoon('scan', 0);
  }

  async suggestNetworks() {
    const list = await net.suggestNetworks({ deny: this.store.get('interfaceFilter').deny });
    const have = new Set(this.store.get('networks').map((n) => n.cidr));
    return list.map((s) => ({ ...s, added: have.has(s.cidr) }));
  }

  // ------------------------------------------------------------ receiving
  async _decide({ sender: from, files, signal }) {
    const s = this.store.get();
    const fav = s.favorites.some((f) => f.fingerprint && f.fingerprint === from.fingerprint);
    const quick = s.quickSave === 'on' || (s.quickSave === 'favorites' && fav);
    if (quick) return { accept: true };

    const id = crypto.randomUUID();
    const total = files.reduce((a, f) => a + f.size, 0);
    const msg = files.length === 1 && files[0].fileType === 'text/plain' && files[0].preview;
    const request = {
      id,
      sender: { alias: from.alias, ip: from.ip, deviceModel: from.deviceModel, deviceType: from.deviceType || 'desktop', net: this.netOf(from.ip), favorite: fav },
      count: files.length,
      totalSize: total,
      isMessage: !!msg,
      preview: msg ? String(files[0].preview).slice(0, 2000) : null,
      files: files.slice(0, 100).map((f) => ({ name: f.fileName, size: f.size, type: f.fileType })),
      destination: s.destination,
      askForDestination: s.askForDestination,
      time: Date.now(),
    };
    return new Promise((resolve) => {
      this.pendingRequests.set(id, { resolve, request });
      signal.addEventListener('abort', () => {
        if (this.pendingRequests.delete(id)) this.emit('receive-request-cancel', id);
        resolve({ accept: false });
      }, { once: true });
      this.emit('receive-request', request);
    });
  }

  respondReceive(id, { accept, destination }) {
    const p = this.pendingRequests.get(id);
    if (!p) return;
    this.pendingRequests.delete(id);
    p.resolve({ accept: !!accept, destination: destination || undefined });
  }

  _transferFromSession(s) {
    return {
      id: s.id,
      direction: 'receive',
      peer: { alias: s.sender.alias, ip: s.sender.ip, deviceType: s.sender.deviceType || 'desktop', net: this.netOf(s.sender.ip) },
      status: s.status,
      isMessage: s.isMessage,
      destination: s.destDir,
      startedAt: s.startedAt,
      endedAt: s.endedAt || null,
      files: [...s.files.values()].map((f) => ({ id: f.meta.id, name: f.meta.fileName, size: f.meta.size, done: f.received, status: f.status, path: f.savedPath })),
    };
  }

  _onSession(s) {
    const t = this._transferFromSession(s);
    t.speed = 0;
    this.transfers.set(t.id, t);
    this._emitTransfer(t, true);
  }

  _onSessionProgress(s, force) {
    const t = this.transfers.get(s.id);
    if (!t) return;
    const files = [...s.files.values()];
    t.files = files.map((f) => ({ id: f.meta.id, name: f.meta.fileName, size: f.meta.size, done: f.received, status: f.status, path: f.savedPath }));
    this._speed(t);
    this._emitTransfer(t, force);
  }

  _onSessionEnd(s) {
    const t = this.transfers.get(s.id) || this._transferFromSession(s);
    this.transfers.set(t.id, t);
    t.status = s.status;
    t.endedAt = Date.now();
    t.files = [...s.files.values()].map((f) => ({ id: f.meta.id, name: f.meta.fileName, size: f.meta.size, done: f.received, status: f.status, path: f.savedPath }));
    const msgEntry = s.isMessage ? [...s.files.values()][0] : null;
    if (msgEntry && msgEntry.text != null) t.text = msgEntry.text;
    t.speed = 0;
    this._emitTransfer(t, true);
    const ok = t.files.filter((f) => f.status === 'done');
    if (ok.length || msgEntry?.text) {
      this._addHistory({
        direction: 'receive',
        peer: t.peer,
        status: t.status,
        kind: msgEntry ? 'text' : 'files',
        text: msgEntry?.text,
        count: ok.length,
        size: ok.reduce((a, f) => a + f.size, 0),
        files: ok.slice(0, 200).map((f) => ({ name: f.name, size: f.size, path: f.path })),
        destination: s.destDir,
      });
    }
    if (msgEntry?.text != null) this.emit('message-received', { text: msgEntry.text, peer: t.peer });
    this.emit('receive-complete', t);
    this._pruneTransfers();
  }

  cancelTransfer(id) {
    const t = this.transfers.get(id);
    if (!t) return;
    if (t.direction === 'receive') this.server.cancelActive();
    else if (t.status === 'pin-required') {
      t.status = 'cancelled';
      t.endedAt = Date.now();
      this._emitTransfer(t, true);
    } else t._abort?.abort();
  }

  // ------------------------------------------------------------ sending
  async send(deviceId, items, { pin } = {}) {
    const dev = this.devices.get(deviceId) || this.deviceList().find((d) => d.id === deviceId);
    if (!dev || !dev.ip) throw new Error('Device not found');
    const id = crypto.randomUUID();
    const ac = new AbortController();
    const t = {
      id,
      direction: 'send',
      peer: { alias: dev.alias, ip: dev.ip, deviceType: dev.deviceType, net: dev.net },
      status: 'preparing',
      startedAt: Date.now(),
      files: [],
      speed: 0,
      _abort: ac,
      _items: items,
      _deviceId: dev.id,
    };
    this.transfers.set(id, t);
    this._emitTransfer(t, true);
    this._runSend(t, dev, pin).catch(() => {});
    return id;
  }

  async retrySend(id, pin) {
    const t = this.transfers.get(id);
    if (!t || t.direction !== 'send') return;
    const dev = this.devices.get(t._deviceId) || this.deviceList().find((d) => d.id === t._deviceId);
    t._abort = new AbortController();
    t.status = 'preparing';
    t.error = null;
    this._emitTransfer(t, true);
    this._runSend(t, dev, pin).catch(() => {});
  }

  async _runSend(t, dev, pin) {
    try {
      if (!t._entries) {
        t._entries = await sender.expandItems(t._items);
        if (!t._entries.length) throw new sender.SendError('empty', 'Nothing to send');
      }
      const entries = t._entries;
      t.files = entries.map((e) => ({ id: e.id, name: e.fileName, size: e.size, done: 0, status: 'waiting', preview: e.preview ? e.preview.slice(0, 120) : undefined }));
      t.isMessage = entries.length === 1 && !!entries[0].preview;
      const byId = new Map(t.files.map((f) => [f.id, f]));
      this._emitTransfer(t, true);
      const hooks = {
        status: (st) => { t.status = st; this._emitTransfer(t, true); },
        file: (fid, st) => { const f = byId.get(fid); if (f) { f.status = st; if (st === 'done') f.done = f.size; } this._emitTransfer(t, st !== 'sending'); },
        bytes: (fid, n) => { const f = byId.get(fid); if (f) f.done += n; this._speed(t); this._emitTransfer(t); },
      };
      await sender.sendEntries({ device: dev, info: this.getInfo(), entries, pin, hooks, signal: t._abort.signal, checksums: this.store.get('checksums') });
      t.status = 'finished';
    } catch (err) {
      t.error = err.message;
      t.errorCode = err.code;
      t.status = err.code === 'pin' ? 'pin-required' : err.code === 'cancelled' ? 'cancelled' : err.code === 'declined' ? 'declined' : 'error';
    }
    t.speed = 0;
    if (t.status !== 'pin-required') t.endedAt = Date.now();
    this._emitTransfer(t, true);
    if (t.status === 'pin-required') return;
    const done = t.files.filter((f) => f.status === 'done');
    if (done.length) {
      this._addHistory({
        direction: 'send',
        peer: t.peer,
        status: t.status,
        kind: t.isMessage ? 'text' : 'files',
        text: t.isMessage ? t._entries[0].preview : undefined,
        count: done.length,
        size: done.reduce((a, f) => a + f.size, 0),
        files: done.slice(0, 200).map((f) => ({ name: f.name, size: f.size })),
      });
    }
    t._entries = null;
    this._pruneTransfers();
  }

  // ------------------------------------------------------------ transfer plumbing
  _speed(t) {
    const done = t.files.reduce((a, f) => a + f.done, 0);
    const now = Date.now();
    if (!t._lastSample) {
      t._lastSample = { at: now, done };
      return;
    }
    const dt = now - t._lastSample.at;
    if (dt >= 500) {
      const inst = ((done - t._lastSample.done) / dt) * 1000;
      t.speed = t.speed ? t.speed * 0.6 + inst * 0.4 : inst;
      t._lastSample = { at: now, done };
    }
  }

  _publicTransfer(t) {
    const { _abort, _items, _entries, _lastSample, _deviceId, ...pub } = t;
    pub.total = t.files.reduce((a, f) => a + f.size, 0);
    pub.done = t.files.reduce((a, f) => a + f.done, 0);
    pub.fileCount = t.files.length;
    // The UI only needs per-file rows for small transfers; large folders are summarised.
    if (pub.files.length > 200) pub.files = pub.files.filter((f) => f.status === 'sending' || f.status === 'receiving').concat(pub.files.slice(0, 50));
    return pub;
  }

  _emitTransfer(t, immediate) {
    if (immediate) {
      clearTimeout(this._emitTimers['t' + t.id]);
      this._emitTimers['t' + t.id] = null;
      this.emit('transfer', this._publicTransfer(t));
      return;
    }
    if (this._emitTimers['t' + t.id]) return;
    this._emitTimers['t' + t.id] = setTimeout(() => {
      this._emitTimers['t' + t.id] = null;
      this.emit('transfer', this._publicTransfer(t));
    }, 120);
  }

  _emitSoon(kind, delay = 120) {
    if (this._emitTimers[kind]) return;
    this._emitTimers[kind] = setTimeout(() => {
      this._emitTimers[kind] = null;
      if (kind === 'devices') this.emit('devices', this.deviceList());
      else if (kind === 'scan') this.emit('scan', this.scan);
      else if (kind === 'interfaces') this.emit('interfaces', this._interfacesCache);
    }, delay);
  }

  _pruneTransfers() {
    const finished = [...this.transfers.values()].filter((t) => t.endedAt).sort((a, b) => b.endedAt - a.endedAt);
    for (const t of finished.slice(20)) this.transfers.delete(t.id);
  }

  // ------------------------------------------------------------ history
  _historyFile() {
    return path.join(this.dir, 'history.json');
  }

  _loadHistory() {
    try {
      return JSON.parse(fs.readFileSync(this._historyFile(), 'utf8'));
    } catch {
      return [];
    }
  }

  _addHistory(entry) {
    if (!this.store.get('saveHistory')) return;
    const e = { id: crypto.randomUUID(), time: Date.now(), ...entry, peer: { alias: entry.peer.alias, ip: entry.peer.ip, deviceType: entry.peer.deviceType } };
    this.history.unshift(e);
    this.history.length = Math.min(this.history.length, MAX_HISTORY);
    this._saveHistory();
    this.emit('history', this.history);
    return e;
  }

  _updateHistory() {
    this._saveHistory();
    this.emit('history', this.history);
  }

  _saveHistory() {
    clearTimeout(this._histTimer);
    this._histTimer = setTimeout(() => fs.writeFile(this._historyFile(), JSON.stringify(this.history), () => {}), 300);
  }

  deleteHistory(id) {
    this.history = id ? this.history.filter((h) => h.id !== id) : [];
    this._saveHistory();
    this.emit('history', this.history);
  }

  // ------------------------------------------------------------ share via link (protocol section 5, Download API)
  async startShare(items, { pin = '', autoAccept = false, expiresMinutes = 60 } = {}) {
    const entries = await sender.expandItems(items);
    if (!entries.length) throw new Error('Nothing to share');
    await this.share.start({ entries, pin, autoAccept, expiresMinutes, port: this.store.get('sharePort') });
    return this.shareState();
  }

  async stopShare() {
    await this.share.stop();
  }

  shareState() {
    const st = this.share.publicState();
    const rank = { lan: 0, vpn: 1 };
    st.urls = st.active
      ? [...this._interfacesCache].sort((a, b) => (rank[a.kind] ?? 2) - (rank[b.kind] ?? 2)).map((i) => ({ url: `http://${i.address}:${st.port}`, name: i.name, kind: i.kind }))
      : [];
    st.requests = [...this.shareRequests.values()].map((r) => r.request);
    return st;
  }

  _askShare({ ip, userAgent }) {
    const id = crypto.randomUUID();
    const request = { id, ip, userAgent, net: this.netOf(ip), time: Date.now() };
    return new Promise((resolve) => {
      this.shareRequests.set(id, { resolve, request });
      this.emit('share-request', request);
      this.emit('share', this.shareState());
    });
  }

  respondShare(id, accept) {
    const p = this.shareRequests.get(id);
    if (!p) return;
    this.shareRequests.delete(id);
    p.resolve(!!accept);
    this.emit('share', this.shareState());
  }

  _onShareDownload({ sessionId, ip, entry }) {
    let rec = this._shareHistory.get(sessionId);
    if (rec) {
      rec.count += 1;
      rec.size += entry.size;
      rec.files.push({ name: entry.fileName, size: entry.size });
      this._updateHistory(rec);
      return;
    }
    rec = this._addHistory({ direction: 'send', peer: { alias: 'Web download', ip, deviceType: 'web' }, status: 'finished', kind: 'files', count: 1, size: entry.size, files: [{ name: entry.fileName, size: entry.size }] });
    if (rec) this._shareHistory.set(sessionId, rec);
  }

  // ------------------------------------------------------------ settings
  async updateSettings(patch) {
    const before = this.store.get();
    const restartNet = ['port', 'protocol', 'multicastAddress', 'multicastPort'].some((k) => k in patch && patch[k] !== before[k]) ||
      (patch.discovery && 'multicast' in patch.discovery && patch.discovery.multicast !== before.discovery.multicast) ||
      (patch.interfaceFilter && JSON.stringify(patch.interfaceFilter.deny) !== JSON.stringify(before.interfaceFilter.deny));
    if (patch.alias !== undefined) {
      const typed = String(patch.alias).trim().slice(0, 40);
      // An empty name goes back to following the computer name.
      patch.alias = typed || machineName();
      patch.aliasCustom = !!typed && typed !== machineName();
    }
    const aliasChanged = 'alias' in patch && patch.alias !== before.alias;
    if (patch.port !== undefined) patch.port = Math.min(65535, Math.max(1024, Number(patch.port) || 53317));
    if (patch.sharePort !== undefined) patch.sharePort = Math.min(65500, Math.max(1024, Number(patch.sharePort) || 53318));
    if (patch.checksums !== undefined && !['off', 'auto', 'always'].includes(patch.checksums)) delete patch.checksums;
    if (patch.multicastPort !== undefined) patch.multicastPort = Math.min(65535, Math.max(1024, Number(patch.multicastPort) || 53317));
    this.store.patch(patch);
    this._refreshInterfaces();
    if (restartNet) {
      await this._startServer();
      await this.discovery.start();
      this.discovery.announce();
    } else if (aliasChanged) {
      this.discovery.announce();
    }
    if (patch.discovery && 'rescanMinutes' in patch.discovery) this._scheduleRescan();
    this._emitSoon('devices');
    this.emit('settings', this.publicSettings());
  }

  publicSettings() {
    const s = { ...this.store.get() };
    delete s._dir;
    return s;
  }

  // ------------------------------------------------------------ state for UI
  getState() {
    return {
      info: this.getInfo(),
      settings: this.publicSettings(),
      devices: this.deviceList(),
      transfers: [...this.transfers.values()].map((t) => this._publicTransfer(t)),
      history: this.history,
      scan: this.scan,
      interfaces: this._interfacesCache,
      requests: [...this.pendingRequests.values()].map((p) => p.request),
      serverError: this.serverError || null,
      share: this.shareState(),
    };
  }
}

module.exports = { Engine };
