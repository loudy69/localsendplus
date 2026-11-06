'use strict';
// Browser implementation of the `sa` bridge that the desktop app exposes through Electron's preload script.
// Every call is forwarded to the LocalSendPlus Web server; files chosen in the browser are uploaded to a staging
// folder on the host PC first, and the host PC then sends them (the host is the LocalSend endpoint).
(function () {
  const HDR = { 'Content-Type': 'application/json', 'X-LSP': '1' };

  async function call(name, ...args) {
    const r = await fetch('/api/' + name, { method: 'POST', headers: HDR, body: JSON.stringify({ args }) });
    if (r.status === 401) { location.reload(); throw new Error('Signed out'); }
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    return j.result;
  }
  const rpc = (name) => (...args) => call(name, ...args);

  // ---------- events (server-sent events; reload after an outage so the UI never shows stale state)
  const listeners = new Set();
  let lostAt = 0;
  const es = new EventSource('/api/events');
  es.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    listeners.forEach((cb) => cb(msg));
  };
  es.onerror = () => { if (!lostAt) lostAt = Date.now(); };
  es.onopen = () => {
    if (lostAt && Date.now() - lostAt > 4000) location.reload();
    lostAt = 0;
  };

  // ---------- uploads
  const thumbs = new Map();
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

  function snack(text) {
    const el = document.createElement('div');
    el.className = 'snack';
    el.textContent = text;
    document.getElementById('snackbars')?.append(el);
    return { set: (t) => { el.textContent = t; }, done: () => el.remove() };
  }
  function xhrUpload(url, file, onProgress) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('POST', url);
      x.setRequestHeader('X-LSP', '1');
      x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded, e.total); };
      x.onload = () => {
        let j = null;
        try { j = JSON.parse(x.responseText); } catch { /* handled below */ }
        if (x.status >= 300 || !j || j.error) reject(new Error((j && j.error) || 'Upload failed'));
        else resolve(j);
      };
      x.onerror = () => reject(new Error('Upload failed - is the host still reachable?'));
      x.send(file);
    });
  }
  const fmt = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

  async function uploadOne(file, rel, batch, note) {
    const url = `/api/upload?batch=${encodeURIComponent(batch)}&rel=${encodeURIComponent(rel)}`;
    return xhrUpload(url, file, (l, t) => note && note.set(`Uploading ${file.name} - ${Math.round((l / t) * 100)}% of ${fmt(t)}`));
  }

  async function uploadFile(file) {
    const note = snack(`Uploading ${file.name}…`);
    try {
      const r = await uploadOne(file, file.name, uuid(), note);
      if (file.type.startsWith('image/')) thumbs.set(r.path, URL.createObjectURL(file));
      return { id: uuid(), kind: file.type.startsWith('image/') ? 'image' : 'file', path: r.path, name: r.name, size: r.size };
    } finally {
      note.done();
    }
  }

  function choose({ multiple = true, directory = false, accept = '' } = {}) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = multiple;
      if (directory) input.webkitdirectory = true;
      if (accept) input.accept = accept;
      input.style.display = 'none';
      document.body.append(input);
      input.addEventListener('change', () => { resolve([...input.files]); input.remove(); });
      input.addEventListener('cancel', () => { resolve([]); input.remove(); });
      input.click();
    });
  }

  async function uploadFiles(files) {
    const items = [];
    for (const f of files) items.push(await uploadFile(f));
    return items;
  }

  async function uploadFolder(files) {
    if (!files.length) return [];
    const batch = uuid();
    const note = snack(`Uploading ${files.length} files…`);
    const tops = new Map();
    let done = 0;
    let next = 0;
    try {
      const worker = async () => {
        while (next < files.length) {
          const f = files[next++];
          const rel = f.webkitRelativePath || f.name;
          const r = await uploadOne(f, rel, batch, null);
          tops.set(rel.split('/')[0], r.top);
          note.set(`Uploading folder - ${++done} / ${files.length} files`);
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
    } finally {
      note.done();
    }
    return call('describePaths', [...tops.values()]);
  }

  async function readClipboard() {
    const out = { text: null, image: null, files: [] };
    try {
      if (navigator.clipboard && navigator.clipboard.read) {
        for (const it of await navigator.clipboard.read()) {
          const type = it.types.find((t) => t.startsWith('image/'));
          if (type) out.image = await uploadFile(new File([await it.getType(type)], `clipboard-${Date.now()}.png`, { type }));
        }
      }
      const text = navigator.clipboard && navigator.clipboard.readText ? await navigator.clipboard.readText() : '';
      if (text && text.trim() && !out.image) out.text = text;
    } catch { /* permission denied or unsupported - the Ctrl+V handler still works */ }
    return out;
  }

  function copyText(text) {
    const t = String(text);
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(t).catch(() => copyFallback(t));
    return copyFallback(t);
  }
  function copyFallback(t) {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
  }

  function download(p) {
    const a = document.createElement('a');
    a.href = '/dl?p=' + encodeURIComponent(p);
    a.download = '';
    document.body.append(a);
    a.click();
    a.remove();
  }

  window.sa = {
    platform: 'web',
    isWeb: true,
    getState: rpc('getState'),
    pickFiles: async () => uploadFiles(await choose()),
    pickMedia: async () => uploadFiles(await choose({ accept: 'image/*,video/*' })),
    pickFolders: async () => uploadFolder(await choose({ directory: true })),
    uploadFile,
    describePaths: rpc('describePaths'),
    readClipboard,
    saveImageData: rpc('saveImageData'),
    thumbnail: async (p) => thumbs.get(p) || null,
    send: rpc('send'),
    retrySend: rpc('retrySend'),
    shareStart: rpc('shareStart'),
    shareStop: rpc('shareStop'),
    respondShare: rpc('respondShare'),
    qr: rpc('qr'),
    cancelTransfer: rpc('cancelTransfer'),
    respondReceive: rpc('respondReceive'),
    chooseDestination: async () => {
      const cur = (typeof S !== 'undefined' && S.st && S.st.settings && S.st.settings.destination) || '';
      const p = prompt('Folder on the host PC where received files are saved (full path):', cur);
      if (!p || !p.trim()) return null;
      try { return await call('validateDestination', p.trim()); } catch (e) { if (window.toast) toast(e.message, true); return null; }
    },
    scanNow: rpc('scanNow'),
    cancelScan: rpc('cancelScan'),
    addHost: rpc('addHost'),
    removeHost: rpc('removeHost'),
    toggleFavorite: rpc('toggleFavorite'),
    suggestNetworks: rpc('suggestNetworks'),
    updateSettings: rpc('updateSettings'),
    deleteHistory: rpc('deleteHistory'),
    openPath: async (p) => { if (window.toast) toast('Files are stored on the host PC: ' + p); },
    showInFolder: async (p) => download(p),
    copyText,
    firewallStatus: rpc('firewallStatus'),
    enableFirewall: rpc('enableFirewall'),
    randomAlias: rpc('randomAlias'),
    pathForFile: () => '',
    onEvent: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
})();
