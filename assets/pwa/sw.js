/* YM-TRANSIT ERP · service worker (installation, hors ligne, notifications push) */
const VERSION = "ym-v37";
const STATIC = "ym-static-" + VERSION;
const PRECACHE = [
  "/offline",
  "/assets/css/app.css?v=38",
  "/assets/css/clean.css?v=9",
  "/vendor/instrument-sans/index.css",
  "/vendor/bootstrap/css/bootstrap.min.css",
  "/vendor/bootstrap-icons/bootstrap-icons.min.css",
  "/vendor/bootstrap/js/bootstrap.bundle.min.js",
  "/vendor/inter/index.css",
  "/assets/pwa/icon-192.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(STATIC).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("ym-static-") && k !== STATIC).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Pages : toujours le réseau (données à jour, pas de données métier en cache) ; page hors ligne sinon
  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(() => caches.match("/offline")));
    return;
  }
  // Fichiers statiques : cache d'abord, mise à jour en arrière-plan
  if (url.pathname.startsWith("/vendor/") || url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.open(STATIC).then((cache) =>
        cache.match(req).then((hit) => {
          const net = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => hit);
          return hit || net;
        })
      )
    );
  }
});

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data && event.data.text() }; }
  const title = data.title || "YM-TRANSIT";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      icon: "/assets/pwa/icon-192.png",
      badge: "/assets/pwa/badge-96.png",
      tag: data.tag || undefined,
      renotify: !!data.tag,
      vibrate: [120, 60, 120],
      data: { url: data.url || "/dashboard" },
    }).then(() => self.clients.matchAll({ type: "window" }).then((list) => list.forEach((c) => c.postMessage({ type: "push" }))))
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "/dashboard", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.startsWith(self.location.origin) && "focus" in c) {
          return c.focus().then(() => ("navigate" in c ? c.navigate(target) : null));
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
