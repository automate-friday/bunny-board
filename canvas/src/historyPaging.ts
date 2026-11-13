// Scroll up to load earlier history: the state machine behind the conversation's top slot
// (Sidebar.tsx), after Paseo 0.11.4's web stream (createHistoryStartPaginationState and its
// evaluate / rearm / settle / abandon steps). No React or DOM here, so the unit tests can
// bundle it.
//
//   dormant  -- an upward gesture -->  ready
//   ready    -- within 96px of the top, older history, nothing in flight -->  loading (fetch)
//   loading  -- the page landed -->  settling
//   settling -- (after layout) still within 96px and more to load -->  loading (fetch)
//            -- nothing older -->  latched;  otherwise -->  ready
//   loading  -- the request failed -->  latched (failed)
//   latched  -- the reader scrolls more than 96px away -->  ready
//            -- an upward gesture (only when it did not fail) -->  ready
//            -- Retry -->  loading (fetch)
//
// Opening a conversation never pages by itself: it starts dormant, and only a gesture (wheel,
// touch, keys, the scrollbar) arms it. A failure does not re-arm on a gesture, so a reader
// nudging the wheel at the top does not retry a failing request on every tick.

export const HISTORY_START_THRESHOLD_PX = 96;
// Entries per older page (Paseo's TIMELINE_FETCH_PAGE_SIZE).
export const HISTORY_PAGE_SIZE = 40;
// The first fetch asks for the tail: the live window the sidebar already shows (the board
// server keeps 60 entries, server/transcripts.ts ROWS) plus one page older than it.
export const HISTORY_FIRST_LIMIT = 60 + HISTORY_PAGE_SIZE;
// What decides "the reader is on this row": its bottom is this far below the scroll top.
export const READING_ROW_SLACK_PX = 8;

export type PagingPhase = "dormant" | "ready" | "loading" | "settling" | "latched";
export interface PagingState {
  phase: PagingPhase;
  // Latched because the last request failed (only scrolling away or Retry clears it).
  failed: boolean;
}
export interface PagingView {
  scrollTop: number;
  // There is (or may be, before the first page) history older than the first row.
  hasOlder: boolean;
  // A request for this conversation is already out (any caller's).
  inFlight: boolean;
}
export interface PagingStep {
  state: PagingState;
  fetch: boolean;
}

export function createPaging(): PagingState {
  return { phase: "dormant", failed: false };
}

const near = (v: PagingView) => v.scrollTop <= HISTORY_START_THRESHOLD_PX;
const keep = (state: PagingState): PagingStep => ({ state, fetch: false });

// An upward gesture by the reader.
export function rearm(state: PagingState): PagingState {
  if (state.phase === "dormant" || (state.phase === "latched" && !state.failed)) return { phase: "ready", failed: false };
  return state;
}

// On every scroll, and right after a gesture or a change of what is loaded.
export function evaluate(state: PagingState, view: PagingView): PagingStep {
  if (state.phase === "latched" && !near(view)) return keep({ phase: "ready", failed: false });
  if (state.phase !== "ready") return keep(state);
  if (near(view) && view.hasOlder && !view.inFlight) return { state: { phase: "loading", failed: false }, fetch: true };
  return keep(state);
}

// The page arrived and was applied.
export function landed(state: PagingState): PagingState {
  return state.phase === "loading" ? { phase: "settling", failed: false } : state;
}

// After the new rows are laid out (and the reading position restored).
export function settle(state: PagingState, view: PagingView): PagingStep {
  if (state.phase !== "settling") return keep(state);
  if (!view.hasOlder) return keep({ phase: "latched", failed: false });
  if (near(view) && !view.inFlight) return { state: { phase: "loading", failed: false }, fetch: true };
  return keep({ phase: "ready", failed: false });
}

// The request failed (or was abandoned).
export function failed(state: PagingState): PagingState {
  return state.phase === "loading" || state.phase === "settling" ? { phase: "latched", failed: true } : state;
}

// The slot's Retry, or its keyboard "Load earlier messages" button: load now, whatever the
// phase, unless a request is already out.
export function retry(state: PagingState, view: Pick<PagingView, "hasOlder" | "inFlight">): PagingStep {
  if (view.inFlight || !view.hasOlder || state.phase === "loading") return keep(state);
  return { state: { phase: "loading", failed: false }, fetch: true };
}

// --- keeping the reading position ------------------------------------------------------------

export interface RowBox {
  id: string;
  // Relative to the scroller's content (offset from its scrollable top), in px.
  top: number;
  height: number;
}
export interface ReadingAnchor {
  id: string;
  top: number;
}

// The row being read: the first whose bottom is more than 8px below the scroll top.
export function readingAnchor(rows: readonly RowBox[], scrollTop: number): ReadingAnchor | null {
  const row = rows.find((r) => r.top + r.height > scrollTop + READING_ROW_SLACK_PX);
  return row ? { id: row.id, top: row.top } : null;
}

// How far to move scrollTop so that row is where it was on screen (0 when it is gone).
export function anchorShift(anchor: ReadingAnchor, rows: readonly RowBox[]): number {
  const row = rows.find((r) => r.id === anchor.id);
  return row ? row.top - anchor.top : 0;
}
