'use strict';
/* ---------- selection ---------- */
function selectionSize() {
  return S.selection.reduce((a, i) => a + (i.kind === 'text' ? new Blob([i.text]).size : i.size || 0), 0);
}
function selectionCount() {
  return S.selection.reduce((a, i) => a + (i.kind === 'folder' ? i.count : 1), 0);
}
function addItems(items) {
  let n = 0;
  for (const it of items) {
    if (it.path && S.selection.some((x) => x.path === it.path)) continue;
    S.selection.push(it);
    n++;
  }
  if (S.view !== 'send') go('send');
  else renderSelection();
  return n;
}
function removeItem(id) {
  S.selection = S.selection.filter((i) => i.id !== id);
  renderSelection();
}
function clearSelection() {
  S.selection = [];
  renderSelection();
}
const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|heic|svg|ico)$/i;

function thumbEl(it) {
  if (it.kind === 'text') return h('div', { class: 'thumb txt' }, it.text.slice(0, 140));
  if (it.kind === 'folder') return h('div', { class: 'thumb' }, ico('folder', 26), h('span', null, plural(it.count, 'file')));
  const ext = (it.name.split('.').pop() || '').slice(0, 4).toUpperCase();
  const el = h('div', { class: 'thumb', title: it.name }, ico(IMG_EXT.test(it.name) ? 'image' : 'file', 24), h('span', { class: 'ext' }, ext));
  if (IMG_EXT.test(it.name) || it.kind === 'image') {
    const apply = (url) => { if (url) { el.innerHTML = ''; el.append(h('img', { src: url })); } };
    if (S.thumbs.has(it.path)) apply(S.thumbs.get(it.path));
    else sa.thumbnail(it.path).then((u) => { S.thumbs.set(it.path, u); apply(u); });
  }
  return el;
}

/* ---------- adding things ---------- */
async function pickFiles() { addItems(await sa.pickFiles()); }
async function pickMedia() { addItems(await sa.pickMedia()); }
async function pickFolders() { addItems(await sa.pickFolders()); }

function textDialog(initial = '') {
  const ta = h('textarea', { class: 'field', placeholder: 'Type or paste a message…', autofocus: true, rows: 6 });
  ta.value = initial;
  const ok = h('button', { class: 'btn filled', onclick: () => {
    const text = ta.value;
    if (!text.trim()) return;
    closeDialog('text');
    addItems([{ id: crypto.randomUUID(), kind: 'text', text }]);
  } }, 'Add');
  openDialog('text', dialogShell('Send text', [h('div', { class: 'sub' }, 'The message is delivered straight to the other device — nothing is saved as a file.'), h('div', { style: { height: '10px' } }), ta], [
    h('button', { class: 'btn text', onclick: () => closeDialog('text') }, 'Cancel'), ok], { titleIcon: 'text' }));
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) ok.click(); });
}

let pasteHandled = false;
async function doPaste() {
  pasteHandled = false;
  try { document.execCommand('paste'); } catch { /* fall through */ }
  await new Promise((r) => setTimeout(r, 120));
  if (pasteHandled) return;
  const c = await sa.readClipboard();
  const items = [...c.files, ...(c.image ? [c.image] : [])];
  if (c.text) items.push({ id: crypto.randomUUID(), kind: 'text', text: c.text });
  if (!items.length) return toast('Clipboard is empty');
  addItems(items);
  toast(`Added ${plural(items.length, 'item')} from clipboard`);
}

async function handleDataTransfer(dt, fromPaste) {
  const items = [];
  const files = [...(dt.files || [])];
  const paths = [];
  for (const f of files) {
    const p = sa.pathForFile(f);
    if (p) paths.push(p);
    else if (sa.uploadFile) {
      const it = await sa.uploadFile(f).catch((e) => { toast(e.message || 'Upload failed', true); return null; });
      if (it) items.push(it);
    } else if (f.type.startsWith('image/')) {
      const url = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(f); });
      const it = await sa.saveImageData(url, f.name && f.name !== 'image.png' ? f.name : undefined);
      if (it) items.push(it);
    }
  }
  if (paths.length) items.push(...(await sa.describePaths(paths)));
  if (!items.length) {
    const text = dt.getData('text/plain');
    if (text && text.trim() && (fromPaste || !paths.length)) items.push({ id: crypto.randomUUID(), kind: 'text', text });
  }
  if (items.length) {
    addItems(items);
    return true;
  }
  return false;
}

document.addEventListener('paste', async (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
  if (S.dialogs.size) return;
  e.preventDefault();
  pasteHandled = true;
  if (await handleDataTransfer(e.clipboardData, true)) toast('Added from clipboard');
});

let dragDepth = 0;
const dz = () => document.getElementById('dropzone');
window.addEventListener('dragenter', (e) => {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  dragDepth++;
  dz().hidden = false;
  $('.drop-card', dz()).innerHTML = `${icon('receive', 40)}<div style="margin-top:12px">Drop files or folders to send</div>`;
});
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dz().hidden = true; });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  dz().hidden = true;
  if (await handleDataTransfer(e.dataTransfer, false)) toast('Added to selection');
});

/* ---------- hosts ---------- */
function hostDialog() {
  const host = h('input', { class: 'field', placeholder: 'e.g. 10.20.4.15 or buildbox.corp.example', autofocus: true });
  const port = h('input', { class: 'field', value: '53317', style: { width: '110px' }, inputmode: 'numeric' });
  const msg = h('div', { class: 'sub', style: { minHeight: '18px', marginTop: '8px' } });
  const go_ = h('button', { class: 'btn filled' }, 'Add device');
  const run = async () => {
    if (!host.value.trim()) return;
    go_.disabled = true;
    msg.textContent = 'Contacting device…';
    msg.style.color = '';
    const r = await sa.addHost(host.value.trim(), port.value);
    go_.disabled = false;
    if (r.ok) {
      closeDialog('host');
      toast(`Connected to ${r.device.alias}`);
      S.st = { ...S.st, ...(await sa.getState()) };
      renderDevices();
    } else {
      msg.textContent = r.error;
      msg.style.color = 'var(--error)';
    }
  };
  go_.addEventListener('click', run);
  host.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  openDialog('host', dialogShell('Add device by address', [
    h('div', { class: 'sub' }, 'Works across VPNs and routed networks — any IPv4 address or host name that can reach the other device on its LocalSendPlus / LocalSend port. The address is remembered and re-checked on every scan.'),
    h('label', { class: 'label' }, 'IP address or host name'), host,
    h('label', { class: 'label' }, 'Port'), port, msg,
  ], [h('button', { class: 'btn text', onclick: () => closeDialog('host') }, 'Cancel'), go_], { titleIcon: 'target' }));
}

function favoritesDialog() {
  const body = h('div');
  const draw = () => {
    body.innerHTML = '';
    const favs = S.st.settings.favorites;
    if (!favs.length) body.append(h('div', { class: 'empty' }, 'No favorites yet. Tap the heart on a device to add it.'));
    favs.forEach((f) => body.append(h('div', { class: 'row' },
      peerAvatar({ deviceType: f.deviceType }, 36),
      h('div', { class: 'grow' }, h('div', { class: 't' }, f.alias), h('div', { class: 'd' }, `${f.ip || ''}${f.port ? ':' + f.port : ''}`)),
      h('button', { class: 'icon-btn', title: 'Remove', onclick: async () => { await setSetting({ favorites: favs.filter((x) => x.fingerprint !== f.fingerprint) }); draw(); renderDevices(); } }, ico('trash', 20)))));
  };
  draw();
  openDialog('favs', dialogShell('Favorites', [body, h('div', { class: 'sub', style: { marginTop: '10px' } }, 'Favorites are remembered by certificate fingerprint, so they stay trusted when their IP changes (including between LAN and VPN). Quick Save can be limited to favorites.')],
    [h('button', { class: 'btn filled', onclick: () => closeDialog('favs') }, 'Close')], { titleIcon: 'heart' }));
}

/* ---------- sending ---------- */
async function startSend(deviceIds) {
  if (!S.selection.length) return toast('Select files, a folder, text or paste something first');
  const items = S.selection.map(({ id, kind, path, name, text, size }) => ({ id, kind, path, name, text, size }));
  const quiet = items.length === 1 && items[0].kind === 'text';
  let ids;
  try {
    ids = await sa.send(deviceIds, items);
  } catch (e) {
    return toast(e.message || 'Could not start transfer', true);
  }
  ids.forEach((id) => {
    if (quiet) S.quiet.add(id);
    S.pendingClear.set(id, items.map((i) => i.id));
  });
  if (!quiet) openTransferDialog(ids[0]);
  S.multi.clear();
  renderDevices();
}

function onDeviceClick(dev) {
  if (!dev.online) return toast(`${dev.alias} is offline right now`, true);
  if (S.sendMode === 'multiple') {
    if (S.multi.has(dev.id)) S.multi.delete(dev.id);
    else S.multi.add(dev.id);
    return renderDevices();
  }
  startSend([dev.id]);
}

/* ---------- transfer dialog ---------- */
function transferById(id) { return S.st.transfers.find((t) => t.id === id); }

function openTransferDialog(id) {
  const key = `transfer:${id}`;
  if (S.dialogs.has(key)) return;
  S.hidden.delete(id);
  const t = transferById(id);
  if (!t) return;
  const title = h('h3');
  const peerRow = h('div', { class: 'row', style: { borderTop: 0 } });
  const bar = h('div', { class: 'progress' }, h('div', { style: { width: '0%' } }));
  const stats = h('div', { class: 'stats' });
  const list = h('div', { class: 'filelist' });
  const err = h('div', { class: 'sub', style: { color: 'var(--error)', marginTop: '8px' } });
  const actions = h('div', { class: 'actions' });
  const body = h('div', { class: 'body' }, peerRow, bar, stats, err, list);
  const dlg = h('div', { class: 'dialog wide', role: 'dialog' }, title, body, actions);

  const update = (t) => {
    const send = t.direction === 'send';
    const ended = !!t.endedAt;
    title.innerHTML = '';
    const stIcon = t.status === 'finished' ? 'checkCircle' : ['error', 'declined', 'cancelled'].includes(t.status) ? 'alert' : send ? 'send' : 'receive';
    title.append(ico(stIcon, 24), send ? `Sending to ${t.peer.alias}` : `Receiving from ${t.peer.alias}`);
    peerRow.innerHTML = '';
    peerRow.append(peerAvatar(t.peer, 40), h('div', { class: 'grow' }, h('div', { class: 't' }, statusText(t)), h('div', { class: 'd' }, `${t.peer.ip}`)), netChip(t.peer.net));
    const pct = t.total ? Math.min(100, (t.done / t.total) * 100) : t.status === 'finished' ? 100 : 0;
    bar.classList.toggle('ind', ['preparing', 'waiting'].includes(t.status));
    bar.firstChild.style.width = `${pct}%`;
    const doneFiles = t.files.filter((f) => f.status === 'done').length;
    const eta = t.speed > 0 ? (t.total - t.done) / t.speed : NaN;
    stats.innerHTML = '';
    stats.append(h('span', null, `${doneFiles.toLocaleString()} / ${(t.fileCount || t.files.length).toLocaleString()} files`), h('span', null, `${fmtBytes(t.done)} / ${fmtBytes(t.total)}`));
    if (!ended && t.speed > 0) stats.append(h('span', null, `${fmtBytes(t.speed)}/s`), h('span', null, `${fmtDur(eta)} left`));
    if (ended && t.endedAt) stats.append(h('span', null, `Took ${fmtDur((t.endedAt - t.startedAt) / 1000)}`));
    err.textContent = t.error && t.status !== 'finished' ? t.error : '';
    const scroll = list.scrollTop;
    list.innerHTML = '';
    const rows = t.files.slice(0, 200);
    rows.forEach((f) => list.append(h('div', { class: 'fr' }, ico(fileStatusIcon(f.status), 18), h('div', { class: 'n' }, h('div', { class: 'ellip' }, f.name), (f.status === 'sending' || f.status === 'receiving') && f.size ? h('div', { class: 'progress', style: { marginTop: '4px' } }, h('div', { style: { width: `${(f.done / f.size) * 100}%` } })) : null), h('span', { class: 'sub' }, fmtBytes(f.size)))));
    if ((t.fileCount || 0) > rows.length) list.append(h('div', { class: 'sub', style: { padding: '8px 0' } }, `…and ${(t.fileCount - rows.length).toLocaleString()} more`));
    list.style.display = rows.length > 1 || (rows[0] && rows[0].size > 0 && !t.isMessage) ? '' : 'none';
    list.scrollTop = scroll;
    actions.innerHTML = '';
    if (!ended) {
      actions.append(h('button', { class: 'btn text', onclick: () => { S.hidden.add(id); closeDialog(key, true); renderActivity(); } }, 'Hide'),
        h('button', { class: 'btn tonal', onclick: () => sa.cancelTransfer(id) }, ico('cancel', 18), 'Cancel'));
    } else {
      if (!send && t.status !== 'cancelled' && t.files.some((f) => f.path)) {
        const first = t.files.find((f) => f.path);
        actions.append(h('button', { class: 'btn outlined', onclick: () => sa.showInFolder(first.path) }, ico('folder', 18), 'Open folder'));
      }
      actions.append(h('button', { class: 'btn filled', onclick: () => closeDialog(key) }, 'Done'));
    }
    if (ended && t.status === 'finished' && S.st.settings.autoFinish && !t._autoClosed) {
      t._autoClosed = true;
      setTimeout(() => closeDialog(key), 900);
    }
  };
  openDialog(key, dlg, { update, dismissable: false, onClose: () => { if (!transferById(id)?.endedAt) S.hidden.add(id); renderActivity(); } });
  update(t);
  renderActivity();
}

function statusText(t) {
  const send = t.direction === 'send';
  return {
    preparing: 'Preparing files…',
    waiting: 'Waiting for the other device to accept…',
    transferring: send ? 'Sending…' : 'Receiving…',
    receiving: 'Receiving…',
    finished: 'Finished',
    cancelled: 'Cancelled',
    declined: 'The other device declined the transfer',
    error: t.error || 'Something went wrong',
    'pin-required': 'PIN required',
  }[t.status] || t.status;
}
function fileStatusIcon(s) {
  return { done: 'checkCircle', failed: 'alert', sending: 'send', receiving: 'receive', skipped: 'close' }[s] || 'file';
}

function renderActivity() {
  const box = $('#activity');
  if (!box) return;
  box.innerHTML = '';
  S.st.transfers.filter((t) => !t.endedAt && t.status !== 'pin-required' && !S.quiet.has(t.id) && !S.dialogs.has(`transfer:${t.id}`)).forEach((t) => {
    const pct = t.total ? (t.done / t.total) * 100 : 0;
    box.append(h('div', { class: 'a', onclick: () => openTransferDialog(t.id) },
      ico(t.direction === 'send' ? 'send' : 'receive', 20),
      h('div', { style: { flex: 1 } }, h('div', null, `${t.direction === 'send' ? 'Sending to' : 'Receiving from'} ${t.peer.alias} · ${Math.round(pct)}%`), h('div', { class: 'progress' }, h('div', { style: { width: `${pct}%` } })))));
  });
}

/* ---------- PIN prompt ---------- */
function pinDialog(t) {
  const key = `pin:${t.id}`;
  if (S.dialogs.has(key)) return;
  const input = h('input', { class: 'field', placeholder: 'PIN', autofocus: true, inputmode: 'numeric', type: 'password' });
  const go_ = () => { if (!input.value) return; closeDialog(key, true); sa.retrySend(t.id, input.value); };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go_(); });
  openDialog(key, dialogShell(`${t.peer.alias} requires a PIN`, [h('div', { class: 'sub' }, t.error === 'Invalid PIN' ? 'That PIN was not accepted. Try again.' : 'Enter the PIN shown in the other device’s settings.'), h('div', { style: { height: '10px' } }), input], [
    h('button', { class: 'btn text', onclick: () => { closeDialog(key, true); sa.cancelTransfer(t.id); } }, 'Cancel'),
    h('button', { class: 'btn filled', onclick: go_ }, 'Send')], { titleIcon: 'lock' }), { dismissable: false });
}

/* ---------- receive request / message ---------- */
function requestDialog(r) {
  const key = `request:${r.id}`;
  if (S.dialogs.has(key)) return;
  let dest = r.destination;
  const destLine = h('span', { class: 'selectable ellip', style: { flex: 1 } }, dest);
  const body = [
    h('div', { class: 'row', style: { borderTop: 0 } }, peerAvatar(r.sender, 44), h('div', { class: 'grow' },
      h('div', { class: 't' }, r.sender.alias), h('div', { class: 'd' }, `${r.sender.ip}${r.sender.deviceModel ? ' · ' + r.sender.deviceModel : ''}`)), netChip(r.sender.net)),
    r.isMessage
      ? [h('div', { class: 'sub', style: { margin: '8px 0 6px' } }, 'wants to send you a text message'), h('div', { class: 'msgbox' }, r.preview)]
      : [h('div', { style: { margin: '8px 0 4px', fontSize: '15px' } }, `wants to send you ${plural(r.count, 'file')} (${fmtBytes(r.totalSize)})`),
        h('div', { class: 'filelist' }, r.files.slice(0, 8).map((f) => h('div', { class: 'fr' }, ico('file', 18), h('div', { class: 'n ellip' }, f.name), h('span', { class: 'sub' }, fmtBytes(f.size)))),
          r.count > 8 ? h('div', { class: 'sub', style: { padding: '8px 0' } }, `…and ${plural(r.count - 8, 'more file')}`) : null),
        h('div', { class: 'row', style: { marginTop: '8px', borderTop: 0 } }, ico('folder', 18), destLine,
          h('button', { class: 'btn text sm', onclick: async () => { const p = await sa.chooseDestination(); if (p) { dest = p; destLine.textContent = p; } } }, 'Change'))],
  ];
  const decide = (accept) => { sa.respondReceive(r.id, { accept, destination: dest !== r.destination ? dest : undefined }); closeDialog(key, true); };
  openDialog(key, dialogShell('Incoming transfer', body, [
    h('button', { class: 'btn text', onclick: () => decide(false) }, 'Decline'),
    h('button', { class: 'btn filled', autofocus: true, onclick: () => decide(true) }, ico('check', 18), 'Accept')], { titleIcon: 'receive' }), { dismissable: false });
}

function messageDialog(m) {
  const key = `message:${Date.now()}`;
  openDialog(key, dialogShell(`Message from ${m.peer.alias}`, [
    h('div', { class: 'msgbox' }, m.text),
    m.copied ? h('div', { class: 'chip ok', style: { marginTop: '10px' } }, 'Copied to clipboard') : null,
    /^https?:\/\/\S+$/.test(m.text.trim()) ? h('div', { class: 'sub', style: { marginTop: '8px' } }, 'Tip: this is a link — copy it and paste it into your browser.') : null,
  ], [
    h('button', { class: 'btn outlined', onclick: () => { sa.copyText(m.text); toast('Copied to clipboard'); } }, ico('copy', 18), 'Copy'),
    h('button', { class: 'btn filled', onclick: () => closeDialog(key) }, 'Close')], { titleIcon: 'text' }));
}

/* ---------- engine events ---------- */
function upsert(list, item) {
  const i = list.findIndex((x) => x.id === item.id);
  if (i >= 0) list[i] = item;
  else list.push(item);
}

function onEvent({ type, data }) {
  switch (type) {
    case 'devices':
      S.st.devices = data;
      if (S.view === 'send') renderDevices();
      break;
    case 'scan':
      S.st.scan = data;
      renderScan();
      if (S.view === 'networks') updateNetworkStatus();
      break;
    case 'history':
      S.st.history = data;
      if (S.view === 'history') go('history');
      break;
    case 'settings':
      S.st.settings = data;
      break;
    case 'server-status':
      S.st.serverError = data;
      if (S.view === 'receive') go('receive');
      break;
    case 'interfaces':
      S.st.interfaces = data;
      if (S.view === 'receive' || S.view === 'networks') go(S.view);
      break;
    case 'receive-request':
      requestDialog(data);
      break;
    case 'receive-request-cancel':
      closeDialog(`request:${data}`, true);
      toast('The sender cancelled the request');
      break;
    case 'message-received':
      messageDialog(data);
      break;
    case 'share':
      S.st.share = data;
      S.dialogs.get('share')?.update?.(data);
      if (S.view === 'send') shareBar();
      break;
    case 'share-request':
      shareRequestDialog(data);
      break;
    case 'share-request-cancel':
      closeDialog(`share-request:${data}`, true);
      break;
    case 'error':
      toast(data.message, true);
      break;
    case 'transfer': {
      const known = S.st.transfers.some((t) => t.id === data.id);
      upsert(S.st.transfers, data);
      const key = `transfer:${data.id}`;
      if (!known && data.direction === 'receive' && !data.isMessage) openTransferDialog(data.id);
      S.dialogs.get(key)?.update?.(data);
      if (data.status === 'pin-required') pinDialog(data);
      if (data.endedAt && S.quiet.has(data.id)) {
        if (data.status === 'finished') toast(`Message sent to ${data.peer.alias}`);
        else if (data.error) toast(data.error, true);
      } else if (data.endedAt && !S.dialogs.has(key) && data.direction === 'send' && data.status !== 'finished' && data.error) {
        toast(data.error, true);
      }
      if (data.status === 'finished' && S.pendingClear.has(data.id)) {
        const ids = new Set(S.pendingClear.get(data.id));
        S.pendingClear.delete(data.id);
        S.selection = S.selection.filter((i) => !ids.has(i.id));
        if (S.view === 'send') renderSelection();
      }
      renderActivity();
      break;
    }
  }
}
