/*
 * ALVOXIS Flow service worker.
 * Security policy: business data (HTML pages, API responses) is NEVER cached. Only the
 * localized offline fallback pages and static icons are cached, so a shared or lost device
 * does not retain company data.
 */
const CACHE = "alvoxis-static-v1";
const LOCALES = ["en", "ru", "lv", "lt", "et"];
const PRECACHE = [...LOCALES.map((l) => `/${l}/offline`), "/icons/icon.svg", "/icons/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || req.mode !== "navigate") return;
  event.respondWith(
    fetch(req).catch(async () => {
      const seg = new URL(req.url).pathname.split("/")[1];
      const locale = LOCALES.includes(seg) ? seg : "en";
      return (await caches.match(`/${locale}/offline`)) ?? Response.error();
    }),
  );
});
