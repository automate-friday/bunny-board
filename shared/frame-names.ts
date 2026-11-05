// Frame names shared by the board server and the canvas (the phone start sheet names a new
// frame the way the server would): the length cap, whitespace cleanup, and a title taken
// from the request that started the frame.

export const NAME_MAX = 80;

export function cleanName(name: string | null | undefined): string {
  return (name ?? "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
}

// A frame with no title gets one from the request that started it: the first line,
// cut at a word boundary. Better than "Board main frame" until the agent renames it.
export function nameFromRequest(text: string | null | undefined): string | null {
  const line = (text ?? "").split("\n").map((l) => l.trim()).find((l) => l) ?? "";
  if (!line) return null;
  const words = line.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  let out = "";
  for (const w of words) {
    if ((out ? out.length + 1 : 0) + w.length > 48) break;
    out = out ? `${out} ${w}` : w;
    if (out.split(" ").length >= 7) break;
  }
  out = out.replace(/[\s,.;:!?-]+$/, "");
  return out ? out[0].toUpperCase() + out.slice(1) : null;
}
