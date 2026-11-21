/* 오프라인 실행용: 앱 화면 파일을 기기에 저장 (카드 데이터는 IndexedDB에 따로 저장됨) */
const CACHE = "carddb-app-v1.5.0";
const FILES = ["./", "index.html", "app.js", "jszip.min.js", "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png", "fonts/GowunDodum-Regular.woff2", "fonts/Jua-Regular.woff2"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET" || e.request.url.includes("/seed/")) return;   // 기본 카드 데이터는 저장해 두지 않음 (한 번만 씀)
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => {
    const net = fetch(e.request).then(r => { if (r.ok && new URL(e.request.url).origin === location.origin) { const c = r.clone(); caches.open(CACHE).then(x => x.put(e.request, c)); } return r; }).catch(() => hit);
    return hit || net;
  }));
});
