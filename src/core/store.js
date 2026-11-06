'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');

const ADJECTIVES = ['Nice', 'Secret', 'Happy', 'Brave', 'Calm', 'Swift', 'Bright', 'Clever', 'Gentle', 'Lucky', 'Quiet', 'Sunny', 'Witty', 'Bold', 'Cosmic', 'Rapid'];
const NOUNS = ['Orange', 'Banana', 'Mango', 'Cherry', 'Falcon', 'Otter', 'Maple', 'Comet', 'River', 'Pepper', 'Walnut', 'Lynx', 'Panda', 'Harbor', 'Ember', 'Pixel'];

function randomAlias() {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const n = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${a} ${n}`;
}

// The device name defaults to the computer's own name (what LocalSend shows for a PC).
function machineName() {
  return String(os.hostname() || '').trim().slice(0, 40) || randomAlias();
}

function isLegacyRandomAlias(alias) {
  const [a, n, ...rest] = String(alias || '').split(' ');
  return !rest.length && ADJECTIVES.includes(a) && NOUNS.includes(n);
}

function defaults(dir) {
  return {
    alias: machineName(),
    aliasCustom: false, // false: always follow the computer name
    port: 53317,
    multicastAddress: '224.0.0.167',
    multicastPort: 53317,
    protocol: 'https',
    quickSave: 'off', // off | favorites | on
    destination: path.join(os.homedir(), 'Downloads', 'LocalSendPlus'),
    askForDestination: false,
    pin: '',
    autoFinish: false,
    autoCopyText: false,
    checksums: 'auto', // off | auto (files up to 64 MB) | always - sha256 sent with each file
    preserveTimestamps: true,
    sharePort: 53318,
    saveHistory: true,
    theme: 'system', // system | light | dark | oled
    accent: 'teal',
    minimizeToTray: true,
    startMinimized: false,
    launchAtLogin: false,
    notifications: true,
    animations: true,
    sendMode: 'single', // single | multiple
    discovery: {
      multicast: true,
      scanLocalSubnets: true,
      scanRemote: true,
      rescanMinutes: 5,
      concurrency: 256,
      timeoutMs: 900,
      scanPorts: [53317],
      maxHostsPerNetwork: 65536,
    },
    interfaceFilter: { deny: [] },
    networks: [], // {id, name, cidr, enabled, auto}
    hosts: [], // {id, host, port, alias}
    favorites: [], // {fingerprint, alias, ip, port}
    firstRun: true,
    _dir: dir,
  };
}

class Store extends EventEmitter {
  constructor(dir) {
    super();
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'settings.json');
    this.data = defaults(dir);
    this._load();
    this._timer = null;
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      // Settings saved by earlier versions have no aliasCustom flag: a generated name like "Nice Orange"
      // is replaced by the computer name, while a name the user typed is kept.
      if (raw.aliasCustom === undefined) raw.aliasCustom = !!raw.alias && !isLegacyRandomAlias(raw.alias);
      this.data = deepMerge(defaults(this.dir), raw);
      if (!this.data.aliasCustom) {
        this.data.alias = machineName();
        if (raw.alias !== this.data.alias || raw.aliasCustom === undefined) this._save();
      }
    } catch {
      this._save();
    }
  }

  _save() {
    clearTimeout(this._timer);
    const tmp = this.file + '.tmp';
    const out = { ...this.data };
    delete out._dir;
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
    fs.renameSync(tmp, this.file);
  }

  get(key) {
    return key ? this.data[key] : this.data;
  }

  patch(partial) {
    this.data = deepMerge(this.data, partial);
    // arrays are replaced wholesale, not merged
    for (const [k, v] of Object.entries(partial)) {
      if (Array.isArray(v)) this.data[k] = v;
      else if (v && typeof v === 'object') {
        for (const [k2, v2] of Object.entries(v)) if (Array.isArray(v2)) this.data[k][k2] = v2;
      }
    }
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._save(), 200);
    this.emit('change', this.data, partial);
    return this.data;
  }

  flush() {
    this._save();
  }
}

function deepMerge(base, extra) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

module.exports = { Store, randomAlias, machineName };
