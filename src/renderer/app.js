'use strict';
(async function boot() {
  S.st = await sa.getState();
  S.sendMode = 'single';
  applyTheme();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (S.st.settings.theme === 'system') applyTheme(); });

  const app = document.getElementById('app');
  app.append(h('div', { class: 'app' }, h('nav', { class: 'rail', id: 'rail' }), h('main', { class: 'content', id: 'content' })));
  document.body.append(h('div', { id: 'dialogs' }), h('div', { class: 'activity', id: 'activity' }));

  sa.onEvent(onEvent);
  go(window.location.hash === '#receive' ? 'receive' : 'send');
  S.st.requests.forEach(requestDialog);
  (S.st.share?.requests || []).forEach(shareRequestDialog);
  S.st.transfers.filter((t) => !t.endedAt && t.direction === 'receive' && !t.isMessage).forEach((t) => openTransferDialog(t.id));
  if (window.__shotHook) window.__shotHook();

  setInterval(() => { if (S.view === 'networks') updateNetworkStatus(); }, 30000);
})();
