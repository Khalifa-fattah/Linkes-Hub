/* Link Hub — Service Worker
 * - ملفات التطبيق: تُخزَّن عند أول زيارة وتُخدَّم من الذاكرة (stale-while-revalidate) فيعمل التطبيق بدون إنترنت.
 * - الخطوط وأيقونات المواقع وSortableJS: تُخزَّن عند أول استخدام (cache-first).
 * - طلبات Google Drive/الحساب لا يتدخل فيها أبداً.
 * عند تعديل ملفات التطبيق غيّر رقم VERSION ليصل التحديث للمستخدمين.
 */
const VERSION = 'v3.0.0';
const SHELL_CACHE = `linkhub-shell-${VERSION}`;
const RUNTIME_CACHE = 'linkhub-runtime-v1';
const RUNTIME_MAX = 300;

const SHELL = [
    './', 'index.html', 'style.css', 'app.js', 'sync.js', 'manifest.webmanifest',
    'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'
];
const OPTIONAL = ['vendor/Sortable.min.js'];

const RUNTIME_HOSTS = [
    'fonts.googleapis.com', 'fonts.gstatic.com',
    'www.google.com',            // أيقونات المواقع (s2/favicons)
    'i.ytimg.com',               // صور يوتيوب المصغّرة
    'cdn.jsdelivr.net'           // SortableJS
];

self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const cache = await caches.open(SHELL_CACHE);
        // cache: 'reload' يتجاوز كاش المتصفح حتى يصل التحديث فعلاً عند تغيير VERSION
        await cache.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })));
        await Promise.all(OPTIONAL.map(u => cache.add(new Request(u, { cache: 'reload' })).catch(() => {})));
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter(k => k.startsWith('linkhub-shell-') && k !== SHELL_CACHE).map(k => caches.delete(k)));
        await self.clients.claim();
    })());
});

async function trim(cacheName, max) {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    if (keys.length > max) await Promise.all(keys.slice(0, keys.length - max).map(k => cache.delete(k)));
}

self.addEventListener('fetch', event => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);

    // صفحة التطبيق (تشمل ?url= من مشاركة الروابط): نخدم index من الذاكرة ونحدّثها في الخلفية
    if (req.mode === 'navigate' && url.origin === self.location.origin) {
        event.respondWith((async () => {
            const cache = await caches.open(SHELL_CACHE);
            const cached = await cache.match('index.html');
            const network = fetch('index.html').then(res => { if (res.ok) cache.put('index.html', res.clone()); return res; }).catch(() => null);
            return cached || (await network) || new Response('غير متصل', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
        })());
        return;
    }

    // ملفات التطبيق نفسه
    if (url.origin === self.location.origin) {
        event.respondWith((async () => {
            const cache = await caches.open(SHELL_CACHE);
            const cached = await cache.match(req, { ignoreSearch: true });
            const network = fetch(req).then(res => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
            return cached || (await network) || Response.error();
        })());
        return;
    }

    // موارد خارجية مسموحة: cache-first
    if (RUNTIME_HOSTS.includes(url.hostname)) {
        event.respondWith((async () => {
            const cache = await caches.open(RUNTIME_CACHE);
            const cached = await cache.match(req);
            if (cached) return cached;
            try {
                const res = await fetch(req);
                if (res.ok || res.type === 'opaque') { cache.put(req, res.clone()); trim(RUNTIME_CACHE, RUNTIME_MAX); }
                return res;
            } catch (e) {
                return Response.error();
            }
        })());
    }
    // أي شيء آخر (Drive, accounts.google.com, noembed...) يمر مباشرة للشبكة
});
