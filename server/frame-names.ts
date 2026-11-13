// One name per conversation: a bound frame's title and its Paseo agent's title.
// The frame is where the user names things, so a frame rename goes to Paseo; a rename
// made in Paseo comes back to the frame only while the frame still shows the last
// name both sides agreed on (syncedName in the frame's paseo meta).

export { NAME_MAX, cleanName, nameFromRequest } from "../shared/frame-names";
import { cleanName, nameFromRequest } from "../shared/frame-names";

// Placeholder titles nobody chose: the old create fallback ("Board main frame"),
// tldraw's default, the canvas's "+ New agent" draft name, and empties.
export function isGenericName(name: string | null | undefined): boolean {
  const n = (name ?? "").replace(/\s+/g, " ").trim();
  return (
    !n ||
    /^board .+ frame$/i.test(n) ||
    /^frame( \d+)?$/i.test(n) ||
    /^conversation [0-9a-f]{8}$/i.test(n) ||
    /^(new )?(agent|frame|chat|conversation|session|thread)( \d+)?$/i.test(n) ||
    /^untitled( (agent|frame|chat|conversation|session))?( \d+)?$/i.test(n)
  );
}

// A title Bunny made up from the first line of the request (frame meta paseo.autoName)
// stands in until the agent or Paseo names the task; it counts as a placeholder while
// the frame still shows it.
export function isProvisionalName(name: string | null | undefined, autoName: string | null | undefined): boolean {
  return isGenericName(name) || (!!autoName && cleanName(name) === cleanName(autoName));
}

// The name a frame keeps when its agent starts: a title someone chose, else one made
// from the request. `auto` is set when the name was made up and is only provisional.
export function startName(frameName: string | null | undefined, ...requests: (string | null | undefined)[]): { name: string | null; auto: boolean } {
  const chosen = isGenericName(frameName) ? "" : cleanName(frameName);
  if (chosen) return { name: chosen, auto: false };
  for (const r of requests) {
    const n = nameFromRequest(r);
    if (n) return { name: n, auto: true };
  }
  return { name: null, auto: false };
}

export type NameAction = { kind: "none" } | { kind: "mark"; name: string } | { kind: "toPaseo"; name: string } | { kind: "toFrame"; name: string };

// Decide which side wins when the frame title and the Paseo title differ.
export function reconcileNames(frameName: string | null | undefined, paseoTitle: string | null | undefined, synced: string | null | undefined, autoName?: string | null): NameAction {
  const f = cleanName(frameName);
  const p = cleanName(paseoTitle);
  if (f && f === p) return synced === f ? { kind: "none" } : { kind: "mark", name: f };
  if (!p && f === synced) return { kind: "none" };
  // Paseo was renamed since the last agreement and the frame was not, or the frame
  // still shows a placeholder or a provisional name made from the request.
  if (p && !isGenericName(p) && p !== cleanName(autoName) && (isProvisionalName(f, autoName) || (!!synced && f === synced))) return { kind: "toFrame", name: p };
  if (f && !isGenericName(f)) return { kind: "toPaseo", name: f };
  return { kind: "none" };
}
