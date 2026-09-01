const CACHE_NAME = "codex-manage-app-shell-v1";
const APP_SHELL_URL = "/";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.add(APP_SHELL_URL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith("codex-manage-app-shell-") && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname === "/api" || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(event));
    return;
  }

  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/branding/")) {
    event.respondWith(cacheFirst(event));
  }
});

async function handleNavigation(event) {
  const cache = await caches.open(CACHE_NAME);
  const cachedShell = await cache.match(APP_SHELL_URL);
  const update = fetch(event.request)
    .then(async (response) => {
      if (response.ok && response.type === "basic") {
        await Promise.all([
          cache.put(APP_SHELL_URL, response.clone()),
          cache.put(event.request, response.clone())
        ]);
      }
      return response;
    })
    .catch(() => cachedShell);

  if (cachedShell) {
    event.waitUntil(update.catch(() => undefined));
    return cachedShell;
  }
  return update;
}

async function cacheFirst(event) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(event.request);
  if (cached) return cached;

  const response = await fetch(event.request);
  if (response.ok && response.type === "basic") {
    event.waitUntil(cache.put(event.request, response.clone()));
  }
  return response;
}
