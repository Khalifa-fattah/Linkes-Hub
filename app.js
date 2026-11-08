/**
 * Link Hub — مكتبة الروابط والمواقع المصنّفة
 * تصنيف ← موقع ← روابط. جوال أولاً، مزامنة عبر Google Drive، وعمل بدون إنترنت (PWA).
 *
 * ملاحظات تقنية:
 *  - كل العناصر لها u (وقت آخر تعديل) والحذف يُسجَّل في tombstones لتعمل المزامنة بالدمج (انظر sync.js).
 *  - لا يوجد onclick داخل HTML: كل الأحداث عبر event delegation وdata-action (أأمن وأسهل صيانة).
 *  - الترتيب بالسحب: اضغط مطوّلاً على البطاقة ثم اسحب.
 */
(() => {
    'use strict';

    /* =====================================================================
       ثوابت وحالة
       ===================================================================== */
    const STORE_KEY = 'link_hub_v3';
    const OLD_KEY = 'user_structured_links_v2';
    const THEME_KEY = 'user_theme_preference';
    const UI_KEY = 'lh_ui_v1';
    const SORTABLE_LOCAL = 'vendor/Sortable.min.js';
    const SORTABLE_CDN = 'https://cdn.jsdelivr.net/npm/sortablejs@1.15.2/Sortable.min.js';
    const DETAIL_SEARCH_MIN = 6;   // يظهر البحث داخل الموقع عندما تزيد الروابط عن هذا العدد
    const UNDO_LIMIT = 20;

    let db = { v: 3, catsU: 0, categories: [], tombstones: {} };
    let ui = { collapsed: {}, lastCat: '' };
    let view = { name: 'home', catId: null, srvId: null };
    let searchQuery = '';
    let detailQuery = '';
    let homeScroll = 0;
    let undoStack = [];
    let sortables = [];
    let dragging = false;
    let pendingRemote = null;
    let deferredInstall = null;
    let panelKind = null;          // 'sync' عندما تكون لوحة المزامنة مفتوحة
    let sheetItems = [];
    let nameCtx = null;
    let confirmResolve = null;
    let toastTimer = null;
    let toastAction = null;
    let lastFocus = null;

    const $ = (s, r = document) => r.querySelector(s);
    const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
    const el = {};

    /* =====================================================================
       أدوات
       ===================================================================== */
    const now = () => Date.now();
    const num = x => (typeof x === 'number' && isFinite(x) ? x : 0);
    const str = x => (typeof x === 'string' ? x : '');
    const arr = x => (Array.isArray(x) ? x : []);
    const uid = p => `${p}-${now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const touch = o => { o.u = now(); return o; };
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const ic = (n, c = '') => `<svg class="ic ${c}" aria-hidden="true"><use href="#i-${n}"/></svg>`;

    const store = {
        get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
        set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
    };

    function nLinks(n) { return n === 0 ? 'بدون روابط' : n === 1 ? 'رابط واحد' : n === 2 ? 'رابطان' : n <= 10 ? `${n} روابط` : `${n} رابطاً`; }
    function nSites(n) { return n === 0 ? 'بدون مواقع' : n === 1 ? 'موقع واحد' : n === 2 ? 'موقعان' : n <= 10 ? `${n} مواقع` : `${n} موقعاً`; }
    function nCats(n) { return n === 1 ? 'تصنيف واحد' : n === 2 ? 'تصنيفان' : n <= 10 ? `${n} تصنيفات` : `${n} تصنيفاً`; }

    /* ----- الروابط ----- */
    function normalizeUrl(raw) {
        let u = str(raw).trim();
        if (!u) return '';
        if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = 'https://' + u.replace(/^\/+/, '');
        try {
            const x = new URL(u);
            if (x.protocol !== 'http:' && x.protocol !== 'https:') return '';
            if (!x.hostname || !x.hostname.includes('.') && x.hostname !== 'localhost') return '';
            return u;
        } catch (e) { return ''; }
    }

    function hostOf(url) {
        try { return new URL(url).hostname.replace(/^www\./i, ''); } catch (e) { return ''; }
    }

    function dupKey(url) {
        return str(url).trim().toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '');
    }

    function getYouTubeVideoId(url) {
        const m = str(url).match(/(?:youtube\.com\/(?:[^/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/|youtube\.com\/shorts\/)([^"&?/\s]{11})/i);
        return m ? m[1] : null;
    }

    function prettySiteName(url) {
        const h = hostOf(url);
        if (!h) return '';
        const parts = h.split('.');
        const base = parts.length > 2 && parts[parts.length - 2].length <= 3 ? parts[parts.length - 3] : parts[parts.length - 2] || parts[0];
        return base.charAt(0).toUpperCase() + base.slice(1);
    }

    function favHtml(url) {
        const h = hostOf(url);
        if (!h) return `<span class="fav fav-fallback">${ic('globe')}</span>`;
        return `<span class="fav"><img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(h)}&sz=64" alt="" width="24" height="24" loading="lazy" decoding="async" draggable="false"></span>`;
    }

    const isRandomCat = c => !!c && (c.isRandom === true || /^(random|عشوائي)$/i.test(str(c.name).trim()));

    /* =====================================================================
       البيانات: تحميل وتنقية وحفظ
       ===================================================================== */
    // fill: قيمة تُستخدم للعناصر التي ليس لها u (0 للبيانات القادمة من المزامنة، now للبيانات القديمة)
    function sanitizeDb(d, fill) {
        const out = { v: 3, catsU: num(d && d.catsU), categories: [], tombstones: {} };
        const seen = new Set();
        const okId = id => { id = str(id).replace(/[^\w-]/g, ''); return id; };
        const take = (id, prefix) => { id = okId(id) || uid(prefix); if (seen.has(id)) return null; seen.add(id); return id; };
        const stamp = (o, extra) => num(o && o.u) || (fill ? (extra || fill) : 0);

        const cats = Array.isArray(d) ? d : arr(d && d.categories);
        cats.forEach(c => {
            if (!c || typeof c !== 'object') return;
            const cid = take(c.id, 'cat'); if (!cid) return;
            const cat = { id: cid, name: str(c.name).trim() || 'بدون اسم', u: stamp(c), sU: num(c.sU), services: [] };
            if (c.isRandom === true) cat.isRandom = true;
            arr(c.services).forEach(s => {
                if (!s || typeof s !== 'object') return;
                const sid = take(s.id, 'srv'); if (!sid) return;
                const srv = { id: sid, name: str(s.name).trim() || 'بدون اسم', isPinned: !!s.isPinned, u: stamp(s), lU: num(s.lU), links: [] };
                arr(s.links).forEach(l => {
                    if (!l || typeof l !== 'object') return;
                    const url = normalizeUrl(l.url); if (!url) return;
                    const lid = take(l.id, 'lnk'); if (!lid) return;
                    srv.links.push({
                        id: lid,
                        title: str(l.title).trim() || hostOf(url) || url,
                        url,
                        notes: str(l.notes),
                        tags: arr(l.tags).map(t => str(t).trim()).filter(Boolean),
                        isPinned: !!l.isPinned,
                        createdAt: num(l.createdAt) || fill || 0,
                        u: stamp(l, num(l.createdAt) || fill)
                    });
                });
                cat.services.push(srv);
            });
            out.categories.push(cat);
        });

        const t = d && !Array.isArray(d) && d.tombstones && typeof d.tombstones === 'object' ? d.tombstones : {};
        Object.keys(t).forEach(k => { if (num(t[k])) out.tombstones[k] = t[k]; });
        return out;
    }

    function loadDb() {
        let parsed = null;
        const raw = store.get(STORE_KEY);
        if (raw) { try { parsed = sanitizeDb(JSON.parse(raw), 0); } catch (e) { parsed = null; } }
        if (!parsed) {
            const old = store.get(OLD_KEY);   // ترحيل من النسخة القديمة
            if (old) { try { parsed = sanitizeDb(JSON.parse(old), now()); } catch (e) { parsed = null; } }
        }
        db = parsed || sanitizeDb({}, 0);
        saveLocal();
    }

    function saveLocal() {
        if (!store.set(STORE_KEY, JSON.stringify(db))) toast('تعذّر الحفظ: مساحة التخزين ممتلئة', { type: 'err' });
    }

    // بعد كل تعديل: حفظ محلي + جدولة مزامنة
    function commit() {
        saveLocal();
        LinkSync.schedule();
    }

    function loadUi() {
        try { const u = JSON.parse(store.get(UI_KEY) || 'null'); if (u && typeof u === 'object') ui = Object.assign(ui, u); } catch (e) { /* ignore */ }
        if (!ui.collapsed || typeof ui.collapsed !== 'object') ui.collapsed = {};
    }
    const saveUi = () => store.set(UI_KEY, JSON.stringify(ui));

    const findCat = id => db.categories.find(c => c.id === id);
    const findSrv = (cid, sid) => { const c = findCat(cid); return c ? c.services.find(s => s.id === sid) : undefined; };
    function findLinkLoc(lid) {
        for (const c of db.categories) for (const s of c.services) {
            const l = s.links.find(x => x.id === lid);
            if (l) return { c, s, l };
        }
        return null;
    }

    /* =====================================================================
       التراجع (Undo) — يعمل مع المزامنة
       ===================================================================== */
    function flat(d) {
        const m = new Map();
        d.categories.forEach(c => {
            m.set(c.id, { obj: c, sig: JSON.stringify([c.name, !!c.isRandom]) });
            c.services.forEach(s => {
                m.set(s.id, { obj: s, sig: JSON.stringify([s.name, s.isPinned, c.id]) });
                s.links.forEach(l => m.set(l.id, { obj: l, sig: JSON.stringify([l.title, l.url, l.notes, l.tags, l.isPinned, s.id]) }));
            });
        });
        return m;
    }

    function pushUndo() {
        undoStack.push(JSON.stringify(db));
        if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    }

    function undo() {
        if (!undoStack.length) return;
        const prev = sanitizeDb(JSON.parse(undoStack.pop()), 0);
        // نجعل ما تغيّر "أحدث" من أي نسخة سحابية حتى لا يلغي الدمج التراجع
        const A = flat(db), B = flat(prev), t = now();
        B.forEach((e, id) => { if (!A.has(id) || A.get(id).sig !== e.sig) e.obj.u = t; delete prev.tombstones[id]; });
        A.forEach((e, id) => { if (!B.has(id)) prev.tombstones[id] = t; });
        prev.catsU = t;
        prev.categories.forEach(c => { c.sU = t; c.services.forEach(s => { s.lU = t; }); });
        db = prev;
        commit();
        if (view.name === 'detail' && !findSrv(view.catId, view.srvId)) { goHome(false); return; }
        render();
        toast('تم التراجع', { type: 'info' });
    }

    /* =====================================================================
       الإشعارات
       ===================================================================== */
    function toast(msg, { type = 'ok', action = null } = {}) {
        el.toastMsg.textContent = msg;
        el.toast.dataset.type = type;
        el.toastIc.innerHTML = ic(type === 'err' ? 'alert' : type === 'info' ? 'info' : 'check');
        toastAction = action ? action.fn : null;
        el.toastAct.hidden = !action;
        if (action) el.toastAct.textContent = action.label;
        el.toast.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.toast.classList.remove('show'), action ? 5500 : 2600);
    }

    /* =====================================================================
       الطبقات: sheet / modal
       ===================================================================== */
    function showLayer(layer) {
        lastFocus = document.activeElement;
        layer.classList.add('open');
        layer.setAttribute('aria-hidden', 'false');
        document.body.classList.add('no-scroll');
    }

    function hideLayer(layer) {
        layer.classList.remove('open');
        layer.setAttribute('aria-hidden', 'true');
        if (!$('.backdrop.open')) document.body.classList.remove('no-scroll');
        if (lastFocus && lastFocus.focus && document.contains(lastFocus)) { try { lastFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
    }

    function closeAllLayers() {
        $$('.backdrop.open').forEach(l => {
            if (l === el.confirmModal) closeConfirm(false);
            else l.classList.remove('open'), l.setAttribute('aria-hidden', 'true');
        });
        document.body.classList.remove('no-scroll');
        panelKind = null;
    }

    function openSheet(title, items, footer) {
        panelKind = null;
        sheetItems = items;
        el.sheetTitle.textContent = title || '';
        el.sheetBody.innerHTML = items.map((it, i) => {
            if (it.sep) return '<div class="sheet-sep"></div>';
            return `<button type="button" class="sheet-item ${it.danger ? 'danger' : ''}" data-sheet="${i}" ${it.disabled ? 'disabled' : ''}>${ic(it.icon)}<span>${esc(it.label)}</span>${it.hint ? `<small>${esc(it.hint)}</small>` : ''}</button>`;
        }).join('') + (footer ? `<div class="sheet-foot">${footer}</div>` : '');
        showLayer(el.sheet);
    }

    function openPanel(title, html, kind) {
        panelKind = kind || null;
        sheetItems = [];
        el.sheetTitle.textContent = title || '';
        el.sheetBody.innerHTML = `<div class="panel">${html}</div>`;
        showLayer(el.sheet);
    }

    function confirmDialog(title, message, okLabel) {
        el.confirmTitle.textContent = title;
        el.confirmMsg.textContent = message;
        el.confirmOk.textContent = okLabel || 'تأكيد';
        showLayer(el.confirmModal);
        return new Promise(res => { confirmResolve = res; });
    }

    function closeConfirm(result) {
        hideLayer(el.confirmModal);
        if (confirmResolve) { const r = confirmResolve; confirmResolve = null; r(result); }
    }

    /* =====================================================================
       الرسم
       ===================================================================== */
    function render() {
        if (view.name === 'detail') {
            if (!renderDetail()) { goHome(false); return; }
        } else {
            renderHome();
        }
        el.homeView.hidden = view.name !== 'home';
        el.detailView.hidden = view.name !== 'detail';
    }

    function linkMatches(l, q) {
        return str(l.title).toLowerCase().includes(q) || str(l.url).toLowerCase().includes(q) ||
            str(l.notes).toLowerCase().includes(q) || arr(l.tags).some(t => t.toLowerCase().includes(q));
    }

    function filterCats(q) {
        if (!q) return db.categories.map(c => ({ cat: c, items: c.services.map(s => ({ srv: s, hit: null })) }));
        const out = [];
        db.categories.forEach(c => {
            const catHit = c.name.toLowerCase().includes(q);
            const items = [];
            c.services.forEach(s => {
                const nameHit = s.name.toLowerCase().includes(q);
                const lhit = s.links.find(l => linkMatches(l, q));
                if (catHit || nameHit || lhit) items.push({ srv: s, hit: (!nameHit && !catHit && lhit) ? lhit : null });
            });
            if (items.length || catHit) out.push({ cat: c, items });
        });
        return out;
    }

    function svcRowHtml(cat, srv, hit) {
        const direct = isRandomCat(cat);
        const first = srv.links[0];
        let sub;
        if (hit) sub = `<span class="hit">${ic('link')}${esc(hit.title)}</span>`;
        else if (direct) sub = `<span class="ltr">${esc(hostOf(first ? first.url : ''))}</span>`;
        else sub = esc(nLinks(srv.links.length));
        if (srv.isPinned) sub += `<span class="pin-mark" title="مثبّت">${ic('pin')}</span>`;
        return `<div class="row svc ${srv.isPinned ? 'pinned' : ''}" role="link" tabindex="0" data-id="${srv.id}" data-cat="${cat.id}" data-action="${direct ? 'open-direct' : 'open-srv'}" ${direct && first ? `data-url="${esc(first.url)}"` : ''}>
            ${favHtml(first ? first.url : '')}
            <div class="row-text"><div class="row-name">${esc(srv.name)}</div><div class="row-sub">${sub}</div></div>
            <button type="button" class="icon-btn" data-action="srv-menu" aria-label="خيارات ${esc(srv.name)}">${ic('more')}</button>
        </div>`;
    }

    function catHtml({ cat, items }, searching) {
        const collapsed = !searching && ui.collapsed[cat.id];
        const links = cat.services.reduce((a, s) => a + s.links.length, 0);
        const meta = isRandomCat(cat) ? nSites(cat.services.length) : `${nSites(cat.services.length)} • ${nLinks(links)}`;
        const body = items.length
            ? items.map(i => svcRowHtml(cat, i.srv, i.hit)).join('')
            : `<div class="cat-empty">لا توجد مواقع بعد — اضغط ⋮ لإضافة أول موقع.</div>`;
        return `<section class="cat ${collapsed ? 'collapsed' : ''}" data-id="${cat.id}">
            <div class="cat-head" data-action="toggle-cat" role="button" tabindex="0" aria-expanded="${!collapsed}">
                <span class="cat-ic">${ic(isRandomCat(cat) ? 'shuffle' : 'folder')}</span>
                <div class="cat-meta"><h2>${esc(cat.name)}</h2><span>${meta}</span></div>
                <button type="button" class="icon-btn" data-action="cat-menu" aria-label="خيارات ${esc(cat.name)}">${ic('more')}</button>
                <span class="chev">${ic('chevron-down')}</span>
            </div>
            <div class="cat-body" data-cat="${cat.id}">${body}</div>
        </section>`;
    }

    function renderHome() {
        const q = searchQuery.trim().toLowerCase();
        const list = filterCats(q);
        el.catList.innerHTML = list.map(x => catHtml(x, !!q)).join('');

        if (!db.categories.length) {
            el.homeEmpty.hidden = false;
            el.homeEmpty.innerHTML = `${ic('layers')}<h3>ابدأ بتنظيم روابطك</h3><p>أضف أول رابط، وسيُنشأ له تصنيف وموقع تلقائياً. يمكنك مشاركة أي رابط من المتصفح إلى هذا التطبيق مباشرة بعد تثبيته.</p><button type="button" class="btn primary" data-action="add">${ic('plus')} إضافة رابط</button>`;
        } else if (!list.length) {
            el.homeEmpty.hidden = false;
            el.homeEmpty.innerHTML = `${ic('search')}<h3>لا توجد نتائج</h3><p>جرّب كلمة أخرى أو جزءاً من الرابط.</p>`;
        } else {
            el.homeEmpty.hidden = true;
        }
        initSortable();
    }

    function linkRowHtml(l) {
        const vid = getYouTubeVideoId(l.url);
        const lead = vid
            ? `<span class="thumb"><img src="https://i.ytimg.com/vi/${vid}/mqdefault.jpg" alt="" loading="lazy" draggable="false">${ic('play', 'play')}</span>`
            : favHtml(l.url);
        const tags = arr(l.tags).map(t => `<button type="button" class="tag" data-action="tag" data-tag="${esc(t)}">#${esc(t)}</button>`).join('');
        const extra = (l.notes || tags)
            ? `<div class="row-extra">${l.notes ? `<p class="note">${esc(l.notes)}</p>` : ''}${tags ? `<div class="tags">${tags}</div>` : ''}</div>` : '';
        return `<li class="row link ${l.isPinned ? 'pinned' : ''}" data-id="${l.id}">
            <div class="row-top">
                <a class="row-main" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer" draggable="false">
                    ${lead}
                    <div class="row-text">
                        <div class="row-name">${esc(l.title)}</div>
                        <div class="row-sub"><span class="ltr">${esc(hostOf(l.url))}</span>${l.isPinned ? `<span class="pin-mark" title="مثبّت">${ic('pin')}</span>` : ''}</div>
                    </div>
                </a>
                <button type="button" class="icon-btn" data-action="link-menu" aria-label="خيارات الرابط">${ic('more')}</button>
            </div>
            ${extra}
        </li>`;
    }

    function renderDetail() {
        const cat = findCat(view.catId);
        const srv = cat && cat.services.find(s => s.id === view.srvId);
        if (!srv) return false;

        el.detailName.textContent = srv.name;
        el.detailMeta.textContent = `${cat.name} • ${nLinks(srv.links.length)}`;

        const showSearch = srv.links.length >= DETAIL_SEARCH_MIN || !!detailQuery;
        el.detailSearchWrap.hidden = !showSearch;

        const q = detailQuery.trim().toLowerCase();
        const links = srv.links.filter(l => !q || linkMatches(l, q));
        el.linkList.innerHTML = links.map(linkRowHtml).join('');

        if (!links.length) {
            el.detailEmpty.hidden = false;
            el.detailEmpty.innerHTML = q
                ? `${ic('search')}<h3>لا توجد نتائج</h3><p>لا يوجد رابط يطابق بحثك داخل هذا الموقع.</p>`
                : `${ic('link')}<h3>لا توجد روابط بعد</h3><p>اضغط زر + لإضافة أول رابط لهذا الموقع.</p>`;
        } else {
            el.detailEmpty.hidden = true;
        }
        initSortable();
        return true;
    }

    /* =====================================================================
       التنقل (يدعم زر الرجوع في الجوال)
       ===================================================================== */
    function showService(catId, srvId, query) {
        homeScroll = window.scrollY;
        view = { name: 'detail', catId, srvId };
        detailQuery = query || '';
        el.detailSearch.value = detailQuery;
        history.pushState({ lh: 'detail', catId, srvId }, '');
        render();
        window.scrollTo(0, 0);
    }

    function goHome(useHistory = true) {
        if (useHistory && history.state && history.state.lh === 'detail') { history.back(); return; }
        view = { name: 'home', catId: null, srvId: null };
        render();
        window.scrollTo(0, homeScroll);
    }

    window.addEventListener('popstate', e => {
        closeAllLayers();
        const s = e.state;
        if (s && s.lh === 'detail' && findSrv(s.catId, s.srvId)) {
            view = { name: 'detail', catId: s.catId, srvId: s.srvId };
            render();
            window.scrollTo(0, 0);
        } else {
            view = { name: 'home', catId: null, srvId: null };
            render();
            window.scrollTo(0, homeScroll);
        }
    });

    /* =====================================================================
       السحب للترتيب: ضغطة مطوّلة على البطاقة ثم سحب
       ===================================================================== */
    function loadSortable() {
        if (typeof Sortable !== 'undefined') return Promise.resolve();
        const add = src => new Promise((res, rej) => {
            const s = document.createElement('script');
            s.src = src; s.async = true; s.onload = res; s.onerror = () => rej(new Error('load'));
            document.head.appendChild(s);
        });
        return add(SORTABLE_LOCAL).catch(() => add(SORTABLE_CDN)).catch(() => { /* بدون سحب */ });
    }

    const sameOrder = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

    function initSortable() {
        sortables.forEach(s => { try { s.destroy(); } catch (e) { /* ignore */ } });
        sortables = [];
        if (typeof Sortable === 'undefined') return;

        const base = {
            animation: 180, delay: 280, delayOnTouchOnly: true, touchStartThreshold: 8,
            ghostClass: 'drag-ghost', chosenClass: 'drag-chosen',
            onStart: () => { dragging = true; if (navigator.vibrate) navigator.vibrate(10); }
        };

        if (view.name === 'home' && !searchQuery.trim()) {
            sortables.push(new Sortable(el.catList, Object.assign({}, base, {
                draggable: '.cat', handle: '.cat-head', onEnd: onCatsEnd
            })));
            $$('.cat-body', el.catList).forEach(body => {
                sortables.push(new Sortable(body, Object.assign({}, base, {
                    group: 'services', draggable: '.svc', onEnd: onServicesEnd
                })));
            });
        } else if (view.name === 'detail' && !detailQuery.trim()) {
            sortables.push(new Sortable(el.linkList, Object.assign({}, base, {
                draggable: '.link', onEnd: onLinksEnd
            })));
        }
    }

    function endDrag() {
        dragging = false;
        if (pendingRemote) { const d = pendingRemote; pendingRemote = null; applyRemote(d); }
    }

    function onCatsEnd() {
        const ids = $$('.cat', el.catList).map(x => x.dataset.id);
        if (!sameOrder(ids, db.categories.map(c => c.id))) {
            pushUndo();
            db.categories = ids.map(findCat).filter(Boolean);
            db.catsU = now();
            commit();
            toast('تم تحديث ترتيب التصنيفات', { type: 'info' });
        }
        endDrag();
    }

    function onServicesEnd(evt) {
        const fromCat = findCat(evt.from.dataset.cat), toCat = findCat(evt.to.dataset.cat);
        const movedId = evt.item.dataset.id;
        const ids = $$('.svc', evt.to).map(x => x.dataset.id);
        if (fromCat && toCat) {
            const cross = fromCat !== toCat;
            if (cross || !sameOrder(ids, toCat.services.map(s => s.id))) {
                pushUndo();
                const t = now();
                if (cross) {
                    const i = fromCat.services.findIndex(s => s.id === movedId);
                    if (i > -1) { const [srv] = fromCat.services.splice(i, 1); toCat.services.push(touch(srv)); }
                    fromCat.sU = t;
                }
                toCat.services = ids.map(id => toCat.services.find(s => s.id === id)).filter(Boolean);
                toCat.sU = t;
                commit();
                if (cross) { render(); toast(`نُقل إلى «${toCat.name}»`, { type: 'info', action: { label: 'تراجع', fn: undo } }); }
                else toast('تم تحديث الترتيب', { type: 'info' });
            }
        }
        endDrag();
    }

    function onLinksEnd() {
        const srv = findSrv(view.catId, view.srvId);
        if (srv) {
            const ids = $$('.link', el.linkList).map(x => x.dataset.id);
            if (!sameOrder(ids, srv.links.map(l => l.id))) {
                pushUndo();
                srv.links = ids.map(id => srv.links.find(l => l.id === id)).filter(Boolean);
                srv.lU = now();
                commit();
                renderDetail();
                toast('تم تحديث ترتيب الروابط', { type: 'info' });
            }
        }
        endDrag();
    }

    /* =====================================================================
       العمليات على البيانات
       ===================================================================== */
    function setPinned(list, item, val) {
        const i = list.indexOf(item);
        if (i > -1) list.splice(i, 1);
        item.isPinned = val;
        touch(item);
        if (val) list.unshift(item);
        else { let k = 0; while (k < list.length && list[k].isPinned) k++; list.splice(k, 0, item); }
    }

    function togglePinService(catId, srvId) {
        const cat = findCat(catId), srv = findSrv(catId, srvId);
        if (!srv) return;
        pushUndo();
        setPinned(cat.services, srv, !srv.isPinned);
        cat.sU = now();
        commit(); render();
        toast(srv.isPinned ? 'تم التثبيت في الأعلى' : 'أُلغي التثبيت', { type: 'info' });
    }

    function togglePinLink(linkId) {
        const loc = findLinkLoc(linkId);
        if (!loc) return;
        pushUndo();
        setPinned(loc.s.links, loc.l, !loc.l.isPinned);
        loc.s.lU = now();
        commit(); render();
        toast(loc.l.isPinned ? 'تم التثبيت في الأعلى' : 'أُلغي التثبيت', { type: 'info' });
    }

    function deleteLink(linkId) {
        const loc = findLinkLoc(linkId);
        if (!loc) return;
        pushUndo();
        loc.s.links = loc.s.links.filter(l => l.id !== linkId);
        loc.s.lU = now();
        db.tombstones[linkId] = now();
        commit(); render();
        toast('تم حذف الرابط', { type: 'info', action: { label: 'تراجع', fn: undo } });
    }

    function deleteService(catId, srvId) {
        const cat = findCat(catId), srv = findSrv(catId, srvId);
        if (!srv) return;
        pushUndo();
        cat.services = cat.services.filter(s => s.id !== srvId);
        cat.sU = now();
        db.tombstones[srvId] = now();
        commit();
        if (view.name === 'detail') goHome(false); else render();
        toast(`تم حذف «${srv.name}»`, { type: 'info', action: { label: 'تراجع', fn: undo } });
    }

    async function deleteCategory(catId) {
        const cat = findCat(catId);
        if (!cat) return;
        const n = cat.services.length;
        if (n) {
            const ok = await confirmDialog(`حذف «${cat.name}»؟`, `سيُحذف التصنيف مع ${nSites(n)} وجميع الروابط بداخله.`, 'حذف');
            if (!ok) return;
        }
        pushUndo();
        db.categories = db.categories.filter(c => c.id !== catId);
        db.catsU = now();
        db.tombstones[catId] = now();
        commit(); render();
        toast(`تم حذف «${cat.name}»`, { type: 'info', action: { label: 'تراجع', fn: undo } });
    }

    function moveService(catId, srvId, targetId) {
        const from = findCat(catId), to = findCat(targetId), srv = findSrv(catId, srvId);
        if (!from || !to || !srv || from === to) return;
        pushUndo();
        from.services = from.services.filter(s => s.id !== srvId);
        to.services.push(touch(srv));
        from.sU = to.sU = now();
        commit();
        if (view.name === 'detail') { view.catId = targetId; history.replaceState({ lh: 'detail', catId: targetId, srvId }, ''); }
        render();
        toast(`نُقل «${srv.name}» إلى «${to.name}»`, { type: 'info', action: { label: 'تراجع', fn: undo } });
    }

    async function openAllLinks(catId, srvId) {
        const srv = findSrv(catId, srvId);
        if (!srv || !srv.links.length) { toast('لا توجد روابط لفتحها', { type: 'err' }); return; }
        if (srv.links.length > 5) {
            const ok = await confirmDialog('فتح جميع الروابط', `سيتم فتح ${nLinks(srv.links.length)} في تبويبات جديدة. قد يمنع المتصفح بعضها.`, 'فتح');
            if (!ok) return;
        }
        srv.links.forEach(l => window.open(l.url, '_blank', 'noopener'));
    }

    function copyText(text) {
        const done = () => toast('تم نسخ الرابط');
        const fail = () => toast('تعذّر النسخ', { type: 'err' });
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fail);
        else {
            try {
                const ta = document.createElement('textarea');
                ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
                document.body.appendChild(ta); ta.select();
                document.execCommand('copy'); ta.remove(); done();
            } catch (e) { fail(); }
        }
    }

    /* =====================================================================
       القوائم
       ===================================================================== */
    function openMenu() {
        const cats = db.categories.length;
        const sites = db.categories.reduce((a, c) => a + c.services.length, 0);
        const links = db.categories.reduce((a, c) => a + c.services.reduce((b, s) => b + s.links.length, 0), 0);
        const light = document.documentElement.dataset.theme === 'light';
        const items = [
            { icon: 'folder-plus', label: 'تصنيف جديد', fn: () => openNameModal({ mode: 'new-cat' }, 'تصنيف جديد', '', 'اسم التصنيف') },
            { icon: 'undo', label: 'تراجع عن آخر إجراء', disabled: !undoStack.length, fn: undo },
            { icon: light ? 'moon' : 'sun', label: light ? 'المظهر الداكن' : 'المظهر الفاتح', fn: toggleTheme },
            { icon: 'cloud', label: 'المزامنة والنسخ الاحتياطي', fn: openSyncPanel }
        ];
        if (deferredInstall) items.push({ icon: 'install', label: 'تثبيت التطبيق على الجهاز', fn: installApp });
        openSheet('', items, `${nCats(cats)} • ${nSites(sites)} • ${nLinks(links)}`);
    }

    function openCatMenu(catId) {
        const cat = findCat(catId);
        if (!cat) return;
        openSheet(cat.name, [
            { icon: 'plus', label: 'إضافة رابط هنا', fn: () => openLinkModal({ catName: cat.name }) },
            { icon: 'pencil', label: 'إعادة تسمية التصنيف', fn: () => openNameModal({ mode: 'rename-cat', catId }, 'إعادة تسمية التصنيف', cat.name, 'الاسم الجديد') },
            { sep: true },
            { icon: 'trash', label: 'حذف التصنيف', danger: true, fn: () => deleteCategory(catId) }
        ]);
    }

    function openSrvMenu(catId, srvId, fromDetail) {
        const cat = findCat(catId), srv = findSrv(catId, srvId);
        if (!srv) return;
        const direct = isRandomCat(cat) && srv.links[0];
        const items = [];
        if (fromDetail) items.push({ icon: 'plus', label: 'إضافة رابط', fn: () => openLinkModal({ catName: cat.name, srvName: srv.name }) });
        if (srv.links.length > 1) items.push({ icon: 'external', label: 'فتح كل الروابط', fn: () => openAllLinks(catId, srvId) });
        if (direct) {
            items.push({ icon: 'copy', label: 'نسخ الرابط', fn: () => copyText(srv.links[0].url) });
            items.push({ icon: 'pencil', label: 'تعديل الرابط', fn: () => openLinkModal({ editId: srv.links[0].id }) });
        }
        items.push({ icon: 'pin', label: srv.isPinned ? 'إلغاء التثبيت' : 'تثبيت في الأعلى', fn: () => togglePinService(catId, srvId) });
        items.push({ icon: 'pencil', label: 'إعادة تسمية الموقع', fn: () => openNameModal({ mode: 'rename-srv', catId, srvId }, 'إعادة تسمية الموقع', srv.name, 'الاسم الجديد') });
        if (db.categories.length > 1) items.push({ icon: 'move', label: 'نقل إلى تصنيف آخر', fn: () => openMoveSheet(catId, srvId) });
        items.push({ sep: true });
        items.push({ icon: 'trash', label: 'حذف الموقع', danger: true, fn: () => deleteService(catId, srvId) });
        openSheet(srv.name, items);
    }

    function openMoveSheet(catId, srvId) {
        openSheet('نقل إلى تصنيف', db.categories.filter(c => c.id !== catId).map(c => ({
            icon: isRandomCat(c) ? 'shuffle' : 'folder', label: c.name, fn: () => moveService(catId, srvId, c.id)
        })));
    }

    function openLinkMenu(linkId) {
        const loc = findLinkLoc(linkId);
        if (!loc) return;
        openSheet(loc.l.title, [
            { icon: 'pin', label: loc.l.isPinned ? 'إلغاء التثبيت' : 'تثبيت في الأعلى', fn: () => togglePinLink(linkId) },
            { icon: 'copy', label: 'نسخ الرابط', fn: () => copyText(loc.l.url) },
            { icon: 'pencil', label: 'تعديل', fn: () => openLinkModal({ editId: linkId }) },
            { sep: true },
            { icon: 'trash', label: 'حذف الرابط', danger: true, fn: () => deleteLink(linkId) }
        ]);
    }

    /* =====================================================================
       نافذة الاسم (تصنيف جديد / إعادة تسمية)
       ===================================================================== */
    function openNameModal(ctx, title, value, label) {
        nameCtx = ctx;
        $('#nameModalTitle').textContent = title;
        $('#nameLabel').textContent = label || 'الاسم';
        el.nameInput.value = value || '';
        showLayer(el.nameModal);
        setTimeout(() => { el.nameInput.focus(); el.nameInput.select(); }, 120);
    }

    function submitName(e) {
        e.preventDefault();
        const name = el.nameInput.value.trim();
        if (!name || !nameCtx) return;
        const ctx = nameCtx;
        const dupe = db.categories.some(c => c.name.toLowerCase() === name.toLowerCase() && c.id !== ctx.catId);

        if (ctx.mode === 'new-cat') {
            if (dupe) { toast('هذا التصنيف موجود بالفعل', { type: 'err' }); return; }
            pushUndo();
            db.categories.push({ id: uid('cat'), name, u: now(), sU: 0, services: [] });
            db.catsU = now();
            toast(`تم إنشاء «${name}»`);
        } else if (ctx.mode === 'rename-cat') {
            const cat = findCat(ctx.catId);
            if (!cat) return;
            if (dupe) { toast('هذا الاسم مستخدم لتصنيف آخر', { type: 'err' }); return; }
            pushUndo(); cat.name = name; touch(cat);
            toast('تم تحديث الاسم');
        } else if (ctx.mode === 'rename-srv') {
            const srv = findSrv(ctx.catId, ctx.srvId);
            if (!srv) return;
            pushUndo(); srv.name = name; touch(srv);
            toast('تم تحديث الاسم');
        }
        hideLayer(el.nameModal);
        nameCtx = null;
        commit(); render();
    }

    /* =====================================================================
       نافذة الرابط
       ===================================================================== */
    let ytFetchToken = 0;

    function refreshSuggestions() {
        el.catDatalist.innerHTML = db.categories.map(c => `<option value="${esc(c.name)}">`).join('');
        const cat = db.categories.find(c => c.name.toLowerCase() === el.catInput.value.trim().toLowerCase());
        const names = new Set();
        (cat ? [cat] : db.categories).forEach(c => c.services.forEach(s => names.add(s.name)));
        el.srvDatalist.innerHTML = [...names].map(n => `<option value="${esc(n)}">`).join('');
    }

    function setUrlHint(html, cls) {
        el.urlHint.hidden = !html;
        el.urlHint.className = 'hint ' + (cls || '');
        el.urlHint.innerHTML = html || '';
    }

    function openLinkModal(opts = {}) {
        const loc = opts.editId ? findLinkLoc(opts.editId) : null;
        $('#linkModalTitle').textContent = loc ? 'تعديل الرابط' : 'رابط جديد';
        $('#saveLinkBtn').textContent = loc ? 'حفظ التعديل' : 'حفظ';
        el.editLinkId.value = loc ? loc.l.id : '';
        ytFetchToken++;
        setUrlHint('');

        if (loc) {
            el.urlInput.value = loc.l.url;
            el.titleInput.value = loc.l.title;
            el.catInput.value = loc.c.name;
            el.srvInput.value = loc.s.name;
            el.tagsInput.value = arr(loc.l.tags).join('، ');
            el.notesInput.value = loc.l.notes || '';
            el.moreBox.open = !!(loc.l.tags.length || loc.l.notes);
        } else {
            el.urlInput.value = opts.url || '';
            el.titleInput.value = opts.title || '';
            el.catInput.value = opts.catName || (db.categories.some(c => c.name === ui.lastCat) ? ui.lastCat : (db.categories[0] ? db.categories[0].name : ''));
            el.srvInput.value = opts.srvName || '';
            el.tagsInput.value = '';
            el.notesInput.value = '';
            el.moreBox.open = false;
        }
        refreshSuggestions();
        showLayer(el.linkModal);
        if (el.urlInput.value) onUrlInput();
        setTimeout(() => {
            const target = loc ? el.titleInput : (el.urlInput.value ? (el.catInput.value ? el.titleInput : el.catInput) : el.urlInput);
            target.focus();
        }, 150);
    }

    function closeLinkModal() { hideLayer(el.linkModal); }

    async function onUrlInput() {
        const raw = el.urlInput.value.trim();
        const url = normalizeUrl(raw);
        const vid = getYouTubeVideoId(raw);
        const myToken = ++ytFetchToken;

        const editId = el.editLinkId.value;
        let dup = null;
        if (url) {
            const k = dupKey(url);
            for (const c of db.categories) for (const s of c.services) for (const l of s.links) {
                if (l.id !== editId && dupKey(l.url) === k) dup = { c, s, l };
            }
        }
        if (dup) { setUrlHint(`${ic('alert')} محفوظ مسبقاً في «${esc(dup.s.name)}» ضمن «${esc(dup.c.name)}»`, 'warn'); return; }
        if (vid) {
            setUrlHint(`${ic('play')} رابط يوتيوب — سيُجلب العنوان والصورة تلقائياً`, 'yt');
            if (!el.srvInput.value.trim()) el.srvInput.value = 'YouTube';
            if (!el.titleInput.value.trim()) {
                try {
                    const res = await fetch('https://noembed.com/embed?url=' + encodeURIComponent(url));
                    if (res.ok) {
                        const data = await res.json();
                        if (data.title && myToken === ytFetchToken && !el.titleInput.value.trim()) el.titleInput.value = data.title;
                    }
                } catch (e) { /* بدون إنترنت: نتجاهل */ }
            }
            return;
        }
        setUrlHint('');
    }

    function submitLink(e) {
        e.preventDefault();
        const url = normalizeUrl(el.urlInput.value);
        const catName = el.catInput.value.trim();
        if (!url) { setUrlHint(`${ic('alert')} الرابط غير صالح`, 'warn'); el.urlInput.focus(); return; }
        if (!catName) { el.catInput.focus(); return; }

        const random = isRandomCat({ name: catName }) || (findCatByName(catName) && isRandomCat(findCatByName(catName)));
        const srvName = el.srvInput.value.trim() || prettySiteName(url) || hostOf(url);
        const title = el.titleInput.value.trim() || (random ? 'الصفحة الرئيسية' : (hostOf(url) || url));
        const tags = el.tagsInput.value.split(/[,،]/).map(t => t.trim()).filter(Boolean);
        const notes = el.notesInput.value.trim();
        const editId = el.editLinkId.value;
        const t = now();

        pushUndo();

        let cat = findCatByName(catName);
        if (!cat) { cat = { id: uid('cat'), name: catName, u: t, sU: 0, services: [] }; db.categories.push(cat); db.catsU = t; }
        let srv = cat.services.find(s => s.name.toLowerCase() === srvName.toLowerCase());
        if (!srv) { srv = { id: uid('srv'), name: srvName, isPinned: false, u: t, lU: 0, links: [] }; cat.services.push(srv); cat.sU = t; }

        if (editId) {
            const loc = findLinkLoc(editId);
            if (loc) {
                Object.assign(loc.l, { title, url, tags, notes });
                touch(loc.l);
                if (loc.s !== srv) {
                    loc.s.links = loc.s.links.filter(l => l.id !== editId);
                    loc.s.lU = t;
                    srv.links.push(loc.l);
                    srv.lU = t;
                } else loc.s.lU = loc.s.lU || 0;
            }
        } else {
            srv.links.push({ id: uid('lnk'), title, url, notes, tags, isPinned: false, createdAt: t, u: t });
            srv.lU = t;
        }

        ui.lastCat = cat.name; saveUi();
        closeLinkModal();
        commit(); render();
        toast(editId ? 'تم حفظ التعديل' : `تمت الإضافة إلى «${srv.name}»`);
    }

    const findCatByName = name => db.categories.find(c => c.name.toLowerCase() === str(name).trim().toLowerCase());

    function openAddFromContext() {
        if (view.name === 'detail') {
            const cat = findCat(view.catId), srv = findSrv(view.catId, view.srvId);
            if (cat && srv) { openLinkModal({ catName: cat.name, srvName: srv.name }); return; }
        }
        openLinkModal({});
    }

    /* =====================================================================
       المظهر
       ===================================================================== */
    function applyTheme(theme) {
        document.documentElement.dataset.theme = theme;
        el.metaTheme.setAttribute('content', theme === 'light' ? '#f3f6fb' : '#0b1220');
    }
    function loadTheme() {
        let t = store.get(THEME_KEY);
        if (t !== 'light' && t !== 'dark') t = window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
        applyTheme(t);
    }
    function toggleTheme() {
        const t = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
        applyTheme(t); store.set(THEME_KEY, t);
    }

    /* =====================================================================
       المزامنة (واجهة)
       ===================================================================== */
    function timeAgo(ts) {
        if (!ts) return '';
        const s = Math.max(0, Math.round((now() - ts) / 1000));
        if (s < 45) return 'الآن';
        const m = Math.round(s / 60);
        if (m < 60) return `منذ ${m} د`;
        const h = Math.round(m / 60);
        if (h < 24) return `منذ ${h} ساعة`;
        return new Date(ts).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' });
    }

    function syncText(st) {
        switch (st.state) {
            case 'off': return 'المزامنة غير مفعّلة';
            case 'busy': return 'جارٍ المزامنة…';
            case 'ok': return st.time ? `تمت المزامنة ${timeAgo(st.time)}` : 'المزامنة مفعّلة';
            case 'auth': return 'سجّل الدخول لمتابعة المزامنة';
            case 'offline': return 'لا يوجد اتصال — ستتم المزامنة لاحقاً';
            default: return 'تعذّرت المزامنة' + (st.message ? ` (${st.message})` : '');
        }
    }

    function updateSyncUi(st) {
        el.syncBtn.dataset.state = st.state;
        el.syncBtn.title = syncText(st);
        el.syncBtn.setAttribute('aria-label', 'المزامنة: ' + syncText(st));
        const use = el.syncBtn.querySelector('use');
        if (use) use.setAttribute('href', st.state === 'off' || st.state === 'offline' ? '#i-cloud-off' : '#i-cloud');
        if (panelKind === 'sync') renderSyncPanel();
    }

    function renderSyncPanel() {
        const st = LinkSync.status();
        const hasId = !!LinkSync.getClientId();
        const connected = LinkSync.isConnected();
        let body = `<div class="status-line" data-state="${st.state}"><span class="dot"></span><strong>${esc(syncText(st))}</strong></div>`;

        if (!hasId) {
            body += `<p class="help">لمزامنة روابطك بين جوالك وكمبيوترك عبر Google Drive، أنشئ Client ID مجاناً من Google Cloud (الخطوات في ملف README) والصقه هنا. تُحفظ البيانات في مجلد التطبيق الخاص بك فقط ولا يرى التطبيق بقية ملفاتك.</p>
                <label class="field"><span>Client ID</span><input id="clientIdInput" type="text" dir="ltr" placeholder="xxxxxxxx.apps.googleusercontent.com" autocomplete="off" autocapitalize="none" spellcheck="false"></label>
                <div class="btn-row"><button type="button" class="btn primary" data-action="save-client">حفظ وتفعيل</button></div>`;
        } else if (!connected) {
            body += `<p class="help">اربط حساب Google لتبقى روابطك متطابقة على كل أجهزتك.</p>
                <div class="btn-row"><button type="button" class="btn primary" data-action="sync-connect">ربط حساب Google</button></div>`;
        } else {
            const needAuth = st.state === 'auth';
            body += `<div class="btn-row">
                <button type="button" class="btn primary" data-action="sync-now">${ic('refresh')} ${needAuth ? 'تسجيل الدخول' : 'مزامنة الآن'}</button>
                <button type="button" class="btn" data-action="sync-off">قطع الاتصال</button></div>
                <p class="help" style="margin-top:10px">يُحدَّث تلقائياً بعد كل تعديل وعند فتح التطبيق. قطع الاتصال لا يحذف بياناتك من الجهاز.</p>`;
        }

        body += `<details><summary>نسخة احتياطية يدوية (اختياري)</summary>
            <div class="btn-row"><button type="button" class="btn" data-action="export">${ic('download')} تصدير</button>
            <button type="button" class="btn" data-action="import">${ic('upload')} استيراد</button></div>
            <p class="help" style="margin-top:10px">الاستيراد يدمج الملف مع بياناتك الحالية ولا يمحوها.</p></details>`;
        el.sheetBody.innerHTML = `<div class="panel">${body}</div>`;
    }

    function openSyncPanel() {
        panelKind = 'sync';
        sheetItems = [];
        el.sheetTitle.textContent = 'المزامنة والنسخ الاحتياطي';
        renderSyncPanel();
        showLayer(el.sheet);
    }

    // استلام نسخة مدمجة من المزامنة
    function applyRemote(doc) {
        if (dragging) { pendingRemote = doc; return; }
        db = sanitizeDb(doc, 0);
        saveLocal();
        if (view.name === 'detail' && !findSrv(view.catId, view.srvId)) { view = { name: 'home', catId: null, srvId: null }; }
        render();
    }

    /* =====================================================================
       نسخ احتياطي يدوي
       ===================================================================== */
    function exportData() {
        const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `link-hub-backup-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        toast('تم تصدير النسخة الاحتياطية');
    }

    function importData(file) {
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const parsed = JSON.parse(reader.result);
                const imported = sanitizeDb(parsed, now());
                if (!imported.categories.length) { toast('الملف لا يحتوي بيانات صالحة', { type: 'err' }); return; }
                pushUndo();
                db = sanitizeDb(LinkSync.merge(db, imported), 0);
                commit(); render();
                closeAllLayers();
                toast('تم دمج النسخة الاحتياطية', { action: { label: 'تراجع', fn: undo } });
            } catch (e) { toast('تعذّرت قراءة الملف', { type: 'err' }); }
        };
        reader.readAsText(file);
    }

    /* =====================================================================
       PWA: التثبيت، المشاركة، Service Worker
       ===================================================================== */
    function installApp() {
        if (!deferredInstall) return;
        deferredInstall.prompt();
        deferredInstall.userChoice.finally(() => { deferredInstall = null; });
    }

    function handleLaunchParams() {
        const p = new URLSearchParams(location.search);
        if (!p.has('add') && !p.has('url') && !p.has('text') && !p.has('title')) return;
        const text = `${p.get('url') || ''} ${p.get('text') || ''}`;
        const m = text.match(/https?:\/\/[^\s]+/i);
        const url = m ? m[0] : '';
        const title = p.get('title') || '';
        history.replaceState({ lh: 'home' }, '', location.pathname);
        openLinkModal({ url, title: url && title && title !== url ? title : '' });
    }

    function registerSW() {
        if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
            navigator.serviceWorker.register('sw.js').catch(() => { /* ignore */ });
        }
    }

    /* =====================================================================
       الأحداث
       ===================================================================== */
    function runSheetItem(i) {
        const it = sheetItems[i];
        if (!it || it.disabled) return;
        hideLayer(el.sheet);
        setTimeout(() => it.fn && it.fn(), 120);
    }

    function onClick(e) {
        const t = e.target;

        // عناصر القائمة
        const si = t.closest('[data-sheet]');
        if (si) { runSheetItem(Number(si.dataset.sheet)); return; }

        // إغلاق عند الضغط على الخلفية أو زر الإلغاء
        if (t.classList && t.classList.contains('backdrop')) {
            if (t === el.confirmModal) closeConfirm(false); else { hideLayer(t); panelKind = null; }
            return;
        }
        if (t.closest('[data-close]')) { const l = t.closest('.backdrop'); if (l) hideLayer(l); return; }

        const a = t.closest('[data-action]');
        if (!a) return;
        const act = a.dataset.action;
        const row = a.closest('[data-id]');

        switch (act) {
            case 'add': openAddFromContext(); break;
            case 'toggle-cat': {
                const sec = a.closest('.cat'); if (!sec) break;
                const id = sec.dataset.id;
                if (ui.collapsed[id]) delete ui.collapsed[id]; else ui.collapsed[id] = 1;
                saveUi();
                sec.classList.toggle('collapsed', !!ui.collapsed[id]);
                a.setAttribute('aria-expanded', String(!ui.collapsed[id]));
                break;
            }
            case 'cat-menu': openCatMenu(a.closest('.cat').dataset.id); break;
            case 'open-srv': showService(a.dataset.cat, a.dataset.id); break;
            case 'open-direct': if (a.dataset.url) window.open(a.dataset.url, '_blank', 'noopener'); break;
            case 'srv-menu': openSrvMenu(row.dataset.cat, row.dataset.id, false); break;
            case 'link-menu': openLinkMenu(row.dataset.id); break;
            case 'tag': detailQuery = a.dataset.tag; el.detailSearch.value = detailQuery; renderDetail(); window.scrollTo(0, 0); break;
            case 'save-client': {
                const v = ($('#clientIdInput') || {}).value;
                if (!v || !v.trim()) { toast('أدخل Client ID أولاً', { type: 'err' }); break; }
                LinkSync.setClientId(v);
                LinkSync.connect();
                break;
            }
            case 'sync-connect': LinkSync.connect(); break;
            case 'sync-now': LinkSync.syncNow({ interactive: true }); break;
            case 'sync-off': LinkSync.disconnect(); toast('تم قطع الاتصال', { type: 'info' }); break;
            case 'export': exportData(); break;
            case 'import': el.importInput.click(); break;
            default: break;
        }
    }

    function bindEvents() {
        document.addEventListener('click', onClick);

        // تفعيل الصفوف بلوحة المفاتيح
        document.addEventListener('keydown', e => {
            if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('.row.svc, .cat-head')) {
                e.preventDefault(); e.target.click();
            }
            const mod = e.ctrlKey || e.metaKey;
            const typing = /^(input|textarea|select)$/i.test((document.activeElement || {}).tagName || '');
            if (mod && /^k$/i.test(e.key)) { e.preventDefault(); if (view.name !== 'home') goHome(); el.searchInput.focus(); el.searchInput.select(); }
            else if (mod && /^n$/i.test(e.key)) { e.preventDefault(); openAddFromContext(); }
            else if (mod && /^z$/i.test(e.key) && !typing) { e.preventDefault(); undo(); }
            else if (e.key === 'Escape') {
                const open = $$('.backdrop.open').pop();
                if (open) { if (open === el.confirmModal) closeConfirm(false); else { hideLayer(open); panelKind = null; } }
            }
        });

        // القائمة المنبثقة: على الجوال نمنع قائمة المتصفح (تتعارض مع السحب)، وعلى سطح المكتب يفتح كليك يمين قائمة البطاقة
        const coarse = window.matchMedia('(pointer: coarse)');
        document.addEventListener('contextmenu', e => {
            const card = e.target.closest('.row, .cat-head');
            if (!card) return;
            if (coarse.matches) { e.preventDefault(); return; }
            const btn = card.querySelector('[data-action$="-menu"]');
            if (btn) { e.preventDefault(); btn.click(); }
        });

        // أيقونة الموقع: في حال فشل التحميل نعرض أيقونة بديلة
        document.addEventListener('error', e => {
            const img = e.target;
            if (img && img.tagName === 'IMG' && img.closest('.fav')) {
                const box = img.closest('.fav');
                box.classList.add('fav-fallback');
                box.innerHTML = ic('globe');
            }
        }, true);

        el.brandBtn.addEventListener('click', () => { if (view.name === 'home') window.scrollTo({ top: 0, behavior: 'smooth' }); else goHome(); });
        el.backBtn.addEventListener('click', () => goHome());
        el.menuBtn.addEventListener('click', openMenu);
        el.detailMenuBtn.addEventListener('click', () => openSrvMenu(view.catId, view.srvId, true));
        el.fabBtn.addEventListener('click', openAddFromContext);

        el.syncBtn.addEventListener('click', () => {
            const st = LinkSync.status();
            if (!LinkSync.isConnected()) openSyncPanel();
            else if (st.state === 'auth') LinkSync.syncNow({ interactive: true });
            else if (st.state === 'error') openSyncPanel();
            else { LinkSync.syncNow({}); toast('جارٍ المزامنة…', { type: 'info' }); }
        });

        // البحث (مع تأخير بسيط)
        let st;
        el.searchInput.addEventListener('input', () => {
            el.clearSearchBtn.hidden = !el.searchInput.value;
            clearTimeout(st);
            st = setTimeout(() => { searchQuery = el.searchInput.value; renderHome(); }, 90);
        });
        el.clearSearchBtn.addEventListener('click', () => {
            el.searchInput.value = ''; searchQuery = ''; el.clearSearchBtn.hidden = true; renderHome(); el.searchInput.focus();
        });
        el.detailSearch.addEventListener('input', () => { detailQuery = el.detailSearch.value; renderDetail(); });

        // نموذج الرابط
        el.linkForm.addEventListener('submit', submitLink);
        el.urlInput.addEventListener('input', onUrlInput);
        el.urlInput.addEventListener('blur', () => {
            // عند ترك الحقل نُكمل العنوان من اسم الموقع إن بقي فارغاً (بدون كتابة فوق ما أدخله المستخدم)
            if (!el.titleInput.value.trim()) {
                const u = normalizeUrl(el.urlInput.value);
                if (u && !getYouTubeVideoId(u)) el.titleInput.placeholder = hostOf(u);
            }
        });
        el.catInput.addEventListener('input', refreshSuggestions);
        el.nameForm.addEventListener('submit', submitName);

        el.confirmOk.addEventListener('click', () => closeConfirm(true));
        el.confirmCancel.addEventListener('click', () => closeConfirm(false));
        el.toastAct.addEventListener('click', () => { const f = toastAction; el.toast.classList.remove('show'); if (f) f(); });

        el.importInput.addEventListener('change', e => { const f = e.target.files[0]; if (f) importData(f); e.target.value = ''; });

        window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; });
        window.addEventListener('appinstalled', () => { deferredInstall = null; toast('تم تثبيت التطبيق'); });
    }

    /* =====================================================================
       البداية
       ===================================================================== */
    function cacheEls() {
        const ids = ['homeView', 'detailView', 'catList', 'homeEmpty', 'linkList', 'detailEmpty', 'detailName', 'detailMeta', 'detailSearch', 'detailSearchWrap',
            'searchInput', 'clearSearchBtn', 'brandBtn', 'backBtn', 'menuBtn', 'detailMenuBtn', 'syncBtn', 'fabBtn',
            'sheet', 'sheetTitle', 'sheetBody', 'linkModal', 'linkForm', 'nameModal', 'nameForm', 'nameInput', 'confirmModal', 'confirmTitle', 'confirmMsg', 'confirmOk', 'confirmCancel',
            'toast', 'toastIc', 'toastMsg', 'toastAct', 'importInput', 'metaTheme',
            'urlInput', 'urlHint', 'titleInput', 'catInput', 'srvInput', 'tagsInput', 'notesInput', 'editLinkId'];
        ids.forEach(id => { el[id] = document.getElementById(id); });
        el.catDatalist = document.getElementById('catList2');
        el.srvDatalist = document.getElementById('srvList2');
        el.moreBox = document.querySelector('#linkForm details.more');
    }

    function boot() {
        cacheEls();
        loadTheme();
        loadUi();
        loadDb();
        bindEvents();
        history.replaceState({ lh: 'home' }, '');
        render();
        loadSortable().then(() => initSortable());

        LinkSync.init({
            getDoc: () => db,
            sanitize: d => sanitizeDb(d, 0),
            applyDoc: applyRemote,
            onStatus: updateSyncUi
        });
        handleLaunchParams();
        LinkSync.start();
        registerSW();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
