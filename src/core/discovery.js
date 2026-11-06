'use strict';
const dgram = require('dgram');
const { EventEmitter } = require('events');
const { listInterfaces } = require('./network');
const { register, ownBody } = require('./scanner');

// UDP multicast discovery (LocalSend v2).
// One receive socket joined to the group on every IPv4 adapter, plus one send socket per adapter
// (bound to that adapter's address) so announcements leave through LAN, Wi-Fi and VPN adapters alike.
class Discovery extends EventEmitter {
  constructor({ getInfo, getSettings }) {
    super();
    this.getInfo = getInfo;
    this.getSettings = getSettings;
    this.socket = null;
    this.tx = new Map();
    this.joined = new Set();
    this._poll = null;
  }

  async start() {
    await this.stop();
    const s = this.getSettings();
    if (!s.discovery.multicast) return;
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = sock;
    sock.on('message', (msg, rinfo) => this._onMessage(msg, rinfo));
    sock.on('error', (e) => this.emit('error', e));
    await new Promise((resolve, reject) => {
      sock.once('error', reject);
      sock.bind(s.multicastPort, '0.0.0.0', () => {
        sock.off('error', reject);
        try { sock.setMulticastTTL(8); sock.setMulticastLoopback(true); } catch { /* ignore */ }
        resolve();
      });
    }).catch((e) => {
      this.emit('error', e);
      this.socket = null;
    });
    if (!this.socket) return;
    await this.syncMemberships();
    this._poll = setInterval(() => this.syncMemberships(true), 8000);
    this._poll.unref?.();
  }

  async stop() {
    clearInterval(this._poll);
    this.joined.clear();
    for (const t of this.tx.values()) { try { t.close(); } catch { /* closed */ } }
    this.tx.clear();
    if (!this.socket) return;
    const s = this.socket;
    this.socket = null;
    await new Promise((r) => s.close(() => r()));
  }

  _ifaces() {
    return listInterfaces({ deny: this.getSettings().interfaceFilter.deny });
  }

  _makeTx(address) {
    return new Promise((resolve) => {
      const t = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      t.on('error', () => { try { t.close(); } catch { /* closed */ } this.tx.delete(address); });
      t.on('message', (msg, rinfo) => this._onMessage(msg, rinfo));
      t.bind(0, address, () => {
        try { t.setMulticastInterface(address); t.setMulticastLoopback(true); t.setMulticastTTL(8); } catch { /* ignore */ }
        resolve(t);
      });
      t.once('error', () => resolve(null));
    });
  }

  async syncMemberships(announceOnChange) {
    if (!this.socket) return;
    const addr = this.getSettings().multicastAddress;
    const current = new Set();
    let changed = false;
    for (const i of this._ifaces()) {
      current.add(i.address);
      if (this.joined.has(i.address)) continue;
      try {
        this.socket.addMembership(addr, i.address);
        const t = await this._makeTx(i.address);
        if (!this.socket) return;
        if (t) this.tx.set(i.address, t);
        this.joined.add(i.address);
        changed = true;
      } catch {
        /* interface does not support multicast */
      }
    }
    for (const a of [...this.joined]) {
      if (!current.has(a)) {
        try { this.socket.dropMembership(addr, a); } catch { /* gone */ }
        try { this.tx.get(a)?.close(); } catch { /* closed */ }
        this.tx.delete(a);
        this.joined.delete(a);
        changed = true;
      }
    }
    if (changed) {
      this.emit('interfaces-changed');
      if (announceOnChange) this.announce();
    }
  }

  announce() {
    if (!this.socket) return;
    const s = this.getSettings();
    const payload = Buffer.from(JSON.stringify({ ...ownBody(this.getInfo()), announce: true }));
    const send = () => {
      for (const t of this.tx.values()) {
        try { t.send(payload, s.multicastPort, s.multicastAddress, () => {}); } catch { /* ignore */ }
      }
    };
    send();
    setTimeout(send, 300).unref?.();
    setTimeout(send, 1500).unref?.();
  }

  async _onMessage(msg, rinfo) {
    let m;
    try { m = JSON.parse(msg.toString('utf8')); } catch { return; }
    const info = this.getInfo();
    if (!m || typeof m.alias !== 'string' || m.fingerprint === info.fingerprint) return;
    const peer = { ...m, ip: rinfo.address, port: m.port || 53317, protocol: m.protocol || 'https' };
    delete peer.announce;
    this.emit('peer', peer, 'multicast');
    if (m.announce) {
      const dev = await register(peer, info, 2500);
      if (!dev && this.socket) {
        const reply = Buffer.from(JSON.stringify({ ...ownBody(info), announce: false }));
        this.socket.send(reply, rinfo.port, rinfo.address, () => {});
      }
    }
  }
}

module.exports = { Discovery };
