import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const buildId = process.env.CANVAS_BUILD_ID ?? `canvas-${Date.now().toString(36)}`;
const target = process.env.BOARD_SERVER ?? "http://127.0.0.1:8793";
// shared/components imports @tldraw/tlschema and @tldraw/validate; resolve them to the
// canvas's own copies (the ones tldraw uses) instead of the server's root node_modules.
export default defineConfig({
  // board-env gives each environment its own cache so concurrent dev servers sharing
  // the main checkout's node_modules do not write the same node_modules/.vite.
  cacheDir: process.env.VITE_CACHE_DIR,
  plugins: [react(), { name: "canvas-build-id", transformIndexHtml: () => [{ tag: "meta", attrs: { name: "canvas-build", content: buildId }, injectTo: "head" }] }],
  define: { __CANVAS_BUILD_ID__: JSON.stringify(buildId) },
  resolve: { dedupe: ["@tldraw/tlschema", "@tldraw/validate", "@tldraw/utils", "@tldraw/store", "@tldraw/state"] },
  server: { proxy: { "/api": { target, ws: true } } },
});
