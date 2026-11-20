/**
 * Link Hub — المزامنة السحابية
 * تدعم مزودين:
 *  1. Google Drive (مجلد التطبيق الخاص appDataFolder)
 *  2. GitHub Gist (Secret Gist دائم الصلاحية عبر Personal Access Token)
 *
 * الفكرة:
 *  - كل عنصر (تصنيف / موقع / رابط) له حقل u = وقت آخر تعديل.
 *  - الحذف يُسجَّل في tombstones لتعمل المزامنة بالدمج الدقيق (LWW).
 *  - يتم دمج الخزينة المشفرة (vault) تلقائياً بالأحدث زمناً.
 */
(function (root) {
  'use strict';

  // معرّف العميل الافتراضي لـ Google Drive
  const DEFAULT_CLIENT_ID = '952971060139-a996b1mbvik9v7jr02l0rccj24j22q5e.apps.googleusercontent.com';

  const FILE_NAME = 'linkhub-data.json';
  const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
  const UNSORTED_ID = 'cat-unsorted';
  const TOMB_TTL = 120 * 24 * 3600 * 1000; // 120 يوماً
  const POLL_MS = 90 * 1000;

  const LS = {
    provider: 'lh_sync_provider', // 'drive' أو 'gist'
    // Google Drive
    clientId: 'lh_client_id',
    token: 'lh_token',
    connected: 'lh_connected',
    fileId: 'lh_file_id',
    last: 'lh_last_sync',
    // GitHub Gist
    gistToken: 'lh_gist_token',
    gistId: 'lh_gist_id',
    gistConnected: 'lh_gist_connected',
    gistLast: 'lh_gist_last_sync'
  };

  /* ------------------------------------------------------------------ */
  /*  أدوات                                                              */
  /* ------------------------------------------------------------------ */
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  };

  function stable(v) {
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    if (v && typeof v === 'object') {
      return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort()
        .map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
    }
    return JSON.stringify(v);
  }

  const ids = list => (list || []).map(x => x.id);
  const num = x => (typeof x === 'number' && isFinite(x) ? x : 0);

  /* ------------------------------------------------------------------ */
  /*  الدمج (Conflict-free LWW Merge)                                    */
  /* ------------------------------------------------------------------ */
  function indexDoc(doc) {
    const cats = new Map(), srvs = new Map(), lnks = new Map();
    (doc.categories || []).forEach(c => {
      cats.set(c.id, { item: c, u: num(c.u), parent: null });
      (c.services || []).forEach(s => {
        srvs.set(s.id, { item: s, u: num(s.u), parent: c.id });
        (s.links || []).forEach(l => lnks.set(l.id, { item: l, u: num(l.u), parent: s.id }));
      });
    });
    return { cats, srvs, lnks };
  }

  function pick(ma, mb, tomb) {
    const out = new Map();
    new Set([...ma.keys(), ...mb.keys()]).forEach(id => {
      const x = ma.get(id), y = mb.get(id);
      const w = !x ? y : !y ? x : (y.u > x.u ? y : x);
      if (tomb[id] !== undefined && tomb[id] >= w.u) return;
      out.set(id, { item: w.item, u: w.u, parent: w.parent });
    });
    return out;
  }

  function order(la, sa, lb, sb, valid) {
    const first = sb > sa ? lb : la, second = sb > sa ? la : lb;
    const ok = new Set(valid), seen = new Set(), out = [];
    [first, second, valid].forEach(list => list.forEach(id => {
      if (ok.has(id) && !seen.has(id)) { seen.add(id); out.push(id); }
    }));
    return out;
  }

  function merge(a, b, nowTs) {
    const now = nowTs || Date.now();
    const tomb = {};
    [a.tombstones, b.tombstones].forEach(t => {
      Object.keys(t || {}).forEach(id => { if (!(tomb[id] >= t[id])) tomb[id] = t[id]; });
    });
    Object.keys(tomb).forEach(id => { if (now - tomb[id] > TOMB_TTL) delete tomb[id]; });

    const A = indexDoc(a), B = indexDoc(b);
    const cats = pick(A.cats, B.cats, tomb);
    const srvs = pick(A.srvs, B.srvs, tomb);
    const lnks = pick(A.lnks, B.lnks, tomb);

    srvs.forEach((w, id) => {
      if (cats.has(w.parent)) return;
      if (w.u > (tomb[w.parent] || 0)) {
        w.parent = UNSORTED_ID;
        if (!cats.has(UNSORTED_ID)) {
          cats.set(UNSORTED_ID, { item: { id: UNSORTED_ID, name: 'غير مصنف', u: now, sU: 0, services: [] }, u: now, parent: null });
        }
      } else srvs.delete(id);
    });
    lnks.forEach((w, id) => { if (!srvs.has(w.parent)) lnks.delete(id); });

    const kids = (map, pid) => [...map.entries()].filter(([, w]) => w.parent === pid).map(([id]) => id);
    const stamp = (w, key) => (w ? num(w.item[key]) : 0);

    const catOrder = order(ids(a.categories), num(a.catsU), ids(b.categories), num(b.catsU), [...cats.keys()]);

    const categories = catOrder.map(cid => {
      const ca = A.cats.get(cid), cb = B.cats.get(cid);
      const cat = Object.assign({}, cats.get(cid).item);
      delete cat.services;
      cat.sU = Math.max(stamp(ca, 'sU'), stamp(cb, 'sU'));
      const sids = order(
        ca ? ids(ca.item.services) : [], stamp(ca, 'sU'),
        cb ? ids(cb.item.services) : [], stamp(cb, 'sU'),
        kids(srvs, cid)
      );
      cat.services = sids.map(sid => {
        const sa = A.srvs.get(sid), sb = B.srvs.get(sid);
        const srv = Object.assign({}, srvs.get(sid).item);
        delete srv.links;
        srv.lU = Math.max(stamp(sa, 'lU'), stamp(sb, 'lU'));
        const lids = order(
          sa ? ids(sa.item.links) : [], stamp(sa, 'lU'),
          sb ? ids(sb.item.links) : [], stamp(sb, 'lU'),
          kids(lnks, sid)
        );
        srv.links = lids.map(lid => Object.assign({}, lnks.get(lid).item));
        return srv;
      });
      return cat;
    });

    const out = { v: 3, catsU: Math.max(num(a.catsU), num(b.catsU)), categories, tombstones: tomb };
    // دمج الخزينة المشفرة بالأحدث
    const va = a && a.vault, vb = b && b.vault;
    if (va || vb) {
      out.vault = (!va) ? vb : (!vb) ? va : ((num(vb.u)) > (num(va.u)) ? vb : va);
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /*  الحالة والمزود                                                     */
  /* ------------------------------------------------------------------ */
  let cfg = null;               // { getDoc, sanitize, applyDoc, onStatus }
  let tokenClient = null;
  let pendingTok = null;
  let gisPromise = null;
  let syncing = false;
  let again = false;
  let timer = null;
  let started = false;
  let status = { state: 'off', provider: 'drive', time: 0, message: '' };

  function getProvider() {
    const p = ls.get(LS.provider);
    if (p === 'gist' || p === 'drive') return p;
    if (ls.get(LS.gistConnected) === '1') return 'gist';
    if (ls.get(LS.connected) === '1') return 'drive';
    return 'drive';
  }

  function setProvider(p) {
    if (p === 'gist' || p === 'drive') {
      ls.set(LS.provider, p);
      setStatus(baseState());
    }
  }

  const getClientId = () => (ls.get(LS.clientId) || DEFAULT_CLIENT_ID || '').trim();
  const getGistToken = () => (ls.get(LS.gistToken) || '').trim();
  const getGistId = () => (ls.get(LS.gistId) || '').trim();

  function isConnected() {
    const p = getProvider();
    if (p === 'gist') return !!getGistToken() && ls.get(LS.gistConnected) === '1';
    return !!getClientId() && ls.get(LS.connected) === '1';
  }

  function setStatus(state, message) {
    const p = getProvider();
    const lastTime = p === 'gist' ? Number(ls.get(LS.gistLast)) || 0 : Number(ls.get(LS.last)) || 0;
    status = { state, provider: p, time: lastTime, message: message || '' };
    if (cfg && cfg.onStatus) cfg.onStatus(status);
  }

  function baseState() { return isConnected() ? 'ok' : 'off'; }

  /* ------------------------------------------------------------------ */
  /*  1) Google Drive                                                    */
  /* ------------------------------------------------------------------ */
  function readToken() {
    try {
      const t = JSON.parse(ls.get(LS.token) || 'null');
      if (t && t.t && t.exp - 60000 > Date.now()) return t.t;
    } catch (e) { /* ignore */ }
    return null;
  }

  function loadGis() {
    if (root.google && root.google.accounts && root.google.accounts.oauth2) return Promise.resolve();
    if (gisPromise) return gisPromise;
    gisPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { gisPromise = null; reject(new Error('offline')); };
      document.head.appendChild(s);
    });
    return gisPromise;
  }

  function requestToken(interactive) {
    return loadGis().then(() => new Promise((resolve, reject) => {
      if (!tokenClient) {
        tokenClient = root.google.accounts.oauth2.initTokenClient({
          client_id: getClientId(),
          scope: SCOPE,
          callback: r => {
            const p = pendingTok; pendingTok = null;
            if (!p) return;
            if (r.error || !r.access_token) { p.reject(new Error('auth')); return; }
            ls.set(LS.token, JSON.stringify({ t: r.access_token, exp: Date.now() + (Number(r.expires_in) || 3600) * 1000 }));
            p.resolve(r.access_token);
          },
          error_callback: () => { const p = pendingTok; pendingTok = null; if (p) p.reject(new Error('auth')); }
        });
      }
      pendingTok = { resolve, reject };
      try { tokenClient.requestAccessToken({ prompt: interactive ? '' : 'none' }); }
      catch (e) { pendingTok = null; reject(new Error('auth')); }
    }));
  }

  async function ensureDriveToken(opts) {
    const t = readToken();
    if (t) return t;
    // محاولة التجديد الصامت التلقائي في الخلفية أولاً دون مقاطعة المستخدم
    try {
      return await requestToken(false);
    } catch (e) {
      if (opts && (opts.interactive || opts.silentAuth)) {
        return await requestToken(!!opts.interactive);
      }
      throw new Error('auth');
    }
  }

  async function driveApi(url, init) {
    const token = readToken();
    if (!token) throw new Error('auth');
    const res = await fetch(url, Object.assign({}, init, {
      headers: Object.assign({}, (init && init.headers) || {}, { Authorization: 'Bearer ' + token })
    }));
    if (res.status === 401) { ls.del(LS.token); throw new Error('auth'); }
    return res;
  }

  async function findDriveFile() {
    const q = encodeURIComponent("name='" + FILE_NAME + "'");
    const res = await driveApi('https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=' + q +
      '&fields=files(id,modifiedTime)&orderBy=modifiedTime%20desc&pageSize=1');
    if (!res.ok) throw new Error('http-' + res.status);
    const data = await res.json();
    return (data.files && data.files[0]) || null;
  }

  async function downloadDriveFile(id) {
    const res = await driveApi('https://www.googleapis.com/drive/v3/files/' + id + '?alt=media');
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error('http-' + res.status);
    return res.json();
  }

  async function createDriveFile(doc) {
    const boundary = 'lh' + Date.now().toString(36);
    const body = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify({ name: FILE_NAME, parents: ['appDataFolder'], mimeType: 'application/json' }) +
      '\r\n--' + boundary + '\r\nContent-Type: application/json\r\n\r\n' + JSON.stringify(doc) +
      '\r\n--' + boundary + '--';
    const res = await driveApi('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/related; boundary=' + boundary },
      body
    });
    if (!res.ok) throw new Error('http-' + res.status);
    return (await res.json()).id;
  }

  async function updateDriveFile(id, doc) {
    const res = await driveApi('https://www.googleapis.com/upload/drive/v3/files/' + id + '?uploadType=media', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(doc)
    });
    if (!res.ok) throw new Error('http-' + res.status);
  }

  /* ------------------------------------------------------------------ */
  /*  2) GitHub Gist                                                     */
  /* ------------------------------------------------------------------ */
  async function gistApi(endpoint, init = {}) {
    const token = getGistToken();
    if (!token) throw new Error('auth');
    const headers = Object.assign({
      'Accept': 'application/vnd.github.v3+json',
      'Authorization': 'token ' + token,
      'X-GitHub-Api-Version': '2022-11-28'
    }, init.headers || {});

    const res = await fetch('https://api.github.com' + endpoint, Object.assign({}, init, { headers }));
    if (res.status === 401 || res.status === 403) throw new Error('auth');
    return res;
  }

  async function findExistingGist() {
    const res = await gistApi('/gists?per_page=50');
    if (!res.ok) throw new Error('http-' + res.status);
    const list = await res.json();
    if (!Array.isArray(list)) return null;
    const found = list.find(g => (g.files && g.files[FILE_NAME]) || (g.description && g.description.includes('Link Hub')));
    return found ? found.id : null;
  }

  async function downloadGist(id) {
    const res = await gistApi('/gists/' + id);
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error('http-' + res.status);
    const data = await res.json();
    const file = data.files && data.files[FILE_NAME];
    if (!file) return undefined;
    if (file.truncated && file.raw_url) {
      const rawRes = await fetch(file.raw_url);
      return rawRes.json();
    }
    return JSON.parse(file.content);
  }

  async function createGist(doc) {
    const res = await gistApi('/gists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: 'Link Hub Sync Data (Private Backup)',
        public: false,
        files: {
          [FILE_NAME]: {
            content: JSON.stringify(doc, null, 2)
          }
        }
      })
    });
    if (!res.ok) throw new Error('http-' + res.status);
    const data = await res.json();
    return data.id;
  }

  async function updateGist(id, doc) {
    const res = await gistApi('/gists/' + id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: {
          [FILE_NAME]: {
            content: JSON.stringify(doc, null, 2)
          }
        }
      })
    });
    if (!res.ok) throw new Error('http-' + res.status);
  }

  /* ------------------------------------------------------------------ */
  /*  المزامنة الموحدة                                                   */
  /* ------------------------------------------------------------------ */
  async function syncNow(opts) {
    if (!cfg || !isConnected()) return;
    if (syncing) { again = true; return; }
    syncing = true;
    setStatus('busy');

    try {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error('offline');

      const p = getProvider();
      let remote = null;

      if (p === 'gist') {
        let gistId = getGistId();
        if (gistId) {
          remote = await downloadGist(gistId);
          if (remote === undefined) { gistId = null; remote = null; ls.del(LS.gistId); }
        }
        if (!gistId) {
          gistId = await findExistingGist();
          if (gistId) remote = await downloadGist(gistId);
        }
        if (remote !== null && remote !== undefined) remote = cfg.sanitize(remote);

        const local = cfg.getDoc();
        const merged = remote ? merge(local, remote) : local;
        const mergedStr = stable(merged);

        if (stable(local) !== mergedStr) cfg.applyDoc(merged);

        if (!remote || stable(remote) !== mergedStr) {
          if (gistId) await updateGist(gistId, merged);
          else gistId = await createGist(merged);
        }
        ls.set(LS.gistId, gistId);
        ls.set(LS.gistLast, String(Date.now()));
        setStatus('ok');

      } else {
        // Google Drive
        await ensureDriveToken(opts);

        let fileId = ls.get(LS.fileId);
        if (fileId) {
          remote = await downloadDriveFile(fileId);
          if (remote === undefined) { fileId = null; remote = null; ls.del(LS.fileId); }
        }
        if (!fileId) {
          const f = await findDriveFile();
          if (f) { fileId = f.id; remote = await downloadDriveFile(fileId); }
        }
        if (remote !== null && remote !== undefined) remote = cfg.sanitize(remote);

        const local = cfg.getDoc();
        const merged = remote ? merge(local, remote) : local;
        const mergedStr = stable(merged);

        if (stable(local) !== mergedStr) cfg.applyDoc(merged);

        if (!remote || stable(remote) !== mergedStr) {
          if (fileId) await updateDriveFile(fileId, merged);
          else fileId = await createDriveFile(merged);
        }
        ls.set(LS.fileId, fileId);
        ls.set(LS.last, String(Date.now()));
        setStatus('ok');
      }

    } catch (e) {
      const m = String(e && e.message || e);
      if (m === 'auth') {
        setStatus('auth', getProvider() === 'gist' ? 'رمز GitHub غير صالح أو منتهي' : '');
      } else if (m === 'offline' || e instanceof TypeError) {
        setStatus('offline');
      } else {
        setStatus('error', m);
      }
    } finally {
      syncing = false;
      if (again) { again = false; schedule(400); }
    }
  }

  function schedule(ms) {
    if (!cfg || !isConnected()) return;
    clearTimeout(timer);
    timer = setTimeout(() => syncNow({}), typeof ms === 'number' ? ms : 2000);
  }

  function start() {
    if (started || typeof document === 'undefined') return;
    started = true;
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') schedule(500); });
    root.addEventListener('online', () => schedule(500));
    setInterval(() => { if (document.visibilityState === 'visible') syncNow({}); }, POLL_MS);
    if (isConnected()) syncNow({ silentAuth: true });
    else setStatus('off');
  }

  // Google Drive connect / disconnect
  async function connect() {
    if (!getClientId()) return;
    ls.set(LS.provider, 'drive');
    ls.set(LS.connected, '1');
    await syncNow({ interactive: true });
  }

  function disconnect() {
    const t = readToken();
    try { if (t && root.google && root.google.accounts) root.google.accounts.oauth2.revoke(t, () => {}); } catch (e) { /* ignore */ }
    [LS.token, LS.connected, LS.fileId, LS.last].forEach(ls.del);
    tokenClient = null;
    setStatus('off');
  }

  function setClientId(id) {
    const v = String(id || '').trim();
    if (v) ls.set(LS.clientId, v); else ls.del(LS.clientId);
    tokenClient = null;
    setStatus(baseState());
  }

  // GitHub Gist connect / disconnect
  async function connectGist(token) {
    const t = String(token || '').trim();
    if (!t) throw new Error('أدخل رمز GitHub');
    ls.set(LS.gistToken, t);
    ls.set(LS.gistConnected, '1');
    ls.set(LS.provider, 'gist');
    setStatus('busy');
    await syncNow({});
  }

  function disconnectGist() {
    [LS.gistToken, LS.gistConnected, LS.gistId, LS.gistLast].forEach(ls.del);
    setStatus('off');
  }

  function init(config) { cfg = config; }

  const api_ = {
    init, start, schedule, syncNow,
    getProvider, setProvider,
    connect, disconnect, setClientId, getClientId,
    connectGist, disconnectGist, getGistToken, getGistId,
    isConnected, merge, stable,
    status: () => status,
    UNSORTED_ID
  };

  if (typeof module === 'object' && module.exports) module.exports = api_;
  else root.LinkSync = api_;
})(typeof window !== 'undefined' ? window : globalThis);
