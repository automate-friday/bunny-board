// Board ids are [a-zA-Z0-9_-]{1,64}; a typed name becomes one. Shared by the canvas
// ("New board…") and the Paseo app's "Add to board" (plugin RPC).
//
// Accented letters keep their base letter ("Ünïcode Plan" → "unicode-plan"). A name with
// no Latin letters or digits at all ("日本語") gets a stable id from its hash
// ("b-3f2a9c1d"), so it is not silently reduced to nothing.
export function boardIdFromName(name: string): string {
  const id = name
    .trim()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ß/g, "ss")
    .replace(/[æÆ]/g, "ae")
    .replace(/[øØ]/g, "o")
    .replace(/[łŁ]/g, "l")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  if (id || !name.trim()) return id;
  return `b-${fnv1a(name.trim())}`;
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (const ch of s) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
