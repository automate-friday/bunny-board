// The installed web app's cache (canvas/public/sw.js). Registered only when the board runs
// from the home screen, so desktop tabs and the dev server keep loading straight from the
// network. ?appcache=0 removes it (and its cache) from this device.
export function registerAppCache(): void {
  if (!("serviceWorker" in navigator) || import.meta.env.DEV) return;
  if (new URLSearchParams(window.location.search).get("appcache") === "0") {
    void navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => void r.unregister()));
    void caches?.keys().then((ks) => ks.filter((k) => k.startsWith("bunny-app-")).forEach((k) => void caches.delete(k)));
    return;
  }
  // After the board has loaded: the worker fetches the build files once, off the launch path.
  const register = () => void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
  if (document.readyState === "complete") setTimeout(register, 2000);
  else window.addEventListener("load", () => setTimeout(register, 2000), { once: true });
}
