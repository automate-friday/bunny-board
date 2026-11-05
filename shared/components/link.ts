// Board link card: a card on one board that points at another board (or a frame on it,
// on this board or another). Holds { board, frameId, title }; the canvas renders the
// target's name and live frame status and opens the deep link on click. Like the
// transcript card, live data (status, names) is never stored on the shape.
//
// Kept free of React and `tldraw` so the server bundle can import it (README, "Why
// pre-bundled"). The canvas side lives in canvas/src/components/link/.

import { createShapePropsMigrationSequence } from "@tldraw/tlschema";
import { T } from "@tldraw/validate";

export const LINK_TYPE = "link" as const;

export interface LinkProps {
  board: string;
  // "" links the board itself.
  frameId: string;
  title: string;
  w: number;
  h: number;
}

export const linkShapeProps = {
  board: T.string,
  frameId: T.string,
  title: T.string,
  w: T.nonZeroNumber,
  h: T.nonZeroNumber,
};

export const linkMigrations = createShapePropsMigrationSequence({ sequence: [] });

export const LINK_SIZE = { w: 320, h: 110 } as const;

export function linkDefaults(board = "", frameId = "", title = ""): LinkProps {
  return { board, frameId, title, ...LINK_SIZE };
}

// Board ids are [a-zA-Z0-9_-]{1,64} (server/room-host.ts); frame ids are tldraw shape ids.
export const BOARD_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
export const FRAME_ID_RE = /^shape:[A-Za-z0-9_-]{1,64}$/;

// What the outline and the canvas know about the target.
export interface LinkTarget {
  board: string;
  exists: boolean;
  frames?: number;
  boundFrames?: number;
  frame?: { id: string; name: string; status: string | null; subagents?: number; agentId: string | null } | null;
}

function q(t: string, max = 60): string {
  const one = t.replace(/\s+/g, " ").trim();
  return JSON.stringify(one.length > max ? `${one.slice(0, max - 1)}…` : one);
}

// One line for board_read.
export function linkOutline(props: Pick<LinkProps, "board" | "frameId" | "title">, target: LinkTarget | null): string {
  const title = props.title ? ` titled ${q(props.title)}` : "";
  if (!target) return `link to board ${q(props.board)}${props.frameId ? ` frame ${props.frameId}` : ""}${title}`;
  if (!target.exists) return `link to board ${q(props.board)} (does not exist yet; opening it creates it)${title}`;
  if (!props.frameId) return `link to board ${q(props.board)} (${target.boundFrames ?? 0}/${target.frames ?? 0} frames bound)${title}`;
  if (!target.frame) return `link to board ${q(props.board)} frame ${props.frameId} (frame no longer exists)${title}`;
  const st = target.frame.agentId ? `, agent ${target.frame.agentId} ${target.frame.status ?? "unknown"}` : ", not bound";
  return `link to board ${q(props.board)} frame ${q(target.frame.name || "(unnamed)")} (${target.frame.id}${st})${title}`;
}

// A board deep link (…/?board=X&frame=Y) parsed, or null.
export function parseBoardUrl(url: string, origins: string[]): { board: string; frameId: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!origins.includes(u.origin)) return null;
  const board = u.searchParams.get("board") ?? "";
  const frameId = u.searchParams.get("frame") ?? "";
  if (!BOARD_ID_RE.test(board)) return null;
  if (frameId && !FRAME_ID_RE.test(frameId)) return null;
  return { board, frameId };
}
