'use strict';
/* ---------- navigation ---------- */
const NAV = [
  ['receive', 'Receive', 'receive'],
  ['send', 'Send', 'send'],
  ['networks', 'Networks', 'network'],
  ['settings', 'Settings', 'settings'],
];

function renderRail() {
  const rail = $('#rail');
  rail.innerHTML = '';
  rail.append(h('div', { class: 'brand', html: logoSvg(44), title: 'LocalSendPlus' }));
  NAV.forEach(([id, label, ic]) => {
    const active = S.view === id || (id === 'receive' && S.view === 'history');
    const badge = id === 'networks' ? S.st.settings.networks.filter((n) => n.enabled).length : 0;
    rail.append(h('button', { class: `rail-item${active ? ' active' : ''}`, onclick: () => go(id), title: label },
      h('div', { class: 'pill' }, ico(ic, 22)), h('span', { class: 'lbl' }, label), badge ? h('span', { class: 'badge' }, badge) : null));
  });
  rail.append(h('div', { class: 'grow' }));
}

function go(view) {
  if (view !== S.view) S.showInfo = false;
  S.view = view;
  renderRail();
  const c = $('#content');
  const prev = c.scrollTop;
  c.innerHTML = '';
  const v = { receive: receiveView, send: sendView, networks: networksView, settings: settingsView, history: historyView }[view]();
  c.append(v);
  c.scrollTop = view === S.lastView ? prev : 0;
  S.lastView = view;
  if (view === 'send') { shareBar(); renderSelection(); renderScan(); renderDevices(); }
}

/* ---------- Receive ---------- */
function visualIds() {
  return [...new Set(S.st.interfaces.filter((i) => i.kind !== 'virtual').map((i) => '#' + i.address.split('.')[3]))].join(' ') || '#—';
}

function receiveView() {
  const s = S.st.settings;
  const root = h('div', { class: 'receive' });
  const corner = h('div', { class: 'corner' },
    h('button', { class: 'icon-btn', title: 'History', onclick: () => go('history') }, ico('history', 24)),
    h('button', { class: `icon-btn${S.showInfo ? ' active' : ''}`, title: 'Device info', onclick: () => { S.showInfo = !S.showInfo; go('receive'); } }, ico('info', 24)));
  const ifaces = S.st.interfaces.filter((i) => i.kind !== 'virtual');
  const info = S.showInfo ? h('div', { class: 'card infobox selectable fade-in' }, h('table', null,
    h('tr', null, h('td', null, 'Alias'), h('td', null, s.alias)),
    h('tr', null, h('td', null, 'Address'), h('td', null, ifaces.length ? ifaces.map((i) => h('div', null, `${i.address} `, h('span', { class: 'sub' }, i.name))) : 'Unknown')),
    h('tr', null, h('td', null, 'Port'), h('td', null, String(s.port))),
    h('tr', null, h('td', null, 'Protocol'), h('td', null, s.protocol.toUpperCase())),
    h('tr', null, h('td', null, 'Fingerprint'), h('td', { style: { wordBreak: 'break-all', fontSize: '11px' } }, S.st.info.fingerprint.slice(0, 32) + '…')))) : null;

  root.append(corner, info || '',
    h('div', { class: 'fade-in', html: logoSvg(150) }),
    h('div', { class: 'alias fade-in selectable' }, s.alias),
    h('div', { class: 'ids fade-in' }, S.st.serverError ? 'Offline' : visualIds()),
    S.st.serverError ? h('div', { class: 'chip err', style: { height: 'auto', padding: '8px 14px', marginTop: '14px', maxWidth: '460px', whiteSpace: 'normal', lineHeight: '1.4' } }, ico('alert', 16), S.st.serverError) : null,
    h('div', { class: 'nets' }, ifaces.slice(0, 5).map((i) => h('span', { class: `chip ${i.kind === 'vpn' ? 'vpn' : 'lan'}`, title: `${i.address} · ${i.cidr}` }, h('i'), `${i.kind === 'vpn' ? 'VPN' : 'LAN'} · ${i.name}`))),
    h('div', { class: 'quick' },
      h('div', { class: 'sub' }, 'Quick Save'),
      segmented([['off', 'Off'], ['favorites', 'Favorites'], ['on', 'On']], s.quickSave, async (v) => { await setSetting({ quickSave: v }); go('receive'); }),
      h('div', { class: 'sub', style: { maxWidth: '420px', marginTop: '6px' } }, 'Visible to devices on your local network and — through the router or VPN — to anyone who scans your range.')));
  const logo = $('.logo', root);
  if (logo && s.animations && !S.st.serverError) logo.classList.add('spinning');
  return root;
}

/* ---------- Send ---------- */
function sendView() {
  return h('div', { class: 'page' },
    h('div', { class: 'h-row', style: { marginTop: '4px' } }, h('h2', null, 'Selection'),
      h('button', { class: `icon-btn${sharing() ? ' active' : ''}`, title: 'Share via link - let any web browser download your selection', onclick: shareDialog }, ico('link', 22))),
    h('div', { id: 'sharebar' }),
    h('div', { id: 'sel' }),
    h('div', { class: 'h-row' }, h('h2', null, 'Nearby devices'),
      h('button', { class: 'icon-btn', id: 'scanbtn', title: 'Scan network, VPN and saved ranges', onclick: () => sa.scanNow({}) }, ico('refresh', 22)),
      h('button', { class: 'icon-btn', title: 'Add device by IP or host name', onclick: hostDialog }, ico('target', 22)),
      h('button', { class: 'icon-btn', title: 'Favorites', onclick: favoritesDialog }, ico('heart', 22)),
      h('button', { class: `icon-btn${S.sendMode === 'multiple' ? ' active' : ''}`, title: 'Send mode: ' + (S.sendMode === 'multiple' ? 'multiple devices' : 'single device'), onclick: () => { S.sendMode = S.sendMode === 'single' ? 'multiple' : 'single'; S.multi.clear(); go('send'); } }, ico('users', 22)),
      h('button', { class: 'icon-btn', title: 'Networks & VPN ranges', onclick: () => go('networks') }, ico('network', 22))),
    h('div', { id: 'scan' }),
    h('div', { id: 'devs' }),
    h('div', { style: { textAlign: 'center', marginTop: '14px' } }, h('button', { class: 'btn text', onclick: troubleshootDialog }, 'Troubleshoot')),
    h('div', { class: 'sub', style: { textAlign: 'center', marginTop: '10px' } }, 'Tip: drop files here, or press ', h('span', { class: 'kbd' }, 'Ctrl+V'), ' to send whatever is on your clipboard.'));
}

const PICKERS = [['File', 'file', pickFiles], ['Folder', 'folder', pickFolders], ['Media', 'image', pickMedia], ['Text', 'text', () => textDialog()], ['Paste', 'paste', doPaste]];

function renderSelection() {
  const box = $('#sel');
  if (!box) return;
  box.innerHTML = '';
  if (!S.selection.length) {
    box.append(h('div', { class: 'bigbtns' }, PICKERS.map(([label, ic, fn]) => h('button', { class: 'bigbtn', onclick: fn }, ico(ic, 28), label))));
    return;
  }
  const addMenu = h('div', { class: 'bigbtns', style: { margin: 0 } });
  box.append(h('div', { class: 'card' },
    h('div', { class: 'row', style: { minHeight: '36px' } }, h('div', { class: 'grow sub' }, `${plural(selectionCount(), 'file')} · ${fmtBytes(selectionSize())}`),
      h('button', { class: 'icon-btn sm', title: 'Clear selection', onclick: clearSelection }, ico('close', 20))),
    h('div', { class: 'thumbs' }, S.selection.map(thumbEl)),
    h('div', { class: 'row', style: { justifyContent: 'flex-end', borderTop: 0, gap: '8px' } },
      h('button', { class: 'btn text', onclick: editSelectionDialog }, 'Edit'),
      h('button', { class: 'btn filled', onclick: addMoreDialog }, ico('plus', 18), 'Add'))));
}

function addMoreDialog() {
  openDialog('add', dialogShell('Add to selection', [h('div', { class: 'bigbtns', style: { justifyContent: 'center' } }, PICKERS.map(([label, ic, fn]) => h('button', { class: 'bigbtn', onclick: () => { closeDialog('add'); fn(); } }, ico(ic, 28), label)))], [h('button', { class: 'btn text', onclick: () => closeDialog('add') }, 'Close')]));
}

function editSelectionDialog() {
  const list = h('div', { class: 'filelist' });
  const draw = () => {
    list.innerHTML = '';
    if (!S.selection.length) return closeDialog('edit');
    S.selection.forEach((i) => list.append(h('div', { class: 'fr' },
      ico(i.kind === 'folder' ? 'folder' : i.kind === 'text' ? 'text' : i.kind === 'image' ? 'image' : 'file', 20),
      h('div', { class: 'n' }, h('div', { class: 'ellip' }, i.kind === 'text' ? i.text.slice(0, 80) : i.name), h('div', { class: 'sub ellip' }, i.kind === 'folder' ? `${plural(i.count, 'file')} · ${fmtBytes(i.size)}` : i.kind === 'text' ? 'Text message' : `${fmtBytes(i.size)} · ${i.path}`)),
      h('button', { class: 'icon-btn sm', onclick: () => { removeItem(i.id); draw(); } }, ico('trash', 18)))));
  };
  draw();
  openDialog('edit', dialogShell('Selected items', [list], [h('button', { class: 'btn filled', onclick: () => closeDialog('edit') }, 'Done')], { wide: true }));
}

function renderScan() {
  const sc = S.st.scan;
  const btn = $('#scanbtn');
  if (btn) btn.firstChild.firstChild.classList.toggle('spin', !!sc.running);
  const box = $('#scan');
  if (!box) return;
  box.innerHTML = '';
  if (sc.running && sc.total > 1) {
    const pct = sc.total ? Math.min(100, (sc.done / sc.total) * 100) : 0;
    box.append(h('div', { class: 'scanbar' },
      h('div', { class: 'row', style: { minHeight: 0, gap: '8px' } }, h('div', { class: 'grow' }, `Scanning ${sc.label || 'networks'} · ${sc.done.toLocaleString()} / ${sc.total.toLocaleString()} addresses · ${plural(sc.found, 'device')} found`),
        h('button', { class: 'btn text sm', onclick: () => sa.cancelScan() }, 'Stop')),
      h('div', { class: 'progress' }, h('div', { style: { width: pct + '%' } }))));
  }
  (sc.errors || []).slice(0, 3).forEach((e) => box.append(h('div', { class: 'chip warn', style: { margin: '2px 0 6px', height: 'auto', padding: '4px 10px', whiteSpace: 'normal' } }, e)));
}

function deviceTile(d) {
  const sub = [d.deviceModel, d.ip && `#${d.ip.split('.').slice(2).join('.')}`].filter(Boolean).join(' · ');
  const selected = S.multi.has(d.id);
  return h('button', { class: `device${d.online ? '' : ' offline'}${selected ? ' selected' : ''}`, onclick: () => onDeviceClick(d), title: d.online ? `Send to ${d.alias}` : 'Offline' },
    h('div', { class: `avatar ${d.net.kind}` }, ico(deviceIconName(d), 26)),
    h('div', { style: { flex: 1, minWidth: 0 } },
      h('div', { class: 'name ellip' }, d.alias),
      h('div', { class: 'meta' }, netChip(d.net), h('span', null, sub), d.rtt != null ? h('span', null, `${d.rtt} ms`) : null, d.online ? null : h('span', null, 'offline'))),
    h('span', { class: 'icon-btn', title: d.favorite ? 'Remove favorite' : 'Add favorite', style: { color: d.favorite ? 'var(--primary)' : '' }, onclick: (e) => { e.stopPropagation(); sa.toggleFavorite(d.id); } }, h('span', { html: icon('heart', 20).replace('fill="none"', d.favorite ? 'fill="currentColor"' : 'fill="none"') })),
    S.sendMode === 'multiple' ? h('span', { class: `chip ${selected ? 'ok' : ''}` }, selected ? 'Selected' : 'Select') : S.selection.length && d.online ? h('span', { style: { color: 'var(--primary)' } }, ico('send', 22)) : null);
}

function renderDevices() {
  const box = $('#devs');
  if (!box) return;
  box.innerHTML = '';
  const devs = S.st.devices;
  if (!devs.length) {
    box.append(h('div', { class: 'device placeholder' }, h('div', { class: 'avatar shimmer', style: { background: '' } }), h('div', { style: { flex: 1 } }, h('div', { class: 'shimmer', style: { height: '16px', width: '40%', marginBottom: '8px' } }), h('div', { class: 'shimmer', style: { height: '12px', width: '65%' } }))));
    box.append(h('div', { class: 'sub', style: { textAlign: 'center', marginTop: '6px' } }, S.st.scan.running ? 'Looking for devices on your network, VPN and saved ranges…' : 'No devices found. Check the other device is open, then scan or add a VPN range under Networks.'));
  } else {
    const groups = [];
    devs.forEach((d) => {
      const label = d.favorite && !d.online ? 'Offline favorites' : d.net.label;
      let g = groups.find((x) => x.label === label);
      if (!g) groups.push((g = { label, kind: d.net.kind, items: [] }));
      g.items.push(d);
    });
    groups.forEach((g) => {
      if (groups.length > 1) box.append(h('div', { class: 'group-h' }, h('span', { class: `chip ${g.kind}` }, h('i'), g.label), h('span', null, plural(g.items.length, 'device'))));
      g.items.forEach((d) => box.append(deviceTile(d)));
    });
  }
  if (S.sendMode === 'multiple') {
    box.append(h('div', { class: 'sendbar' }, h('button', { class: 'btn filled', disabled: !S.multi.size || !S.selection.length, onclick: () => startSend([...S.multi]) }, ico('send', 18), S.multi.size ? `Send to ${plural(S.multi.size, 'device')}` : 'Select devices')));
  }
}

function troubleshootDialog() {
  const s = S.st.settings;
  const fw = h('span', { class: 'chip' }, 'Checking…');
  const fwBtn = h('button', { class: 'btn outlined sm', style: { display: 'none' }, onclick: async () => { fwBtn.disabled = true; await sa.enableFirewall(); refreshFw(); fwBtn.disabled = false; } }, 'Allow through firewall');
  const refreshFw = async () => {
    const r = await sa.firewallStatus();
    if (!r.supported) { fw.textContent = 'Not applicable'; return; }
    fw.className = `chip ${r.enabled ? 'ok' : 'warn'}`;
    fw.textContent = r.enabled ? 'Rule present' : 'No rule found';
    fwBtn.style.display = r.enabled ? 'none' : '';
  };
  refreshFw();
  const ranges = s.networks.filter((n) => n.enabled).length;
  openDialog('trouble', dialogShell('Troubleshoot', [
    h('div', { class: 'card', style: { padding: '4px 14px' } },
      settingRow('Receiver listening', `${s.protocol.toUpperCase()} on port ${s.port}`, h('span', { class: 'chip ok' }, 'On')),
      settingRow('Windows firewall', `Inbound TCP and UDP ${s.port}`, h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, fw, fwBtn)),
      settingRow('Network adapters', S.st.interfaces.map((i) => `${i.name} ${i.address}`).join(', ') || 'None found', h('span', { class: `chip ${S.st.interfaces.length ? 'ok' : 'err'}` }, String(S.st.interfaces.length))),
      settingRow('VPN / routed ranges', ranges ? 'Scanned on every refresh' : 'None enabled — add them under Networks', h('span', { class: `chip ${ranges ? 'ok' : 'warn'}` }, String(ranges)))),
    h('div', { class: 'help', style: { marginTop: '12px' } },
      h('b', null, 'Devices on the same Wi-Fi / LAN missing? '), 'Make sure both are on the same subnet and the firewall allows port ', String(s.port), '. Guest Wi-Fi and some corporate networks isolate clients from each other.', h('br'), h('br'),
      h('b', null, 'Devices across a VPN or router missing? '), 'Multicast does not cross routers, so add the remote range under ', h('b', null, 'Networks'), ' (for example ', h('span', { class: 'kbd' }, '10.20.4.0/24'), '). The other device must allow inbound TCP ', String(s.port), ' from your VPN address. You can also add a single device with the ', ico('target', 16), ' button.'),
  ], [h('button', { class: 'btn filled', onclick: () => closeDialog('trouble') }, 'Close')], { wide: true, titleIcon: 'info' }));
}

/* ---------- History ---------- */
function historyView() {
  const hist = S.st.history;
  const page = h('div', { class: 'page' },
    h('div', { class: 'h-row', style: { marginTop: '0' } },
      h('button', { class: 'icon-btn', onclick: () => go('receive') }, h('span', { html: icon('chevron', 22).replace('<svg', '<svg style="transform:rotate(90deg)"') })),
      h('h2', { style: { fontSize: '22px' } }, 'History'),
      hist.length ? h('button', { class: 'btn text danger', onclick: async () => { await sa.deleteHistory(); } }, ico('trash', 18), 'Clear all') : null));
  if (!hist.length) page.append(h('div', { class: 'empty' }, ico('history', 40), h('div', { style: { marginTop: '8px' } }, 'Transfers you send and receive appear here.')));
  hist.forEach((e) => {
    const first = e.files?.[0];
    page.append(h('div', { class: 'card' },
      h('div', { class: 'row', style: { alignItems: 'flex-start', borderTop: 0 } },
        h('div', { class: 'avatar', style: { width: '40px', height: '40px', borderRadius: '12px', background: 'var(--primary-container)', color: 'var(--on-primary-container)', display: 'grid', placeItems: 'center', flex: 'none' } }, ico(e.direction === 'send' ? 'send' : 'receive', 20)),
        h('div', { class: 'grow' },
          h('div', { class: 't' }, `${e.direction === 'send' ? 'Sent to' : 'Received from'} ${e.peer.alias}`),
          h('div', { class: 'd' }, `${new Date(e.time).toLocaleString()} · ${e.kind === 'text' ? 'Text message' : `${plural(e.count, 'file')} · ${fmtBytes(e.size)}`}${e.status !== 'finished' ? ' · ' + e.status : ''}`),
          e.kind === 'text' ? h('div', { class: 'msgbox selectable', style: { marginTop: '8px', maxHeight: '100px' } }, e.text) : h('div', { class: 'd ellip', style: { marginTop: '4px' } }, (e.files || []).slice(0, 3).map((f) => f.name).join(', ') + (e.count > 3 ? '…' : ''))),
        h('div', { style: { display: 'flex', gap: '2px' } },
          e.kind === 'text' ? h('button', { class: 'icon-btn sm', title: 'Copy text', onclick: () => { sa.copyText(e.text); toast('Copied'); } }, ico('copy', 18)) : null,
          e.direction === 'receive' && first?.path ? h('button', { class: 'icon-btn sm', title: 'Show in folder', onclick: () => sa.showInFolder(first.path) }, ico('folder', 18)) : null,
          h('button', { class: 'icon-btn sm', title: 'Delete entry', onclick: () => sa.deleteHistory(e.id) }, ico('trash', 18))))));
  });
  return page;
}
