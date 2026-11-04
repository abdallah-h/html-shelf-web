/* رفّ المشاريع — web version only (registered from index.html when not in the Android app).
   Makes the website installable and usable offline:
   - the shelf itself (page, scripts, project list, icons): network first, so a deploy shows up on the next visit;
     the cached copy when offline
   - projects, website projects, bundled fonts/libraries, the search index: the cached copy right away, refreshed in
     the background (a project opened once works offline after that)
   Google sign-in / Drive requests go to other sites and are never cached. */
const CACHE = "shelf-v1";
const CORE = ["./", "index.html", "projects/projects.js", "js/version.js", "js/native.js", "js/cloud.js", "js/web-config.js",
  "manifest.webmanifest", "icons/icon-96.png", "icons/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const isAsset = (p) => /\/(projects|sites|vendor|icons)\//.test(p) && !/projects\/projects\.js$/.test(p);

self.addEventListener("fetch", (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (isAsset(url.pathname)) {
    // cached right away, refreshed in the background
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const hit = await c.match(req, { ignoreSearch: true });
      const net = fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
  } else {
    // the shelf: newest when online, cached when offline
    e.respondWith(fetch(req).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return r;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match("index.html"))));
  }
});
