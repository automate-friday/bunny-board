// The browser tab title (owner request, 2026-11: "fix the favicon and title of the board"). Every
// tab used to read "Bunny by Automate Friday"; now it names the board, and the frame whose
// conversation is open or selected, so several board tabs can be told apart.
//   frame open/selected  "<frame> · <board> · Bunny"
//   otherwise            "<board> · Bunny"
// index.html keeps "Bunny by Automate Friday" as the static title until the canvas loads.

export const STATIC_TITLE = "Bunny by Automate Friday";
const MAX_FRAME = 60;

const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

export function tabTitle(board: string | null | undefined, frame?: string | null): string {
  const b = clean(board);
  let f = clean(frame);
  if (f.length > MAX_FRAME) f = `${f.slice(0, MAX_FRAME - 1).trimEnd()}…`;
  return [f, b, "Bunny"].filter(Boolean).join(" · ");
}

// The name a frame shows: its own name, else its conversation's title, else tldraw's "Frame".
export function frameTitleName(frame: { props?: { name?: string }; meta?: unknown } | null | undefined): string | null {
  if (!frame) return null;
  const paseo = (frame.meta as { paseo?: { title?: unknown } } | undefined)?.paseo;
  return clean(frame.props?.name) || (typeof paseo?.title === "string" ? clean(paseo.title) : "") || "Frame";
}
