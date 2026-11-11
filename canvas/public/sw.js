// Bunny's home-screen app cache (registered by canvas/src/appCache.ts, only when the board
// runs as an installed web app). It keeps the canvas's own files on the phone so a launch
// does not wait on the network for them:
// - the page (/): served from the cache at once and refreshed in the background, so the next
//   launch has the newest build (the canvas's version check still offers a refresh);
// - /assets/*: content-hashed build files, served from the cache, fetched once each.
// Everything else (board sync, /api, images, plugins) goes to the network as before.

const CACHE = "bunny-app-v1";
const PAGE = "/";

// Installed after a launch has loaded the board: take the page and its build files now, so
// the very next launch is served from here.
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const r = await fetch(PAGE, { credentials: "same-origin", cache: "no-cache" }).catch(() => null);
      if (r && r.ok && r.headers.get("content-type")?.includes("text/html")) await storePage(cache, r).catch(() => undefined);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) if (name.startsWith("bunny-app-") && name !== CACHE) await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});

function assetsIn(html) {
  return new Set([...html.matchAll(/["'](\/assets\/[^"']+)["']/g)].map((m) => m[1]));
}

// A new page: keep the build files it names and the ones the page it replaces named (an
// open tab of the older build may still load its lazy chunks); drop the rest.
async function storePage(cache, response) {
  const html = await response.clone().text();
  const old = await cache.match(PAGE);
  const keep = assetsIn(html);
  if (old) for (const a of assetsIn(await old.text())) keep.add(a);
  await cache.put(PAGE, response);
  for (const req of await cache.keys()) {
    const path = new URL(req.url).pathname;
    if (path.startsWith("/assets/") && !keep.has(path)) await cache.delete(req);
  }
  // Fetch the new build's files now, so the next launch does not wait on them.
  await Promise.all(
    [...keep].map(async (a) => {
      if (await cache.match(a)) return;
      const r = await fetch(a, { credentials: "same-origin" }).catch(() => null);
      if (r && r.ok) await cache.put(a, r);
    }),
  );
}

async function page(event) {
  const cache = await caches.open(CACHE);
  const network = fetch(PAGE, { credentials: "same-origin", cache: "no-cache" }).then(async (r) => {
    if (r.ok && r.headers.get("content-type")?.includes("text/html")) await storePage(cache, r.clone());
    return r;
  });
  const cached = await cache.match(PAGE);
  if (cached) {
    event.waitUntil(network.catch(() => undefined));
    return cached;
  }
  // First launch: the normal request (it carries the URL's query and any sign-in prompt).
  event.waitUntil(network.catch(() => undefined));
  return fetch(event.request);
}

async function asset(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request.url);
  if (hit) return hit;
  const r = await fetch(request);
  if (r.ok) await cache.put(request.url, r.clone());
  return r;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === "navigate" && url.pathname === PAGE) event.respondWith(page(event));
  else if (url.pathname.startsWith("/assets/")) event.respondWith(asset(req));
});
