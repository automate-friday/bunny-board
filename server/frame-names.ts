// One name per conversation: a bound frame's title and its Paseo agent's title.
// The frame is where the user names things, so a frame rename goes to Paseo; a rename
// made in Paseo comes back to the frame only while the frame still shows the last
// name both sides agreed on (syncedName in the frame's paseo meta).

export { NAME_MAX, cleanName, nameFromRequest } from "../shared/frame-names";
import { cleanName } from "../shared/frame-names";

// Placeholder titles nobody chose: the old create fallback ("Board main frame"),
// tldraw's default, and empties.
export function isGenericName(name: string | null | undefined): boolean {
  const n = (name ?? "").trim();
  return !n || /^board .+ frame$/i.test(n) || /^frame( \d+)?$/i.test(n) || /^conversation [0-9a-f]{8}$/i.test(n);
}

export type NameAction = { kind: "none" } | { kind: "mark"; name: string } | { kind: "toPaseo"; name: string } | { kind: "toFrame"; name: string };

// Decide which side wins when the frame title and the Paseo title differ.
export function reconcileNames(frameName: string | null | undefined, paseoTitle: string | null | undefined, synced: string | null | undefined): NameAction {
  const f = cleanName(frameName);
  const p = cleanName(paseoTitle);
  if (f && f === p) return synced === f ? { kind: "none" } : { kind: "mark", name: f };
  if (!p && f === synced) return { kind: "none" };
  // Paseo was renamed since the last agreement, and the frame was not.
  if (p && !isGenericName(p) && (isGenericName(f) || (!!synced && f === synced))) return { kind: "toFrame", name: p };
  if (f && !isGenericName(f)) return { kind: "toPaseo", name: f };
  return { kind: "none" };
}
