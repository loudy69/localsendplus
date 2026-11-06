'use strict';
/* ---------- Share via link (LocalSend protocol section 5: reverse transfer / Download API) ---------- */

function sharing() {
  return !!S.st.share?.active;
}

function shareBar() {
  const box = $('#sharebar');
  if (!box) return;
  box.innerHTML = '';
  if (!sharing()) return;
  const sh = S.st.share;
  box.append(h('div', { class: 'card', style: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' } },
    ico('link', 22),
    h('div', { class: 'grow' }, h('div', { class: 't' }, `Sharing ${plural(sh.files.length, 'item')} via link`), h('div', { class: 'd' }, `${plural(sh.downloads, 'download')} so far`)),
    h('button', { class: 'btn tonal sm', onclick: shareDialog }, 'Show link'),
    h('button', { class: 'btn text sm', onclick: () => sa.shareStop() }, 'Stop')));
}

function minutesLeft(ts) {
  return ts ? Math.max(0, Math.round((ts - Date.now()) / 60000)) : null;
}

function shareDialog() {
  const key = 'share';
  const box = h('div');
  let pinInput;
  let accept = false;
  let expiry = '60';

  const setup = () => {
    box.innerHTML = '';
    if (!S.selection.length) {
      box.append(h('div', { class: 'sub' }, 'Choose files, a folder or some text on the Send page first, then open Share via link again.'));
      return;
    }
    pinInput = h('input', { class: 'field sm', style: { width: '140px' }, placeholder: 'No PIN', inputmode: 'numeric', maxlength: 12 });
    box.append(
      h('div', { class: 'sub', style: { marginBottom: '8px', lineHeight: '1.5' } }, `${plural(selectionCount(), 'file')} (${fmtBytes(selectionSize())}) will be downloadable from any web browser that can reach this PC — no app needed on the other side.`),
      settingRow('PIN', 'Browsers must enter it before they can see the files', pinInput),
      settingRow('Allow without asking', 'Otherwise you approve each new browser', switchEl(accept, (v) => { accept = v; })),
      settingRow('Stop automatically', null, selectEl([['15', 'After 15 minutes'], ['60', 'After 1 hour'], ['240', 'After 4 hours'], ['0', 'Never']], expiry, (v) => { expiry = v; })),
      h('div', { class: 'chip warn', style: { height: 'auto', padding: '8px 12px', marginTop: '10px', whiteSpace: 'normal', lineHeight: '1.4' } }, ico('alert', 16), 'The link uses plain HTTP so browsers accept it. Use a PIN on shared or VPN networks.'));
  };

  const running = () => {
    const sh = S.st.share;
    box.innerHTML = '';
    const first = sh.urls[0];
    const qr = h('div', { class: 'qr' });
    if (first) sa.qr(first.url).then((svg) => { qr.innerHTML = svg; });
    const urlRows = sh.urls.map((u) => h('div', { class: 'row', style: { borderTop: 0, minHeight: '40px' } },
      h('span', { class: `chip ${u.kind === 'vpn' ? 'vpn' : 'lan'}` }, h('i'), u.kind === 'vpn' ? 'VPN' : 'LAN'),
      h('span', { class: 'selectable ellip grow', title: u.name }, u.url),
      h('button', { class: 'icon-btn sm', title: 'Copy link', onclick: () => { sa.copyText(u.url); toast('Link copied'); } }, ico('copy', 18))));
    const left = minutesLeft(sh.expiresAt);
    box.append(...[
      h('div', { style: { display: 'flex', gap: '16px', alignItems: 'flex-start', flexWrap: 'wrap' } }, qr, h('div', { class: 'grow', style: { minWidth: '220px' } }, urlRows.length ? urlRows : h('div', { class: 'sub' }, 'No network address found.'))),
      h('div', { class: 'sub', style: { marginTop: '10px' } }, `${plural(sh.files.length, 'item')} · ${plural(sh.downloads, 'download')}${sh.clients.length ? ` · ${plural(sh.clients.length, 'browser')} connected` : ''}${sh.pin ? ' · PIN protected' : ''}${left !== null ? ` · stops in ${left} min` : ''}`),
      sh.requests.length ? h('div', { style: { marginTop: '10px' } }, sh.requests.map((r) => h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 't' }, r.ip), h('div', { class: 'd' }, 'wants to download')),
        h('button', { class: 'btn text sm', onclick: () => sa.respondShare(r.id, false) }, 'Deny'), h('button', { class: 'btn filled sm', onclick: () => sa.respondShare(r.id, true) }, 'Allow')))) : null,
    ].filter(Boolean));
  };

  const actions = h('div', { style: { display: 'contents' } });
  const drawActions = () => {
    actions.innerHTML = '';
    if (sharing()) {
      actions.append(h('button', { class: 'btn text', onclick: () => closeDialog(key) }, 'Close'),
        h('button', { class: 'btn tonal', onclick: async () => { await sa.shareStop(); closeDialog(key); } }, ico('cancel', 18), 'Stop sharing'));
    } else {
      actions.append(h('button', { class: 'btn text', onclick: () => closeDialog(key) }, 'Cancel'));
      if (S.selection.length) {
        actions.append(h('button', { class: 'btn filled', onclick: async () => {
          const r = await sa.shareStart(S.selection.map(({ kind, path, name, text }) => ({ kind, path, name, text })), { pin: pinInput.value.replace(/\D/g, ''), autoAccept: accept, expiresMinutes: Number(expiry) });
          if (!r.ok) return toast(r.error, true);
          S.st.share = r.share;
        } }, ico('link', 18), 'Start sharing'));
      }
    }
  };
  const draw = () => {
    if (sharing()) running();
    else setup();
    drawActions();
  };
  openDialog(key, dialogShell('Share via link', [box], [actions], { titleIcon: 'link', wide: true }), { update: (st) => { S.st.share = st; draw(); } });
  draw();
}

function shareRequestDialog(r) {
  const key = `share-request:${r.id}`;
  if (S.dialogs.has(key)) return;
  const decide = (ok) => { sa.respondShare(r.id, ok); closeDialog(key, true); };
  openDialog(key, dialogShell('Browser download request', [
    h('div', { class: 'row', style: { borderTop: 0 } }, peerAvatar({ deviceType: 'web', net: r.net }, 44), h('div', { class: 'grow' }, h('div', { class: 't' }, r.ip), h('div', { class: 'd ellip' }, r.userAgent || 'Web browser')), netChip(r.net)),
    h('div', { class: 'sub', style: { marginTop: '8px' } }, 'wants to download the files you are sharing via link.'),
  ], [h('button', { class: 'btn text', onclick: () => decide(false) }, 'Deny'), h('button', { class: 'btn filled', autofocus: true, onclick: () => decide(true) }, ico('check', 18), 'Allow')], { titleIcon: 'link' }), { dismissable: false });
}
