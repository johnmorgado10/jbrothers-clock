// Keeps the Crew Clock page on the phone so it opens with no signal.
// The page itself always tries the network first, so updates show up right away.
const CACHE = "crew-v1";
const SHELL = ["/crew/", "/crew/manifest.webmanifest", "/crew/img/icon-192.png", "/crew/img/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.pathname.startsWith("/api/")) return;
  if (e.request.mode === "navigate" || url.pathname.startsWith("/crew/")) {
    e.respondWith(
      fetch(e.request).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request.mode === "navigate" ? "/crew/" : e.request, copy)); }
        return res;
      }).catch(() => caches.match(e.request.mode === "navigate" ? "/crew/" : e.request).then((r) => r || caches.match("/crew/")))
    );
    return;
  }
  // Fonts: use the saved copy if there is one.
  if (url.hostname.includes("fonts.g")) {
    e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; })));
  }
});
