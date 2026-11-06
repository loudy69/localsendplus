'use strict';
const os = require('os');
const { execFile } = require('child_process');

// ---------- IPv4 helpers ----------
function ipToInt(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
function intToIp(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}
function prefixFromMask(mask) {
  const n = ipToInt(mask);
  if (n === null) return null;
  let bits = 0;
  for (let i = 31; i >= 0; i--) {
    if ((n >>> i) & 1) bits++;
    else break;
  }
  return bits;
}
function maskFromPrefix(prefix) {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}
function parseCidr(text) {
  const m = /^\s*(\d{1,3}(?:\.\d{1,3}){3})\s*\/\s*(\d{1,2})\s*$/.exec(text);
  if (!m) return null;
  const ip = ipToInt(m[1]);
  const prefix = Number(m[2]);
  if (ip === null || prefix > 32) return null;
  const mask = maskFromPrefix(prefix);
  const start = (ip & mask) >>> 0;
  const size = 2 ** (32 - prefix);
  return { start, end: start + size - 1, prefix, size, cidr: `${intToIp(start)}/${prefix}` };
}
function inCidr(ip, cidr) {
  const c = typeof cidr === 'string' ? parseCidr(cidr) : cidr;
  const n = ipToInt(ip);
  return !!c && n !== null && n >= c.start && n <= c.end;
}

// Accepts CIDR (10.8.0.0/24), a single IP, or a range (10.8.0.5-10.8.0.40 / 10.8.0.5-40).
function parseTarget(text) {
  const t = String(text || '').trim();
  const cidr = parseCidr(t);
  if (cidr) {
    const skipEdges = cidr.prefix <= 30;
    return { kind: 'cidr', start: cidr.start + (skipEdges ? 1 : 0), end: cidr.end - (skipEdges ? 1 : 0), label: cidr.cidr, count: cidr.size - (skipEdges ? 2 : 0) };
  }
  const range = /^(\d{1,3}(?:\.\d{1,3}){3})\s*-\s*(\d{1,3}(?:\.\d{1,3}){3}|\d{1,3})$/.exec(t);
  if (range) {
    const a = ipToInt(range[1]);
    const b = range[2].includes('.') ? ipToInt(range[2]) : ipToInt(range[1].split('.').slice(0, 3).join('.') + '.' + range[2]);
    if (a !== null && b !== null && b >= a) return { kind: 'range', start: a, end: b, label: t, count: b - a + 1 };
  }
  const single = ipToInt(t);
  if (single !== null) return { kind: 'ip', start: single, end: single, label: t, count: 1 };
  return null;
}

function isPrivate(ip) {
  const n = ipToInt(ip);
  if (n === null) return false;
  return inCidr(ip, '10.0.0.0/8') || inCidr(ip, '172.16.0.0/12') || inCidr(ip, '192.168.0.0/16') || inCidr(ip, '100.64.0.0/10');
}

// ---------- Interfaces ----------
const VPN_NAME = /(tun|tap|wg|wireguard|vpn|ppp|ipsec|anyconnect|tailscale|zerotier|zt[a-z0-9]{4,}|nordlynx|proton|openvpn|forti|globalprotect|pangp|pulse|juniper|cisco|sonic|hamachi|netbird|nebula)/i;
const VIRTUAL_NAME = /(vethernet|virtualbox|vmware|vmnet|docker|wsl|hyper-v|br-[0-9a-f]{6}|veth|virbr|loopback|bluetooth|npcap)/i;

let adapterCache = { at: 0, data: [] };

function run(cmd, args, timeout = 6000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

// Windows adapter descriptions let us recognise commercial VPN clients whose names look generic.
async function refreshAdapters() {
  if (process.platform !== 'win32') return adapterCache.data;
  if (Date.now() - adapterCache.at < 60_000) return adapterCache.data;
  const out = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'Get-NetAdapter -IncludeHidden:$false | Select-Object Name,InterfaceDescription,Status,Virtual | ConvertTo-Json -Compress',
  ], 10000);
  try {
    const parsed = JSON.parse(out);
    adapterCache = { at: Date.now(), data: Array.isArray(parsed) ? parsed : [parsed] };
  } catch {
    adapterCache = { at: Date.now(), data: adapterCache.data };
  }
  return adapterCache.data;
}

function classify(name, description) {
  const text = `${name} ${description || ''}`;
  if (VPN_NAME.test(text)) return 'vpn';
  if (VIRTUAL_NAME.test(text)) return 'virtual';
  return 'lan';
}

function listInterfaces({ deny = [] } = {}) {
  const out = [];
  const adapters = adapterCache.data;
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    const desc = adapters.find((a) => a.Name === name)?.InterfaceDescription || '';
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (a.address.startsWith('169.254.')) continue;
      if (deny.includes(name)) continue;
      const prefix = prefixFromMask(a.netmask);
      const base = (ipToInt(a.address) & maskFromPrefix(prefix)) >>> 0;
      out.push({
        name,
        description: desc,
        address: a.address,
        netmask: a.netmask,
        prefix,
        cidr: `${intToIp(base)}/${prefix}`,
        mac: a.mac,
        kind: classify(name, desc),
      });
    }
  }
  return out;
}

// ---------- Routing table -> candidate remote networks ----------
async function readRoutes() {
  const routes = [];
  if (process.platform === 'win32') {
    const out = await run('route', ['print', '-4']);
    for (const line of out.split(/\r?\n/)) {
      const m = /^\s*(\d+\.\d+\.\d+\.\d+)\s+(\d+\.\d+\.\d+\.\d+)\s+(On-link|\d+\.\d+\.\d+\.\d+)\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+)/.exec(line);
      if (!m) continue;
      const prefix = prefixFromMask(m[2]);
      if (prefix === null) continue;
      routes.push({ dest: m[1], prefix, gateway: m[3] === 'On-link' ? null : m[3], iface: m[4], metric: Number(m[5]) });
    }
  } else if (process.platform === 'linux') {
    const out = await run('ip', ['-4', 'route', 'show']);
    for (const line of out.split('\n')) {
      const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)(?:.*?via (\d+\.\d+\.\d+\.\d+))?.*?dev (\S+)/.exec(line);
      if (m) routes.push({ dest: m[1], prefix: Number(m[2]), gateway: m[3] || null, ifaceName: m[4], metric: 0 });
    }
  } else {
    const out = await run('netstat', ['-rn', '-f', 'inet']);
    for (const line of out.split('\n')) {
      const m = /^(\d+\.\d+\.\d+(?:\.\d+)?)(?:\/(\d+))?\s+(\d+\.\d+\.\d+\.\d+)\s+\S+\s+(\S+)/.exec(line);
      if (m) routes.push({ dest: m[1].split('.').concat(['0', '0', '0']).slice(0, 4).join('.'), prefix: Number(m[2] || 24), gateway: m[3], ifaceName: m[4], metric: 0 });
    }
  }
  return routes;
}

// Looks at local adapters and the routing table and proposes ranges that are
// reachable through the router / VPN so users can enable them with one click.
async function suggestNetworks(opts = {}) {
  await refreshAdapters();
  const ifaces = listInterfaces(opts);
  const routes = await readRoutes();
  const byAddr = new Map(ifaces.map((i) => [i.address, i]));
  const suggestions = new Map();

  const add = (cidr, info) => {
    const c = parseCidr(cidr);
    if (!c) return;
    if (!isPrivate(intToIp(c.start))) return;
    if (!suggestions.has(c.cidr)) suggestions.set(c.cidr, { cidr: c.cidr, hosts: c.size, ...info });
  };

  // 1. Directly attached subnets (LAN + VPN adapters). VPN adapters are the interesting ones.
  for (const i of ifaces) {
    if (i.kind === 'virtual') continue;
    add(i.cidr, { kind: i.kind, via: i.name, reason: i.kind === 'vpn' ? 'VPN adapter subnet' : 'Local subnet', attached: true });
  }

  // 2. Routed ranges: reachable via a gateway or an on-link VPN adapter.
  for (const r of routes) {
    if (r.prefix === 32 || r.prefix === 0 || r.prefix < 8) continue;
    const first = r.dest.split('.').map(Number)[0];
    if (first >= 224 || first === 127) continue;
    const ifaceInfo = r.iface ? byAddr.get(r.iface) : ifaces.find((i) => i.name === r.ifaceName);
    if (!ifaceInfo || ifaceInfo.kind === 'virtual') continue;
    const cidr = `${r.dest}/${r.prefix}`;
    const c = parseCidr(cidr);
    if (!c || c.cidr !== cidr) continue;
    // Skip anything that is just an attached subnet already handled above.
    if (ifaces.some((i) => i.cidr === c.cidr)) continue;
    // Skip host-broadcast style routes inside an attached subnet.
    if (ifaces.some((i) => inCidr(r.dest, i.cidr) && r.prefix > i.prefix)) continue;
    add(c.cidr, {
      kind: ifaceInfo.kind === 'vpn' ? 'vpn' : 'routed',
      via: r.gateway ? `${r.gateway} (${ifaceInfo.name})` : ifaceInfo.name,
      reason: ifaceInfo.kind === 'vpn' ? 'Routed via VPN' : 'Routed via router',
      attached: false,
    });
  }

  return [...suggestions.values()].sort((a, b) => Number(b.kind === 'vpn') - Number(a.kind === 'vpn') || a.hosts - b.hosts);
}

module.exports = {
  ipToInt, intToIp, parseCidr, parseTarget, inCidr, isPrivate,
  listInterfaces, refreshAdapters, suggestNetworks, readRoutes, classify,
};
