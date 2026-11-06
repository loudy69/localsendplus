'use strict';
/* ---------- tiny DOM helper ---------- */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  const add = (c) => {
    if (c == null || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.append(c.nodeType ? c : document.createTextNode(String(c)));
  };
  kids.forEach(add);
  return el;
}
const ico = (name, size, cls) => h('span', { class: 'ico-wrap', style: { display: 'inline-flex' }, html: icon(name, size, cls) });
const $ = (sel, root = document) => root.querySelector(sel);

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}
function fmtDur(sec) {
  if (!isFinite(sec) || sec < 0) return '–';
  if (sec < 60) return `${Math.ceil(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
  return `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m`;
}
function ago(ts) {
  if (!ts) return 'never';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}
const plural = (n, w) => `${n.toLocaleString()} ${n === 1 ? w : /(s|x)$/.test(w) ? w + 'es' : w + 's'}`;

/* ---------- state ---------- */
const S = {
  st: null,
  view: 'send',
  selection: [],
  showInfo: false,
  sendMode: 'single',
  multi: new Set(),
  suggestions: null,
  suggesting: false,
  quiet: new Set(),
  pendingClear: new Map(),
  dialogs: new Map(),
  hidden: new Set(),
  thumbs: new Map(),
};

/* ---------- theme ---------- */
const HUES = { teal: 174, blue: 212, indigo: 240, purple: 280, pink: 332, orange: 24, green: 135, red: 5 };
function applyTheme() {
  const s = S.st.settings;
  const dark = s.theme === 'dark' || s.theme === 'oled' || (s.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  const hue = HUES[s.accent] ?? 174;
  const sat = hue === 174 ? 100 : 70;
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.classList.toggle('oled', s.theme === 'oled');
  const v = dark
    ? { primary: `hsl(${hue} 65% 60%)`, 'on-primary': `hsl(${hue} 100% 12%)`, 'primary-container': `hsl(${hue} ${sat}% 17%)`, 'on-primary-container': `hsl(${hue} 90% 85%)`, 'secondary-container': `hsl(${hue} 20% 24%)`, 'on-secondary-container': `hsl(${hue} 25% 88%)`, surface: `hsl(${hue} 15% 7%)`, 'surface-1': `hsl(${hue} 14% 10%)`, 'surface-2': `hsl(${hue} 13% 12.5%)`, 'surface-3': `hsl(${hue} 12% 16%)`, 'on-surface': `hsl(${hue} 12% 88%)`, 'on-surface-variant': `hsl(${hue} 10% 78%)`, outline: `hsl(${hue} 6% 55%)`, 'outline-variant': `hsl(${hue} 10% 26%)` }
    : { primary: `hsl(${hue} ${sat}% 26%)`, 'on-primary': '#fff', 'primary-container': `hsl(${hue} 85% 85%)`, 'on-primary-container': `hsl(${hue} 90% 10%)`, 'secondary-container': `hsl(${hue} 25% 87%)`, 'on-secondary-container': `hsl(${hue} 30% 10%)`, surface: `hsl(${hue} 30% 97%)`, 'surface-1': `hsl(${hue} 22% 93%)`, 'surface-2': `hsl(${hue} 20% 90%)`, 'surface-3': `hsl(${hue} 18% 87%)`, 'on-surface': `hsl(${hue} 15% 10%)`, 'on-surface-variant': `hsl(${hue} 8% 27%)`, outline: `hsl(${hue} 5% 45%)`, 'outline-variant': `hsl(${hue} 12% 78%)` };
  for (const [k, val] of Object.entries(v)) root.style.setProperty(`--${k}`, val);
  if (s.theme === 'oled') {
    root.style.setProperty('--surface', '#000');
    root.style.setProperty('--surface-1', `hsl(${hue} 12% 6%)`);
    root.style.setProperty('--surface-2', `hsl(${hue} 12% 9%)`);
    root.style.setProperty('--surface-3', `hsl(${hue} 12% 13%)`);
  }
  root.style.setProperty('--anim', s.animations ? '1' : '0');
}

/* ---------- toasts ---------- */
function toast(msg, err) {
  const el = h('div', { class: `snack${err ? ' err' : ''}` }, msg);
  $('#snackbars').append(el);
  setTimeout(() => el.remove(), err ? 6000 : 3200);
}

/* ---------- dialogs: persistent DOM per key so typed input survives live updates ---------- */
function openDialog(key, el, { update, onClose, dismissable = true } = {}) {
  closeDialog(key, true);
  const scrim = h('div', { class: 'scrim', onmousedown: (e) => { if (e.target === scrim && dismissable) closeDialog(key); } }, el);
  S.dialogs.set(key, { scrim, update, onClose });
  $('#dialogs').append(scrim);
  const first = scrim.querySelector('[autofocus]');
  if (first) setTimeout(() => first.focus(), 30);
  return scrim;
}
function closeDialog(key, silent) {
  const d = S.dialogs.get(key);
  if (!d) return;
  S.dialogs.delete(key);
  d.scrim.remove();
  if (!silent) d.onClose?.();
}
function dialogShell(title, bodyEls, actions, { wide, titleIcon } = {}) {
  return h('div', { class: `dialog${wide ? ' wide' : ''}`, role: 'dialog' },
    h('h3', null, titleIcon ? ico(titleIcon, 24) : null, title),
    h('div', { class: 'body' }, bodyEls),
    h('div', { class: 'actions' }, actions));
}

/* ---------- common widgets ---------- */
function netChip(net) {
  if (!net) return null;
  return h('span', { class: `chip ${net.kind}` }, h('i'), net.label);
}
function deviceIconName(d) {
  return { mobile: 'mobile', desktop: 'desktop', web: 'web', headless: 'headless', server: 'server' }[d.deviceType] || 'desktop';
}
function peerAvatar(peer, size = 44) {
  return h('div', { class: `avatar ${peer.net?.kind || ''}`, style: { width: size + 'px', height: size + 'px', borderRadius: '13px', background: 'var(--primary-container)', color: 'var(--on-primary-container)', display: 'grid', placeItems: 'center', flex: 'none' } }, ico(deviceIconName(peer), size * 0.5));
}
function switchEl(on, onchange) {
  const el = h('button', { class: `switch${on ? ' on' : ''}`, role: 'switch', 'aria-checked': String(!!on) });
  el.addEventListener('click', () => {
    on = !on;
    el.classList.toggle('on', on);
    el.setAttribute('aria-checked', String(on));
    onchange(on);
  });
  return el;
}
function settingRow(title, desc, control) {
  return h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 't' }, title), desc ? h('div', { class: 'd' }, desc) : null), control);
}
function selectEl(options, value, onchange) {
  const el = h('select', { class: 'field sm' }, options.map(([v, label]) => h('option', { value: v }, label)));
  el.value = String(value);
  el.addEventListener('change', () => onchange(el.value));
  return el;
}
function segmented(options, value, onchange) {
  const wrap = h('div', { class: 'seg' });
  options.forEach(([v, label]) => {
    const b = h('button', { class: v === value ? 'on' : '' }, label);
    b.addEventListener('click', () => onchange(v));
    wrap.append(b);
  });
  return wrap;
}
async function setSetting(patch) {
  S.st.settings = await sa.updateSettings(patch);
  if ('theme' in patch || 'accent' in patch || 'animations' in patch) applyTheme();
}

/* mini IPv4 helpers for validating ranges in the UI */
function ipInt(ip) {
  const p = ip.split('.').map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3] : null;
}
function countTargets(text) {
  let total = 0;
  const parts = String(text).split(/[,\s]+/).filter(Boolean);
  if (!parts.length) return { ok: false, count: 0 };
  for (const t of parts) {
    let m = /^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/.exec(t);
    if (m && ipInt(m[1]) !== null && +m[2] <= 32) {
      const n = 2 ** (32 - +m[2]);
      total += +m[2] <= 30 ? n - 2 : n;
      continue;
    }
    m = /^(\d+\.\d+\.\d+\.\d+)-(\d+\.\d+\.\d+\.\d+|\d+)$/.exec(t);
    if (m) {
      const a = ipInt(m[1]);
      const b = m[2].includes('.') ? ipInt(m[2]) : ipInt(m[1].split('.').slice(0, 3).join('.') + '.' + m[2]);
      if (a !== null && b !== null && b >= a) { total += b - a + 1; continue; }
    }
    if (ipInt(t) !== null) { total += 1; continue; }
    return { ok: false, count: 0, bad: t };
  }
  return { ok: true, count: total };
}
