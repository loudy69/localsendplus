'use strict';
/* ---------- Networks ---------- */
function networksView() {
  const s = S.st.settings;
  const d = s.discovery;
  const page = h('div', { class: 'page' });
  page.append(
    h('div', { class: 'h-row', style: { marginTop: '0' } }, h('h1', { style: { margin: 0, flex: 1 } }, 'Networks'),
      h('button', { class: 'btn tonal', id: 'scanall', onclick: () => sa.scanNow({}) }, ico('refresh', 18), 'Scan all now')),
    h('div', { id: 'netstatus' }),
    h('div', { class: 'help' }, h('b', null, 'How LocalSendPlus finds devices beyond your LAN. '),
      'On the local segment it uses LocalSend multicast. Multicast stops at routers, so for VPN tunnels and other routable subnets it probes the address ranges you list below (TCP + a two-way handshake) and keeps them fresh with periodic rescans. The other device needs LocalSendPlus or LocalSend running with inbound TCP ', String(s.port), ' allowed from your VPN address.'));

  // Adapters
  const adapters = h('div', { class: 'card' }, h('div', { class: 'card-title' }, ico('wifi', 20), 'This device'),
    h('div', { class: 'sub', style: { marginBottom: '4px' } }, 'Adapters the receiver is reachable on and that multicast is sent through. Turn one off to hide this device on it.'));
  const all = S.st.interfaces;
  if (!all.length) adapters.append(h('div', { class: 'sub' }, 'No active IPv4 adapters detected.'));
  all.concat((s.interfaceFilter.deny || []).filter((n) => !all.some((i) => i.name === n)).map((n) => ({ name: n, address: 'hidden', cidr: '', kind: 'lan', hidden: true }))).forEach((i) => {
    adapters.append(h('div', { class: 'row' },
      h('span', { class: `chip ${i.kind === 'vpn' ? 'vpn' : i.kind === 'virtual' ? '' : 'lan'}` }, h('i'), i.kind === 'vpn' ? 'VPN' : i.kind === 'virtual' ? 'Virtual' : 'LAN'),
      h('div', { class: 'grow' }, h('div', { class: 't' }, i.name), h('div', { class: 'd' }, `${i.address}${i.cidr ? ' · ' + i.cidr : ''}${i.description ? ' · ' + i.description : ''}`)),
      switchEl(!i.hidden, async (on) => {
        const deny = new Set(s.interfaceFilter.deny || []);
        on ? deny.delete(i.name) : deny.add(i.name);
        await setSetting({ interfaceFilter: { deny: [...deny] } });
      })));
  });
  page.append(adapters);

  // Ranges
  const ranges = h('div', { class: 'card', id: 'ranges' });
  page.append(ranges);
  drawRanges(ranges);

  // Suggestions
  const sug = h('div', { class: 'card', id: 'suggest' });
  page.append(sug);
  drawSuggestions(sug);

  // Hosts
  const hosts = h('div', { class: 'card' }, h('div', { class: 'card-title' }, ico('target', 20), 'Saved addresses', h('div', { class: 'grow', style: { flex: 1 } }), h('button', { class: 'btn text sm', onclick: hostDialog }, ico('plus', 16), 'Add')),
    h('div', { class: 'sub' }, 'Individual devices by IP or host name — re-checked on every scan.'));
  if (!s.hosts.length) hosts.append(h('div', { class: 'sub', style: { padding: '10px 0' } }, 'None yet.'));
  s.hosts.forEach((x) => hosts.append(h('div', { class: 'row' }, ico('server', 20), h('div', { class: 'grow' }, h('div', { class: 't' }, `${x.host}:${x.port || 53317}`), x.alias ? h('div', { class: 'd' }, x.alias) : null),
    h('button', { class: 'icon-btn sm', title: 'Remove', onclick: async () => { await sa.removeHost(x.id); S.st = { ...S.st, ...(await sa.getState()) }; go('networks'); } }, ico('trash', 18)))));
  page.append(hosts);

  // Options
  const opts = h('div', { class: 'card' }, h('div', { class: 'card-title' }, ico('zap', 20), 'Discovery options'),
    settingRow('Multicast announcements', 'LocalSend-compatible discovery on every adapter', switchEl(d.multicast, (v) => setSetting({ discovery: { multicast: v } }))),
    settingRow('Probe local subnets', 'Also sweep the /24 of each adapter (finds devices where multicast is blocked)', switchEl(d.scanLocalSubnets, (v) => setSetting({ discovery: { scanLocalSubnets: v } }))),
    settingRow('Probe VPN / routed ranges', 'Use the ranges above on every scan', switchEl(d.scanRemote, (v) => setSetting({ discovery: { scanRemote: v } }))),
    settingRow('Automatic rescan', 'Keeps remote devices fresh while the app runs', selectEl([[1, 'Every minute'], [5, 'Every 5 minutes'], [15, 'Every 15 minutes'], [30, 'Every 30 minutes'], [60, 'Every hour']], d.rescanMinutes, (v) => setSetting({ discovery: { rescanMinutes: Number(v) } }))),
    settingRow('Parallel probes', 'Higher is faster but busier for the network', selectEl([[64, '64'], [128, '128'], [256, '256'], [512, '512']], d.concurrency, (v) => setSetting({ discovery: { concurrency: Number(v) } }))),
    settingRow('Probe timeout', 'Raise for slow or high-latency VPN links', selectEl([[500, '500 ms'], [900, '900 ms'], [1500, '1.5 s'], [2500, '2.5 s'], [4000, '4 s']], d.timeoutMs, (v) => setSetting({ discovery: { timeoutMs: Number(v) } }))),
    (() => {
      const inp = h('input', { class: 'field sm', style: { width: '170px' }, value: (d.scanPorts || [53317]).join(', ') });
      inp.addEventListener('change', () => {
        const ports = inp.value.split(/[,\s]+/).map(Number).filter((p) => p > 0 && p < 65536);
        setSetting({ discovery: { scanPorts: ports.length ? ports : [53317] } });
      });
      return settingRow('Ports to probe', 'Comma separated; LocalSend uses 53317', inp);
    })());
  page.append(opts);
  updateNetworkStatus();
  return page;
}

function updateNetworkStatus() {
  const box = $('#netstatus');
  if (!box) return;
  const sc = S.st.scan;
  box.innerHTML = '';
  if (sc.running) {
    const pct = sc.total ? Math.min(100, (sc.done / sc.total) * 100) : 0;
    box.append(h('div', { class: 'scanbar', style: { marginBottom: '12px' } },
      h('div', { class: 'row', style: { minHeight: 0 } }, h('div', { class: 'grow' }, `Scanning ${sc.label || ''} · ${sc.done.toLocaleString()} / ${sc.total.toLocaleString()} · ${plural(sc.found, 'device')} found`), h('button', { class: 'btn text sm', onclick: () => sa.cancelScan() }, 'Stop')),
      h('div', { class: 'progress' }, h('div', { style: { width: pct + '%' } }))));
  } else if (sc.errors?.length) {
    sc.errors.forEach((e) => box.append(h('div', { class: 'chip warn', style: { height: 'auto', padding: '5px 10px', marginBottom: '10px', whiteSpace: 'normal' } }, e)));
  }
  const rg = $('#ranges');
  if (rg) drawRanges(rg);
}

function drawRanges(card) {
  const s = S.st.settings;
  card.innerHTML = '';
  card.append(h('div', { class: 'card-title' }, ico('vpn', 20), 'VPN & routed ranges', h('div', { style: { flex: 1 } }), h('button', { class: 'btn tonal sm', onclick: () => rangeDialog() }, ico('plus', 16), 'Add range')),
    h('div', { class: 'sub' }, 'CIDR (10.20.4.0/24), an address range (10.20.4.10-50) or a single IP — comma separate several.'));
  if (!s.networks.length) card.append(h('div', { class: 'empty', style: { padding: '24px 0' } }, 'No ranges yet. Add one, or use the suggestions below.'));
  s.networks.forEach((n) => {
    const info = S.st.scan.networks?.[n.id];
    const count = countTargets(n.cidr).count;
    card.append(h('div', { class: 'row' },
      switchEl(n.enabled, async (on) => { n.enabled = on; await setSetting({ networks: s.networks }); renderRail(); }),
      h('div', { class: 'grow' },
        h('div', { class: 't' }, n.name || n.cidr, ' ', h('span', { class: `chip ${n.kind === 'vpn' ? 'vpn' : 'routed'}`, style: { marginLeft: '6px' } }, n.kind === 'vpn' ? 'VPN' : 'Routed')),
        h('div', { class: 'd' }, `${n.cidr} · ${plural(count, 'address')}${info ? ` · found ${info.found} · scanned ${ago(info.lastScan)}` : ''}`)),
      h('button', { class: 'icon-btn sm', title: 'Scan this range now', onclick: () => sa.scanNow({ only: n.id }) }, ico('refresh', 18)),
      h('button', { class: 'icon-btn sm', title: 'Edit', onclick: () => rangeDialog(n) }, ico('edit', 18)),
      h('button', { class: 'icon-btn sm', title: 'Delete', onclick: async () => { await setSetting({ networks: s.networks.filter((x) => x.id !== n.id) }); go('networks'); } }, ico('trash', 18))));
  });
}

function drawSuggestions(card) {
  card.innerHTML = '';
  card.append(h('div', { class: 'card-title' }, ico('search', 20), 'Suggested from this PC', h('div', { style: { flex: 1 } }),
    h('button', { class: 'btn text sm', disabled: S.suggesting, onclick: async () => { S.suggesting = true; drawSuggestions(card); S.suggestions = await sa.suggestNetworks(); S.suggesting = false; drawSuggestions(card); } }, ico('refresh', 16, S.suggesting ? 'spin' : ''), S.suggestions ? 'Detect again' : 'Detect')),
    h('div', { class: 'sub' }, 'Reads your adapters and routing table to find VPN tunnels and subnets reachable through your router.'));
  if (S.suggestions) {
    const list = S.suggestions.filter((x) => !x.added && !S.st.settings.networks.some((n) => n.cidr === x.cidr));
    if (!list.length) card.append(h('div', { class: 'sub', style: { padding: '10px 0' } }, 'Nothing new — all detected ranges are already added.'));
    list.forEach((x) => card.append(h('div', { class: 'suggest' },
      h('span', { class: `chip ${x.kind === 'vpn' ? 'vpn' : x.attached ? 'lan' : 'routed'}` }, h('i'), x.kind === 'vpn' ? 'VPN' : x.attached ? 'LAN' : 'Routed'),
      h('div', { class: 'grow', style: { flex: 1, minWidth: 0 } }, h('div', { class: 't' }, x.cidr), h('div', { class: 'd' }, `${x.reason} · via ${x.via} · ${plural(x.hosts, 'address')}`)),
      x.hosts > 65536 ? h('span', { class: 'chip warn' }, 'Too large') : h('button', { class: 'btn tonal sm', onclick: async () => {
        const n = { id: crypto.randomUUID(), name: x.kind === 'vpn' ? `VPN ${x.cidr}` : x.cidr, cidr: x.cidr, kind: x.kind === 'vpn' ? 'vpn' : 'routed', enabled: true };
        await setSetting({ networks: [...S.st.settings.networks, n] });
        go('networks');
        sa.scanNow({ only: n.id });
      } }, ico('plus', 16), 'Add'))));
  }
}

function rangeDialog(existing) {
  const n = existing || { id: crypto.randomUUID(), name: '', cidr: '', kind: 'vpn', enabled: true };
  let kind = n.kind || 'vpn';
  const name = h('input', { class: 'field', value: n.name, placeholder: 'e.g. Head office VPN', autofocus: true });
  const cidr = h('input', { class: 'field', value: n.cidr, placeholder: '10.20.4.0/24' });
  const info = h('div', { class: 'sub', style: { minHeight: '34px', marginTop: '8px' } });
  const kindSeg = h('div');
  const drawKind = () => { kindSeg.innerHTML = ''; kindSeg.append(segmented([['vpn', 'VPN tunnel'], ['routed', 'Routed network']], kind, (v) => { kind = v; drawKind(); })); };
  drawKind();
  const save = h('button', { class: 'btn filled' }, existing ? 'Save' : 'Add & scan');
  const check = () => {
    const r = countTargets(cidr.value);
    const max = S.st.settings.discovery.maxHostsPerNetwork;
    save.disabled = !r.ok || r.count > max;
    if (!cidr.value.trim()) info.textContent = '';
    else if (!r.ok) { info.textContent = r.bad ? `“${r.bad}” is not a valid CIDR, range or IP address.` : 'Enter a range.'; info.style.color = 'var(--error)'; }
    else if (r.count > max) { info.textContent = `${r.count.toLocaleString()} addresses is more than the ${max.toLocaleString()} limit — use a smaller range.`; info.style.color = 'var(--error)'; }
    else {
      const conc = S.st.settings.discovery.concurrency;
      const worst = (r.count / conc) * (S.st.settings.discovery.timeoutMs / 1000);
      info.textContent = `${r.count.toLocaleString()} addresses · a full scan takes up to about ${fmtDur(worst)}${r.count > 4096 ? ' (large — consider a narrower range)' : ''}.`;
      info.style.color = r.count > 4096 ? 'var(--warn)' : '';
    }
  };
  cidr.addEventListener('input', check);
  check();
  save.addEventListener('click', async () => {
    const entry = { ...n, name: name.value.trim() || cidr.value.trim(), cidr: cidr.value.trim(), kind, enabled: true };
    const list = S.st.settings.networks.filter((x) => x.id !== n.id);
    list.push(entry);
    list.sort((a, b) => 0);
    await setSetting({ networks: existing ? S.st.settings.networks.map((x) => (x.id === n.id ? entry : x)) : list });
    closeDialog('range');
    go('networks');
    sa.scanNow({ only: entry.id });
  });
  openDialog('range', dialogShell(existing ? 'Edit range' : 'Add VPN / routed range', [
    h('label', { class: 'label' }, 'Name'), name,
    h('label', { class: 'label' }, 'Addresses (CIDR, range or IP)'), cidr, info,
    h('label', { class: 'label' }, 'Type'), kindSeg,
  ], [h('button', { class: 'btn text', onclick: () => closeDialog('range') }, 'Cancel'), save], { titleIcon: 'vpn' }));
}

/* ---------- Settings ---------- */
function settingsView() {
  const s = S.st.settings;
  const page = h('div', { class: 'page' }, h('h1', null, 'Settings'));

  // General
  const sw = h('div', { class: 'swatches' }, Object.keys(HUES).map((k) => {
    const el = h('button', { class: `swatch${s.accent === k ? ' on' : ''}`, title: k, style: { background: `hsl(${HUES[k]} ${k === 'teal' ? 90 : 65}% 40%)` }, onclick: async () => { await setSetting({ accent: k }); go('settings'); } });
    if (s.accent === k) el.append(ico('check', 16));
    return el;
  }));
  page.append(h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'General'),
    S.st.app?.web ? null : settingRow('Start automatically at start-up', S.st.app?.canAutoStart === false ? 'Available in the installed app' : 'Launch LocalSendPlus when you sign in to Windows, hidden in the tray, so you can always receive', switchEl(s.launchAtLogin, (v) => setSetting({ launchAtLogin: v }))),
    settingRow('Theme', null, selectEl([['system', 'System'], ['light', 'Light'], ['dark', 'Dark'], ['oled', 'OLED black']], s.theme, async (v) => { await setSetting({ theme: v }); go('settings'); })),
    settingRow('Accent colour', null, sw),
    settingRow('Animations', null, switchEl(s.animations, (v) => setSetting({ animations: v }))),
    S.st.app?.web ? null : settingRow('Notifications', 'Show a desktop notification for incoming transfers', switchEl(s.notifications, (v) => setSetting({ notifications: v }))),
    S.st.app?.web ? null : settingRow('Keep running in the tray', 'Closing the window keeps LocalSendPlus receiving in the background', switchEl(s.minimizeToTray, (v) => setSetting({ minimizeToTray: v }))),
    S.st.app?.web ? null : settingRow('Start minimised', 'Also hide the window when you open the app yourself', switchEl(s.startMinimized, (v) => setSetting({ startMinimized: v })))));

  // Receive
  const dest = h('span', { class: 'selectable ellip', style: { maxWidth: '280px' } }, s.destination);
  const pin = h('input', { class: 'field sm', style: { width: '140px' }, value: s.pin, placeholder: 'No PIN', inputmode: 'numeric', type: 'text', maxlength: 12 });
  pin.addEventListener('change', () => setSetting({ pin: pin.value.replace(/\D/g, '') }));
  page.append(h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Receive'),
    settingRow('Quick Save', 'Accept transfers without asking', selectEl([['off', 'Off'], ['favorites', 'Favorites only'], ['on', 'On']], s.quickSave, (v) => setSetting({ quickSave: v }))),
    settingRow('Destination', dest, h('div', { style: { display: 'flex', gap: '4px' } },
      h('button', { class: 'btn text sm', onclick: async () => { const p = await sa.chooseDestination(); if (p) { await setSetting({ destination: p }); dest.textContent = p; } } }, 'Change'),
      h('button', { class: 'icon-btn sm', title: 'Open folder', onclick: () => sa.openPath(s.destination) }, ico('folder', 18)))),
    settingRow('PIN', 'Senders must enter this PIN before they can send to you (recommended across VPNs)', pin),
    settingRow('Copy received text to clipboard', null, switchEl(s.autoCopyText, (v) => setSetting({ autoCopyText: v }))),
    settingRow('Close transfer window when finished', null, switchEl(s.autoFinish, (v) => setSetting({ autoFinish: v }))),
    settingRow('Save history', null, switchEl(s.saveHistory, (v) => setSetting({ saveHistory: v })))));

  // Transfers
  const sharePort = h('input', { class: 'field sm', style: { width: '100px' }, value: s.sharePort, inputmode: 'numeric' });
  sharePort.addEventListener('change', async () => { await setSetting({ sharePort: Number(sharePort.value) }); sharePort.value = S.st.settings.sharePort; });
  page.append(h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Transfers'),
    settingRow('Verify files with checksums', 'Sends a SHA-256 with each file so the receiver can detect corruption (protocol 2.2)', selectEl([['auto', 'Files up to 64 MB'], ['always', 'All files (slower for large files)'], ['off', 'Off']], s.checksums, (v) => setSetting({ checksums: v }))),
    settingRow('Keep original file dates', 'Apply the sender’s modified time to received files', switchEl(s.preserveTimestamps, (v) => setSetting({ preserveTimestamps: v }))),
    settingRow('Share link port', 'Plain-HTTP port used by Share via link (the next free port is used if busy)', sharePort)));

  // Network
  const alias = h('input', { class: 'field sm', style: { width: '190px' }, value: s.alias, maxlength: 40 });
  alias.addEventListener('change', () => setSetting({ alias: alias.value }).then(() => { alias.value = S.st.settings.alias; go('settings'); }));
  const port = h('input', { class: 'field sm', style: { width: '100px' }, value: s.port, inputmode: 'numeric' });
  port.addEventListener('change', async () => { await setSetting({ port: Number(port.value) }); port.value = S.st.settings.port; toast('Port updated — receiver restarted'); });
  const mc = h('input', { class: 'field sm', style: { width: '140px' }, value: s.multicastAddress });
  mc.addEventListener('change', () => { if (/^2(2[4-9]|3\d)\.\d+\.\d+\.\d+$/.test(mc.value)) setSetting({ multicastAddress: mc.value.trim() }); else { mc.value = s.multicastAddress; toast('Enter a valid multicast address (224.0.0.0 – 239.255.255.255)', true); } });
  const mcPort = h('input', { class: 'field sm', style: { width: '84px' }, value: s.multicastPort, inputmode: 'numeric' });
  mcPort.addEventListener('change', async () => { await setSetting({ multicastPort: Number(mcPort.value) }); mcPort.value = S.st.settings.multicastPort; });
  const fw = h('span', { class: 'chip' }, '…');
  const fwBtn = h('button', { class: 'btn outlined sm', style: { display: 'none' } }, 'Allow');
  const refreshFw = async () => {
    const r = await sa.firewallStatus();
    if (!r.supported) { fw.textContent = 'n/a'; return; }
    fw.className = `chip ${r.enabled ? 'ok' : 'warn'}`;
    fw.textContent = r.enabled ? 'Allowed' : 'Not allowed';
    fwBtn.style.display = r.enabled ? 'none' : '';
  };
  fwBtn.addEventListener('click', async () => { fwBtn.disabled = true; await sa.enableFirewall(); await refreshFw(); fwBtn.disabled = false; });
  refreshFw();
  page.append(h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Network'),
    settingRow('Device name', s.aliasCustom ? 'Custom name. Clear it or use the computer icon to follow this PC’s name again' : `Follows this computer’s name (${S.st.app?.machineName || 'this PC'})`, h('div', { style: { display: 'flex', gap: '4px', alignItems: 'center' } }, alias,
      h('button', { class: 'icon-btn sm', title: 'Use this computer’s name', onclick: () => { alias.value = ''; alias.dispatchEvent(new Event('change')); } }, ico('desktop', 18)),
      h('button', { class: 'icon-btn sm', title: 'Random name', onclick: async () => { alias.value = await sa.randomAlias(); alias.dispatchEvent(new Event('change')); } }, ico('refresh', 18)))),
    settingRow('Port', 'TCP + UDP. LocalSend devices expect 53317', port),
    settingRow('Protocol', s.protocol === 'http' ? 'HTTP is unencrypted — only use on trusted networks' : 'HTTPS with a self-signed certificate (like LocalSend)', selectEl([['https', 'HTTPS'], ['http', 'HTTP']], s.protocol, (v) => setSetting({ protocol: v }))),
    settingRow('Multicast group', 'Keep 224.0.0.167 : 53317 to be seen by LocalSend', h('div', { style: { display: 'flex', gap: '6px' } }, mc, mcPort)),
    settingRow('Windows Firewall', `Inbound TCP and UDP ${s.port} on all profiles`, h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, fw, fwBtn))));

  page.append(h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'About'),
    h('div', { class: 'row', style: { borderTop: 0 } }, h('div', { class: 'about-logo', html: logoSvg(56) }), h('div', { class: 'grow' }, h('div', { class: 't', style: { fontSize: '17px' } }, 'LocalSendPlus'), h('div', { class: 'd' }, `Version ${S.st.app?.version || '1.0.0'} · LocalSend protocol v2.2 compatible`))),
    h('div', { class: 'sub', style: { marginTop: '8px', lineHeight: '1.5' } }, 'Send files, folders, text and clipboard contents to devices on your LAN — and to any device reachable through your router or VPN. Interoperates with LocalSend on Windows, macOS, Linux, Android and iOS. Fingerprint: ', h('span', { class: 'selectable', style: { fontSize: '11px' } }, S.st.info.fingerprint.slice(0, 24) + '…'))));
  return page;
}
