import { AppIcon } from "../components/AppIcon";
import { ThemePicker } from "../theme";
// Phone shell: a mobile-first way into the board, organised as tiles of mini whiteboards.
// Three modes (the R4-5 iPhone set and R3-1 iPhone switcher mockups):
// - tiles (the entry screen): "<board> ▾" switcher and the orange "N need you →" pill, a
//   "Jump to frame or agent…" search, Pinned tiles, a Recent row and every other frame. A
//   tile is one frame: a live thumbnail of its own canvas, its name and status dot, the
//   agent's harness and machine ("Claude · mac-1"), and the last interaction.
// - frame: the tapped frame full-screen as a touch whiteboard. The camera is held to the
//   frame (pinch and pan inside it), a thumb bar (Hand, Pen, Start agent, Search) and a
//   thread peek sit at the bottom; the thread is the existing Sidebar as a bottom sheet with
//   big Approve / Reply. ‹ returns to the tiles.
// - board: swipe the tiles down for the raw canvas; swipe up (or tap a frame) to leave it.
// The search sheet opens over any mode, with per-result Follow agent, Pin and Open report.
// tldraw's own toolbars are hidden by the bunny-mobile class (mobile.css). Desktop never
// mounts this (useMobileShell).

import { CloudMark } from "../Dot";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useKilledPageReport } from "./ShellErrorBoundary";
import { type Box, createShapeId, type Editor, PageRecordType, type TLCameraOptions, type TLPageId, type TLShapeId, useValue } from "tldraw";
import { goToBoard } from "../BoardMenu";
import { openPlace, type Place, useRecentPlaces } from "../places";
import { indexFrames, lastInteracted, readAgentSends, readRecents, recencyKey, rememberFrame, timeAgo, type PaletteFrame } from "../jumpPaletteModel";
import { PIN_LIMIT, usePins } from "../pins";
import { agentStore, STATUS_DOT, STATUS_TEXT, useAgentView } from "../agents";
import { infoNow } from "../info";
import { api } from "../api";
import { LiveThumb } from "./LiveThumb";
import { AddButton, HistoryButtons, MobileEdit } from "./AddSheet";
import { useReadingZoom } from "./readingZoom";
import { Immersive, immersiveNow } from "./Immersive";
import { pickUp, useHeld } from "./editGestures";
import { useVerticalDrag } from "./sheetDrag";
import { setPhoneView } from "./visibility";
import { SendWatcher, useLastSend } from "../ChatComposer";
import { buildDocs, searchDocs, type SearchHit } from "./fuzzySearch";
import { frameTimes } from "../../../shared/frame-activity";
import { agentHost, agentLabel, fitInBand, unlocked, neighbour, recentConversations, frameAtTap, frameFit, harnessLabel, needsYou, newFrameSpot, nextNeedsYou, tileSections } from "./mobileMode";
import { emptyHistory, forget, goTo, stepTarget, visit } from "./jumpHistory";
import { JumpPills } from "./JumpPills";
import { RenameSheet } from "./RenameSheet";
import { askMove, MoveSheet, useAskedMove } from "./MoveSheet";
import { fitAround, fitBoard, FocusLabel, FocusOutline, FullBoardButton } from "./BoardFocus";
import { attachBoardSurface } from "./boardGestures";
import { StopButton, useStopped } from "./StopButton";
import { useModalOpen } from "./modalHold";
import { askStartBeside, askStartSheet, emptyFrame, StartSheet, type StartPrefill, useAskedStartBeside, useAskedStartSheet } from "./StartSheet";
import { openThreadAtHalf } from "./threadStop";
import { lastStartPage } from "../startChoice";
import { besideFrame } from "./placement";
import { startBeside } from "./ThreadTools";
import { leftoverDrafts } from "./drafts";
import { deviceLock } from "../locks";
import { askReveal, Reveal, useAskedReveal, whereOnBoard } from "./Reveal";
import { TellBunny, TellBunnyButton } from "./TellBunny";
import { pageTiles, PageMenu, usePages } from "./pages";
import { askOpenFrame, CreateSheet, type CreateKind, NewMenu, useAskedOpenFrame } from "./CreateSheet";
import "./mobile.css";
import { type AgentSummary, type LastUserMessage, useAgentSummary } from "../lastSent";

// `preview`: a frame copied by board-env --state copy keeps only a display copy of its binding
// (meta.paseoPreview, no agent id): shown as "preview · not connected", never driven.
type Frame = PaletteFrame & { rawStatus: string; host: string; relink: boolean; preview: boolean; provider: string };
export type MobileMode = "tiles" | "frame" | "board";

function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

// The machine the board's local agents run on, or null when the server does not know it.
const localAgentMachine = () => (infoNow() as { agentMachine?: string | null } | null)?.agentMachine ?? null;

// timeAgo, with a plain "Sep 12" for over a month ago: toLocaleDateString's first call loads the
// locale data (~30 ms at 4x CPU throttle, in the tiles' first render).
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// Times before 2001 are placeholders (a binding written with no real time), not dates.
function phoneAgo(at: number | undefined, now: number): string {
  if (at !== undefined && at > 0 && at < 978_307_200_000) return "earlier";
  if (at === undefined || at <= 0 || now - at < 29.5 * 86_400_000) return timeAgo(at, now);
  const d = new Date(at);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${d.getFullYear() === new Date(now).getFullYear() ? "" : ` ${d.getFullYear()}`}`;
}

// Every frame on every page, re-read only when shapes or pages change (not on camera moves).
function useFrames(editor: Editor): Frame[] {
  return useValue(
    "mobile-frames",
    () => {
      const pages = new Map(editor.getPages().map((p) => [p.id, p.name]));
      const out: Frame[] = [];
      for (const pageId of pages.keys()) {
        for (const id of editor.getPageShapeIds(pageId)) {
          const s = editor.getShape(id);
          if (s?.type !== "frame") continue;
          // biome-ignore lint/suspicious/noExplicitAny: meta JSON.
          const p = ((s.meta as any)?.paseo ?? {}) as Record<string, any>;
          const agentId = typeof p.agentId === "string" ? p.agentId : "";
          // An idle agent whose cloud session still works is "cloud" (paused, cloud agent working), as on the board.
          const raw = agentId ? (p.status === "idle" && (p.cloudSessions ?? 0) > 0 ? "cloud" : String(p.status ?? "")) : p.request ? "requested" : "";
          // biome-ignore lint/suspicious/noExplicitAny: meta JSON.
          const pv = agentId ? null : (((s.meta as any)?.paseoPreview ?? null) as Record<string, any> | null);
          const preview = !!pv?.agent;
          out.push({
            id: s.id,
            pageId,
            pageName: pages.get(pageId) ?? "",
            name: String((s.props as { name?: string }).name || "Untitled frame"),
            agentId,
            agentTitle: agentId ? String(p.title || p.agentTitle || "") : preview ? String(pv?.title || "") : "",
            status: preview ? "preview · not connected" : (STATUS_TEXT[raw === "requested" ? "starting" : raw] ?? (agentId ? raw || "unknown" : "no agent")),
            rawStatus: raw,
            host: preview ? agentHost(pv, null) : agentId ? agentHost(p, localAgentMachine()) : "",
            relink: !agentId && typeof p.relink?.agentId === "string",
            preview,
            provider: preview ? harnessLabel(String(pv?.cloudProvider ? `${pv.cloudProvider}` : (pv?.provider ?? ""))) : "",
          });
        }
      }
      return out;
    },
    [editor],
  );
}

// Last activity per frame from the board server (History edits by people or agents, bound or
// not, and binding times), asked on entry, every minute, and on each return to the tiles.
function useActivity(boardId: string, tick: unknown): Map<string, number> {
  const [map, setMap] = useState<Map<string, number>>(new Map());
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` asks again.
  useEffect(() => {
    let live = true;
    const load = () => api<{ frames: Record<string, number> }>(`/api/ui/boards/${encodeURIComponent(boardId)}/frame-activity`).then((r) => live && setMap(new Map(Object.entries(r.frames ?? {})))).catch(() => undefined);
    void load();
    const t = setInterval(load, 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [boardId, tick]);
  return map;
}


// Harness per agent ("Claude") and the last message the person sent it, from the agent
// summary (lastSent.ts: one request per agent, shared and kept fresh while shown).
const harnessKnown = new Map<string, string>();
function useHarness(agentId: string): string {
  return harnessOf(agentId, useAgentSummary(agentId, !!agentId));
}
function harnessOf(agentId: string, s: AgentSummary | null): string {
  const h = s ? harnessLabel(s.provider ?? s.model ?? "") : "";
  if (h) harnessKnown.set(agentId, h);
  return h;
}
// "You: …" under a frame's name: small and grey; nothing when the person sent nothing.
function YouLine({ last, testid = "mobile-you" }: { last: LastUserMessage | null | undefined; testid?: string }) {
  if (!last?.text) return null;
  return (
    <small className="bm-you" data-testid={testid} title={last.text}>
      You: {last.text}
    </small>
  );
}

const dot = (raw: string) => STATUS_DOT[raw === "requested" ? "starting" : raw] ?? "#d6cfc6";
// A status dot, or the blue cloud while the frame's cloud agent works.
const StatusDot = ({ status, title }: { status: string; title?: string }) =>
  status === "cloud" ? <span title={title} style={{ display: "inline-flex", flex: "none" }}><CloudMark size={15} /></span> : <i style={{ background: dot(status) }} aria-hidden="true" title={title} />;

// A vertical swipe on an element: up/down past 28 px, or a tap. The start is kept on the
// element itself, so a re-render mid-swipe (new handlers) does not lose it.
type SwipeEl = HTMLElement & { __bmSwipe?: { y: number; id: number } | null };
function swipe(onUp: () => void, onDown: () => void, onTap: () => void) {
  return {
    onPointerDown: (e: React.PointerEvent) => {
      if ((e.target as HTMLElement).closest("button,input,a")) return;
      const el = e.currentTarget as SwipeEl;
      el.__bmSwipe = { y: e.clientY, id: e.pointerId };
      el.setPointerCapture(e.pointerId);
    },
    onPointerUp: (e: React.PointerEvent) => {
      const el = e.currentTarget as SwipeEl;
      const start = el.__bmSwipe;
      if (!start || start.id !== e.pointerId) return;
      el.__bmSwipe = null;
      const dy = e.clientY - start.y;
      if (dy < -28) onUp();
      else if (dy > 28) onDown();
      else onTap();
    },
    onPointerCancel: (e: React.PointerEvent) => {
      (e.currentTarget as SwipeEl).__bmSwipe = null;
    },
  };
}

// A panel dragged down (or up) from its grip: follows the finger, and on release either
// commits (past `threshold` px, or a flick faster than 0.5 px/ms in that direction) or springs
// back. `dir` -1: dragging down commits (search sheet, tiles); 1: dragging up (board dock).
function useDragCommit(dir: 1 | -1, threshold: number, commit: () => void) {
  const [offset, setOffset] = useState(0);
  const handlers = useVerticalDrag(
    (up) => setOffset(dir === -1 ? Math.max(0, -up) : Math.max(0, up)),
    (up, v) => {
      setOffset(0);
      const travel = dir === -1 ? -up : up;
      const speed = dir === -1 ? -v : v;
      if (travel > threshold || (speed > 0.5 && travel > 12)) commit();
    },
  );
  return { handlers, offset };
}

// A horizontal swipe on an element: dir 1 for a swipe left (next), -1 for right (previous).
type HSwipeEl = HTMLElement & { __bmH?: { x: number; y: number; id: number } | null };
function hswipe(go: (dir: 1 | -1) => void, onTap?: () => void) {
  return {
    onPointerDown: (e: React.PointerEvent) => {
      const el = e.currentTarget as HSwipeEl;
      el.__bmH = { x: e.clientX, y: e.clientY, id: e.pointerId };
      el.setPointerCapture(e.pointerId);
    },
    onPointerUp: (e: React.PointerEvent) => {
      const el = e.currentTarget as HSwipeEl;
      const s = el.__bmH;
      el.__bmH = null;
      if (!s || s.id !== e.pointerId) return;
      const dx = e.clientX - s.x;
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(e.clientY - s.y)) go(dx < 0 ? 1 : -1);
      else if (Math.abs(dx) < 10 && Math.abs(e.clientY - s.y) < 10) onTap?.();
    },
    onPointerCancel: (e: React.PointerEvent) => {
      (e.currentTarget as HSwipeEl).__bmH = null;
    },
    style: { touchAction: "pan-y" } as React.CSSProperties,
  };
}

// Frame mode: hold the camera to the frame (fit, then pinch and pan inside it). The frame's
// bounds are watched, so a frame its agent grows keeps fitting. The board's own camera
// options come back on leaving.
// While the open frame itself is picked up (moved or resized whole), the camera stands still and
// is free, so the frame follows the finger; it fits the frame again once it is put down.
function useFrameCamera(editor: Editor, frameId: string | null, threadOpen = false) {
  const held = useHeld() === frameId && !!frameId;
  const bounds = useValue("mobile-frame-bounds", () => (frameId ? editor.getShapePageBounds(frameId as TLShapeId) : null), [editor, frameId]);
  const key = bounds ? `${bounds.x}:${bounds.y}:${bounds.w}:${bounds.h}` : "";
  const saved = useRef<TLCameraOptions | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `bounds`.
  useEffect(() => {
    if (!frameId || !bounds) return;
    const page = editor.getAncestorPageId(frameId as TLShapeId);
    if (page && page !== editor.getCurrentPageId()) editor.setCurrentPage(page);
    if (!saved.current) saved.current = editor.getCameraOptions();
    if (held) {
      editor.setCameraOptions(unlocked(saved.current));
      return;
    }
    // Fit between the top bar and the bottom dock, with a small margin (the frame's label
    // sits just above it).
    const vp = editor.getViewportScreenBounds();
    // Read again on each placement below: the frame switch strip under the top bar can come
    // in a moment after the frame opens, and must not cover the frame's title tab (a hold on
    // it picks the frame up).
    const topNow = () => Math.max(document.querySelector(".bm-top")?.getBoundingClientRect().bottom ?? 56, document.querySelector(".bm-switch")?.getBoundingClientRect().bottom ?? 0) + 34;
    const top = topNow();
    // Above whatever covers the bottom: the open thread sheet, else the dock.
    const sheet = threadOpen ? document.querySelector('[data-testid="sidebar"][data-sheet="1"]')?.getBoundingClientRect() : null;
    const dock = document.querySelector(".bm-dock")?.getBoundingClientRect();
    const cover = sheet && sheet.left < vp.w / 2 ? sheet : dock;
    const bottom = cover ? Math.max(0, vp.y + vp.h - cover.top) : window.innerHeight > window.innerWidth ? 160 : 64;
    const fit = frameFit({ w: vp.w, h: vp.h }, { w: bounds.w, h: bounds.h }, { top: top - vp.y, bottom });
    // The open thread covers too much for tldraw's symmetric padding: place the frame in the
    // band above it directly (free camera while the thread is up; held again once collapsed).
    if (2 * fit.padding.y >= vp.h * 0.8) {
      editor.setCameraOptions(unlocked(saved.current));
      // Again once the sheet has its final size (it lays out from the visual viewport).
      const place = () => {
        const b = editor.getShapePageBounds(frameId as TLShapeId);
        const r = document.querySelector('[data-testid="sidebar"][data-sheet="1"]')?.getBoundingClientRect();
        const v = editor.getViewportScreenBounds();
        if (b) editor.setCamera(fitInBand({ w: v.w, h: v.h }, b, { top: topNow() - v.y, bottom: r ? Math.max(0, v.y + v.h - r.top) : bottom }), { immediate: true });
      };
      // And whenever the thread sheet changes height (dragged to another stop, the keyboard,
      // its open animation): a fit made while it covered nearly everything left the frame a
      // speck at the top once it was lowered.
      const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => requestAnimationFrame(place));
      let watched: Element | null = null;
      const watch = () => {
        const el = document.querySelector('[data-testid="sidebar"][data-sheet="1"]');
        if (!el || el === watched) return;
        ro?.disconnect();
        ro?.observe(el);
        watched = el;
      };
      const placeAndWatch = () => {
        place();
        watch();
      };
      placeAndWatch();
      const t1 = requestAnimationFrame(placeAndWatch);
      const t2 = setTimeout(placeAndWatch, 150);
      const t3 = setTimeout(placeAndWatch, 450);
      return () => {
        cancelAnimationFrame(t1);
        clearTimeout(t2);
        clearTimeout(t3);
        ro?.disconnect();
      };
    }
    editor.setCameraOptions({
      ...saved.current,
      constraints: { bounds: { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h }, padding: fit.padding, origin: fit.origin, initialZoom: "fit-max", baseZoom: "fit-max", behavior: "contain" },
    });
    editor.zoomToBounds(bounds as Box, { inset: 0, immediate: true });
    editor.resetZoom(editor.getViewportScreenCenter(), { immediate: true });
  }, [editor, frameId, held ? "" : key, threadOpen, held]);
  useEffect(
    () => () => {
      if (saved.current) {
        editor.setCameraOptions(unlocked(saved.current));
        saved.current = null;
      }
    },
    [editor, frameId],
  );
}

// `importConversations`: open the shared Import picker (App.tsx) for Paseo conversations started elsewhere.
export function MobileShell({ editor, boardId, userId, initialFrame, threadOpen, openThread, closeThread, importConversations }: { editor: Editor; boardId: string; userId: string; initialFrame: string | null; threadOpen: boolean; openThread: (frameId: string) => void; closeThread: () => void; importConversations?: () => void }) {
  const frames = useFrames(editor);
  // Test hook (bench/phone.ts --soak): a forced render error, to check ShellErrorBoundary. It
  // keeps throwing (React retries a failed render once) until the boundary catches it and clears it.
  if ((window as unknown as { __bmCrashOnce?: boolean }).__bmCrashOnce) {
    throw new Error("forced phone shell error (soak test)");
  }
  const [mode, setMode] = useState<MobileMode>(initialFrame ? "frame" : "tiles");
  const [frameId, setFrameId] = useState<string | null>(initialFrame);
  // What the shell shows, for a report if iOS kills the page (ShellErrorBoundary.tsx).
  const shown = useRef({ mode, frameId });
  shown.current = { mode, frameId };
  useKilledPageReport(() => {
    const imgs = [...document.images].filter((i) => i.naturalWidth);
    const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
    return {
      ...shown.current,
      zoom: Math.round(editor.getZoomLevel() * 1000) / 1000,
      images: imgs.length,
      decodedMb: Math.round(imgs.reduce((a, i) => a + i.naturalWidth * i.naturalHeight * 4, 0) / 1048576),
      largest: Math.max(0, ...imgs.map((i) => i.naturalWidth)),
      // What the page holds besides images: the board's size, what is mounted, iframes, heap
      // (the heap only where the browser tells: not in Safari).
      shapes: editor.getCurrentPageShapeIds().size,
      shapesMounted: document.querySelectorAll(".tl-shape").length,
      placeholders: document.querySelectorAll("[data-phone-placeholder]").length,
      domNodes: document.getElementsByTagName("*").length,
      iframes: document.querySelectorAll("iframe").length,
      ...(heap ? { heapMb: Math.round(heap / 1048576) } : {}),
    };
  });
  const [search, setSearch] = useState(false);
  const [boards, setBoards] = useState(false);
  const key = recencyKey(boardId, userId);
  // The board's pins (pins.ts): the same ones the desktop's frame tabs show.
  const [pins, togglePin] = usePins(editor, boardId);
  const [touchedTick, setTouchedTick] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `touchedTick` re-reads storage.
  const activity = useActivity(boardId, mode === "tiles");
  // Last interaction: this viewer's opens and messages, or the frame's last edit or agent event.
  // Times the board's own records carry (bindings or their copy preview, stamps, cloud cards,
  // comments), live, so ordering never waits on the server.
  const recordTimes = useValue("mobile-frame-times", () => frameTimes([...editor.store.query.records("shape").get(), ...editor.store.query.records("page").get()]), [editor]);
  const touched = useMemo(() => {
    const mine = lastInteracted(frames, readRecents(storage(), key), readAgentSends(storage()));
    for (const source of [activity, recordTimes]) for (const [id, at] of source) if (at > (mine.get(id) ?? -Infinity)) mine.set(id, at);
    return mine;
  }, [frames, key, touchedTick, activity, recordTimes]);
  const tool = useValue("mobile-tool", () => editor.getCurrentToolId(), [editor]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // The frame's synced status, unless this tab holds a live (streaming) view of its agent
  // that says otherwise: an answered permission drops off before the frame's status catches up.
  const [live, setLive] = useState(0);
  const asked = useMemo(() => needsYou(frames), [frames]);
  useEffect(() => {
    const stops = asked.map((f) => agentStore.subscribe(f.agentId, () => setLive((n) => n + 1)));
    return () => stops.forEach((stop) => stop());
  }, [asked]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `live` re-reads the agent views.
  const waiting = useMemo(() => asked.filter((f) => { const v = agentStore.holders()[f.agentId] ? agentStore.get(f.agentId) : undefined; return !v || v.status === "missing" || v.status === "needs-permission"; }), [asked, live]);
  const lastNeed = useRef<string | null>(null);

  // While a reveal shows the frame among its neighbours (Reveal.tsx), the camera is free.
  const [reveal, setReveal] = useState<{ id: string; thenThread: boolean } | null>(null);
  useFrameCamera(editor, mode === "frame" && !reveal ? frameId : null, threadOpen);
  // Zoom far enough to read wherever the canvas shows: frame (thread open or not) and board.
  useReadingZoom(editor, mode !== "tiles");

  // Render only what the shell shows (visibility.ts): nothing under the tiles, the open frame
  // in frame mode, everything on the board.
  useEffect(() => {
    setPhoneView(reveal ? "board" : mode, mode === "frame" && !reveal ? frameId : null, (id) => editor.getShape(id as TLShapeId)?.parentId);
  }, [editor, mode, frameId, reveal]);
  useEffect(() => () => setPhoneView("off", null, () => undefined), []);

  // Back/forward through the frames jumped between (jumpHistory.ts), and quick switch (recent
  // conversations, in the order they had when this frame visit began, so next/previous stay put).
  const [hist, setHist] = useState(() => emptyHistory(initialFrame));
  // The start sheet's frame; `owned` when the shell drew it for the sheet (removed on Cancel).
  // `beside`: the sheet is on a frame without an agent ("In this frame", or a new frame next to it).
  const [startFor, setStartFor] = useState<{ id: string; owned: boolean; prefill?: StartPrefill; beside?: boolean } | null>(null);
  // Frames the phone draws for a start are drafts until Start (StartSheet drops the mark): an
  // empty draft left behind (the tab reloaded, the sheet never got its Cancel) is cleaned up.
  const draftMeta = () => ({ phoneDraft: { by: userId, at: Date.now() } });
  const starting = useRef(false);
  // Tap the open frame's title to rename it (RenameSheet.tsx).
  const [renaming, setRenaming] = useState<string | null>(null);
  // A sheet is up (start, rename, Tell Bunny, …): the landscape immersive view steps aside.
  const modalOpen = useModalOpen();
  // Pages (pages.ts): the board's tldraw pages, and which one the tiles show (null: all).
  const pages = usePages(editor);
  const [tilePage, setTilePage] = useState<string | null>(() => (editor.getPages().length > 1 ? editor.getCurrentPageId() : null));
  // Frame mode: the editor stays on the open frame's page, whatever else switched it.
  const editorPage = useValue("mobile-editor-page", () => editor.getCurrentPageId(), [editor]);
  useEffect(() => {
    if (mode !== "frame" || !frameId) return;
    const page = editor.getShape(frameId as TLShapeId) ? editor.getAncestorPageId(frameId as TLShapeId) : null;
    if (page && page !== editorPage) editor.setCurrentPage(page);
  }, [editor, mode, frameId, editorPage]);
  const [order, setOrder] = useState<string[]>([]);
  useEffect(() => {
    if (mode !== "frame") setOrder([]);
    // Pinned frames first, so a pin made on the desktop is one tap away here.
    else setOrder((o) => {
      if (o.length) return o;
      const pinned = pins.filter((id) => frames.some((f) => f.id === id));
      return [...pinned, ...recentConversations(frames, touched).map((f) => f.id).filter((id) => !pinned.includes(id))];
    });
    // biome-ignore lint/correctness/useExhaustiveDependencies: frozen per visit on purpose.
  }, [mode]);

  // Pan by default on a phone; the select tool's one-finger brush is no use for getting around.
  useEffect(() => {
    if (editor.getCurrentToolId() === "select") editor.setCurrentTool("hand");
    return () => {
      if (["hand", "draw"].includes(editor.getCurrentToolId())) editor.setCurrentTool("select");
    };
  }, [editor]);

  // A frame with an agent opens on its conversation (thread sheet up, connected); `thread`
  // false keeps it collapsed to the peek strip.
  // `at`: a back/forward step to that history entry (no new jump pushed).
  const openFrame = (id: string, thread?: boolean, at?: number) => {
    const f = frames.find((x) => x.id === id);
    if (!f) return;
    setHist((h) => (at === undefined ? visit(h, id) : goTo(h, at)));
    // On another page: switch the editor there first (never a blank canvas), and the tiles
    // follow, as on desktop.
    if (f.pageId !== editor.getCurrentPageId()) editor.setCurrentPage(f.pageId as TLPageId);
    if (tilePage && tilePage !== f.pageId) setTilePage(f.pageId);
    if (mode === "frame") setOrder((o) => (o.includes(id) ? o : [...o, id]));
    rememberFrame(storage(), key, id);
    setTouchedTick((n) => n + 1);
    setSearch(false);
    editor.selectNone();
    setFrameId(id);
    setMode("frame");
    if ((thread ?? true) && f.agentId) openThread(id);
    else closeThread();
  };
  // "+ New" (CreateSheet.tsx): the menu, and the name sheet for a new frame or page.
  const [newMenu, setNewMenu] = useState(false);
  const [creating, setCreating] = useState<CreateKind | null>(null);
  // A frame made here or imported reaches `frames` a render later: open it when it does.
  const wantOpen = useAskedOpenFrame();
  useEffect(() => {
    if (!wantOpen || !frames.some((f) => f.id === wantOpen)) return;
    askOpenFrame(null);
    openFrame(wantOpen);
    // biome-ignore lint/correctness/useExhaustiveDependencies: opens once when the frame arrives.
  }, [wantOpen, frames]);
  // A new empty frame on the page the tiles show (else the editor's page), right of everything.
  // Named, not a "New agent" draft, so it stays until you put something in it.
  const createFrame = (name: string) => {
    setCreating(null);
    const page = (tilePage ?? editor.getCurrentPageId()) as TLPageId;
    if (page !== editor.getCurrentPageId()) editor.setCurrentPage(page);
    const boxes = frames.filter((f) => f.pageId === page).flatMap((f) => editor.getShapePageBounds(f.id as TLShapeId) ?? []);
    const at = newFrameSpot(boxes);
    const id = createShapeId();
    editor.createShape({ id, type: "frame", parentId: page, x: at.x, y: at.y, props: { w: 960, h: 640, name } });
    askOpenFrame(id);
  };
  // A new page (a separate space, as on desktop): switched to, its (empty) tiles shown.
  const createPage = (name: string) => {
    setCreating(null);
    const id = PageRecordType.createId();
    editor.createPage({ id, name });
    editor.setCurrentPage(id);
    setTilePage(id);
    toTiles();
  };
  const pickNew = (what: CreateKind | "import") => {
    if (what === "import") importConversations?.();
    else setCreating(what);
  };
  const toTiles = () => {
    closeThread();
    setSearch(false);
    editor.selectNone();
    setMode("tiles");
  };
  const toBoard = () => {
    closeThread();
    setMode("board");
    // After the frame camera's lock is lifted (next frames): the page's content, at any zoom.
    requestAnimationFrame(() => requestAnimationFrame(() => fitBoard(editor, null)));
  };
  // "View full board" from a frame: out to the board view (Maps-style), keeping that frame
  // outlined and one tap from going back (BoardFocus.tsx). After the frame's camera lock is
  // lifted (next frame), so the zoom-out is not clamped to the frame.
  const [boardFocus, setBoardFocus] = useState<string | null>(null);
  const fullBoard = () => {
    setBoardFocus(frameId);
    setFocusShown((n) => n + 1);
    closeThread();
    setMode("board");
    const focus = frameId;
    requestAnimationFrame(() => requestAnimationFrame(() => fitBoard(editor, focus)));
  };
  // ⋯ → Show on board: the same live board view, zoomed to the frame and its neighbours.
  const [focusShown, setFocusShown] = useState(0);
  const showOnBoard = (id: string) => {
    setBoardFocus(id);
    setFocusShown((n) => n + 1);
    closeThread();
    setMode("board");
    requestAnimationFrame(() => requestAnimationFrame(() => fitAround(editor, id)));
  };
  // Frame sheet → Move on board: that view, with the frame already picked up (a hold does the
  // same; this is the visible way to it). Drag it, then Done.
  const moveOnBoard = (id: string) => {
    showOnBoard(id);
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => pickUp(editor, id as TLShapeId))));
  };
  useEffect(() => {
    if (mode !== "board") setBoardFocus(null);
  }, [mode]);

  // Board mode: a drag or pinch that starts off the canvas (the dock around its buttons, the
  // frame label, below the page) moves the camera too (boardGestures.ts).
  useEffect(() => (mode === "board" && !reveal ? attachBoardSurface(editor) : undefined), [editor, mode, reveal]);

  // Keep an in-flight tap across renders (agent updates can arrive between down and up).
  const frameTap = useRef({ frames, openFrame });
  frameTap.current = { frames, openFrame };

  // A hand-tool tap opens the frame conversation, including when its transcript was deleted.
  // In frame mode an already-open thread keeps the collapse gesture below.
  useEffect(() => {
    if (mode !== "board" && (mode !== "frame" || threadOpen)) return;
    const el = editor.getContainer();
    let down: { x: number; y: number; t: number; id: number } | null = null;
    let fingers = 0;
    const onDown = (e: PointerEvent) => {
      fingers++;
      down = fingers === 1 && e.isPrimary ? { x: e.clientX, y: e.clientY, t: Date.now(), id: e.pointerId } : null;
    };
    const onUp = (e: PointerEvent) => {
      fingers = Math.max(0, fingers - 1);
      const d = down;
      down = null;
      if (!d || d.id !== e.pointerId || editor.getCurrentToolId() !== "hand" || immersiveNow()) return;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8 || Date.now() - d.t > 400) return;
      const p = editor.screenToPage({ x: e.clientX, y: e.clientY });
      const boxes = frameTap.current.frames.flatMap((f) => {
        if (f.pageId !== editor.getCurrentPageId()) return [];
        const b = editor.getShapePageBounds(f.id as TLShapeId);
        return b ? [{ id: f.id, bound: !!f.agentId, x: b.x, y: b.y, w: b.w, h: b.h }] : [];
      });
      const hit = frameAtTap(boxes, p);
      if (hit) frameTap.current.openFrame(hit.id);
    };
    const onMove = (e: PointerEvent) => {
      if (down?.id === e.pointerId && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8) down = null;
    };
    const onCancel = () => {
      fingers = Math.max(0, fingers - 1);
      down = null;
    };
    el.addEventListener("pointerdown", onDown, true);
    el.addEventListener("pointerup", onUp, true);
    el.addEventListener("pointercancel", onCancel, true);
    el.addEventListener("pointermove", onMove, true);
    return () => {
      el.removeEventListener("pointerdown", onDown, true);
      el.removeEventListener("pointerup", onUp, true);
      el.removeEventListener("pointercancel", onCancel, true);
      el.removeEventListener("pointermove", onMove, true);
    };
  }, [editor, mode, threadOpen]);

  const current = frames.find((f) => f.id === frameId) ?? null;
  const exists = (id: string) => frames.some((f) => f.id === id);
  const jumpNeedsYou = () => {
    const id = nextNeedsYou(waiting.map((f) => f.id), lastNeed.current);
    if (!id) return;
    lastNeed.current = id;
    openFrame(id, true);
  };

  // Start agent: on an open empty frame, the start sheet for it; otherwise a new frame right
  // of everything on the page, opened under the start sheet. One sheet (and frame) at a time.
  const startAgent = () => {
    if (starting.current) return;
    starting.current = true;
    // In a frame with no agent: "Start agent here" uses that frame.
    if (mode === "frame" && current && !current.agentId && current.rawStatus !== "requested" && !current.preview) {
      closeThread();
      setStartFor({ id: current.id, owned: false, beside: true });
      return;
    }
    // The page you are on; from the tiles showing every page (none in view), the page last
    // started on from this device.
    const remembered = lastStartPage(boardId) as TLPageId | null;
    const page = mode === "tiles" && !tilePage && remembered && editor.getPage(remembered) ? remembered : editor.getCurrentPageId();
    if (page !== editor.getCurrentPageId()) editor.setCurrentPage(page);
    const onPage = frames.filter((f) => f.pageId === page);
    // An empty "New agent" frame already on the page (an earlier start that never went): start
    // there rather than drawing another one beside it.
    const spare = onPage.find((f) => f.name === "New agent" && !f.agentId && f.rawStatus !== "requested" && !f.preview && emptyFrame(editor, f.id) && !(editor.getShape(f.id as TLShapeId)?.meta as { paseo?: unknown } | undefined)?.paseo);
    if (spare) {
      rememberFrame(storage(), key, spare.id);
      setTouchedTick((n) => n + 1);
      setSearch(false);
      closeThread();
      setHist((h) => visit(h, spare.id));
      setFrameId(spare.id);
      setMode("frame");
      editor.selectNone();
      setStartFor({ id: spare.id, owned: true });
      return;
    }
    // A new frame beside the frame you are in, else beside the page's most recently active
    // frame, else right of everything on the page.
    const boxes = onPage.flatMap((f) => editor.getShapePageBounds(f.id as TLShapeId) ?? []);
    const anchor = (mode === "frame" && current && current.pageId === page ? current : null) ?? [...onPage].sort((a, b) => (touched.get(b.id) ?? -Infinity) - (touched.get(a.id) ?? -Infinity)).find((f) => touched.has(f.id)) ?? null;
    const anchorBox = anchor ? editor.getShapePageBounds(anchor.id as TLShapeId) : null;
    const at = anchorBox ? besideFrame(anchorBox, boxes) : newFrameSpot(boxes);
    const id = createShapeId();
    editor.createShape({ id, type: "frame", x: at.x, y: at.y, props: { w: 960, h: 640, name: "New agent" }, meta: draftMeta() });
    rememberFrame(storage(), key, id);
    setTouchedTick((n) => n + 1);
    setSearch(false);
    closeThread();
    setHist((h) => visit(h, id));
    setFrameId(id);
    setMode("frame");
    editor.selectNone();
    setStartFor({ id, owned: true });
  };
  // "New frame next to it" (start sheet on a frame without an agent): drawn at Start, beside it.
  const frameBeside = (source: string): string | null => {
    const b = editor.getShapePageBounds(source as TLShapeId);
    const page = editor.getAncestorPageId(source as TLShapeId);
    if (!b || !page) return null;
    const others = frames.filter((f) => f.pageId === page).flatMap((f) => editor.getShapePageBounds(f.id as TLShapeId) ?? []);
    const at = besideFrame(b, others);
    const id = createShapeId();
    editor.createShape({ id, type: "frame", parentId: page, x: at.x, y: at.y, props: { w: 960, h: 640, name: "New agent" }, meta: draftMeta() });
    rememberFrame(storage(), key, id);
    setTouchedTick((n) => n + 1);
    setHist((h) => visit(h, id));
    setFrameId(id);
    return id;
  };
  // Leftover empty drafts: the phone's own (marked) and, from before the mark, empty "New
  // agent" frames with no binding at all. Never the frame open now or under the sheet.
  useEffect(() => {
    if (startFor || !frames.length) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // On the tiles the touch device lock (locks.ts) is still on (the shell lifts it in a frame
    // or on the board), and it vetoes deletes: lift it for this sweep only. The board's own
    // "Lock layout" still holds; then the leftovers stay, and the sweep tries again later.
    const sweep = (tries: number) => {
      timer = setTimeout(() => {
        // Read the board now (on entry the store is still filling in when the effect runs).
        const all = editor.getPages().flatMap((p) => [...editor.getPageShapeIds(p.id)]);
        const gone = leftoverDrafts(editor, all, userId, Date.now()).filter((id) => id !== frameId);
        if (gone.length) {
          const was = deviceLock.get();
          deviceLock.set(false);
          // Housekeeping, not an edit of yours: outside the undo history (it still syncs).
          try { editor.run(() => editor.deleteShapes(gone as TLShapeId[]), { history: "ignore" }); } finally { deviceLock.set(was); }
        }
        if (gone.some((id) => editor.getShape(id as TLShapeId)) && tries > 1) sweep(tries - 1);
      }, tries === 4 ? 1500 : 2000);
    };
    sweep(4);
    return () => clearTimeout(timer);
    // biome-ignore lint/correctness/useExhaustiveDependencies: on entry and each return to the tiles.
  }, [mode === "tiles", startFor === null, frames.length > 0]);
  // Dismissed without Start: a frame drawn for the sheet goes away (if still empty), and with
  // it its history entry; the view steps back to where you were.
  const cancelStart = () => {
    const s = startFor;
    starting.current = false;
    setStartFor(null);
    if (!s?.owned || !emptyFrame(editor, s.id)) return;
    const back = stepTarget(hist, -1, (x) => x !== s.id && frames.some((f) => f.id === x));
    editor.deleteShape(s.id as TLShapeId);
    setHist((h) => forget(h, s.id));
    if (back && mode === "frame") {
      setFrameId(back);
      const f = frames.find((x) => x.id === back);
      if (f?.agentId) openThread(back);
    } else setMode("tiles");
  };
  // Started: the new agent's thread (its starting state first, then the conversation).
  // Then where it is: the board around it for a moment (Reveal.tsx), then its thread.
  const started = (id: string) => {
    starting.current = false;
    setStartFor(null);
    closeThread();
    setReveal({ id, thenThread: true });
  };
  const revealDone = () => {
    const r = reveal;
    setReveal(null);
    // Half height, so the new frame stays in view above its thread.
    if (r?.thenThread) {
      openThreadAtHalf(r.id);
      openThread(r.id);
    }
  };
  // ⋯ → Move frame… (thread menu): the Move sheet for that frame.
  const moveAsk = useAskedMove();
  const [movingSheet, setMovingSheet] = useState<string | null>(null);
  useEffect(() => {
    if (!moveAsk) return;
    askMove(null);
    if (frames.some((f) => f.id === moveAsk)) setMovingSheet(moveAsk);
    // biome-ignore lint/correctness/useExhaustiveDependencies: one ask, one sheet.
  }, [moveAsk]);
  // ⋯ → Show on board (thread menu, frame sheet): the same zoom-out for the open frame.
  const revealAsk = useAskedReveal();
  useEffect(() => {
    if (!revealAsk) return;
    askReveal(null);
    if (!frames.some((f) => f.id === revealAsk)) return;
    // The live board view (pan, pinch, tap a frame), zoomed to the frame among its neighbours,
    // with the frame highlighted for a moment and "← <frame>" to go back.
    setRenaming(null);
    if (frameId !== revealAsk) {
      setFrameId(revealAsk);
      setHist((h) => visit(h, revealAsk));
    }
    showOnBoard(revealAsk);
    // biome-ignore lint/correctness/useExhaustiveDependencies: one ask, one view.
  }, [revealAsk]);
  // "+ New" (top bar) / "Start agent about this" in a thread: a new frame beside that thread's
  // frame (same page, free space), under the start sheet prefilled like that agent. Its
  // history entry follows the source's, so the back pill returns there.
  const besideAsk = useAskedStartBeside();
  useEffect(() => {
    if (!besideAsk) return;
    askStartBeside(null);
    const src = editor.getShape(besideAsk.source as TLShapeId);
    const bounds = src ? editor.getShapePageBounds(src.id) : null;
    const page = src ? editor.getAncestorPageId(src.id) : null;
    if (starting.current || !src || !bounds || !page) return;
    starting.current = true;
    if (page !== editor.getCurrentPageId()) editor.setCurrentPage(page);
    const others = frames.filter((f) => f.pageId === page).flatMap((f) => editor.getShapePageBounds(f.id as TLShapeId) ?? []);
    const at = besideFrame(bounds, others);
    const id = createShapeId();
    editor.createShape({ id, type: "frame", x: at.x, y: at.y, props: { w: 960, h: 640, name: "New agent" }, meta: draftMeta() });
    rememberFrame(storage(), key, id);
    setTouchedTick((n) => n + 1);
    closeThread();
    setSearch(false);
    setHist((h) => visit(visit(h, besideAsk.source), id));
    setFrameId(id);
    setMode("frame");
    editor.selectNone();
    setStartFor({ id, owned: true, prefill: besideAsk.prefill });
    // biome-ignore lint/correctness/useExhaustiveDependencies: one ask, one frame.
  }, [besideAsk]);
  // The frame panel's Start conversation on an empty frame asks for the sheet.
  const sheetAsk = useAskedStartSheet();
  useEffect(() => {
    if (!sheetAsk) return;
    askStartSheet(null);
    if (starting.current || !emptyFrame(editor, sheetAsk)) return;
    starting.current = true;
    editor.selectNone();
    closeThread();
    setStartFor({ id: sheetAsk, owned: false });
  }, [sheetAsk, editor, closeThread]);


  // Frame mode with the thread open: a tap on the canvas (not a pan) collapses it to the peek.
  useEffect(() => {
    if (mode !== "frame" || !threadOpen) return;
    const el = editor.getContainer();
    let down: { x: number; y: number; t: number; id: number } | null = null;
    const onDown = (e: PointerEvent) => {
      down = e.isPrimary ? { x: e.clientX, y: e.clientY, t: Date.now(), id: e.pointerId } : null;
    };
    const onUp = (e: PointerEvent) => {
      const d = down;
      down = null;
      if (!d || d.id !== e.pointerId || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8 || Date.now() - d.t > 400 || immersiveNow()) return;
      closeThread();
    };
    el.addEventListener("pointerdown", onDown, true);
    el.addEventListener("pointerup", onUp, true);
    return () => {
      el.removeEventListener("pointerdown", onDown, true);
      el.removeEventListener("pointerup", onUp, true);
    };
  }, [editor, mode, threadOpen, closeThread]);

  // Bunny's corner button gives way on the tiles and while a sheet is up.
  useEffect(() => {
    document.documentElement.classList.toggle("bm-covered", threadOpen || search || mode === "tiles" || !!startFor || !!renaming || !!reveal);
    // The tiles cover the whole canvas: do not paint it underneath (scrolling the grid
    // otherwise repaints a board of a thousand shapes behind an opaque page).
    document.documentElement.classList.toggle("bm-canvas-hidden", mode === "tiles");
    return () => document.documentElement.classList.remove("bm-covered", "bm-canvas-hidden");
  }, [threadOpen, search, mode, startFor, renaming, reveal]);

  // A deleted or archived frame leaves frame mode.
  useEffect(() => {
    if (mode === "frame" && frameId && !frames.some((f) => f.id === frameId)) setMode("tiles");
  }, [mode, frameId, frames]);

  // Board mode: drag the dock's grip up for the tiles.
  const boardPull = useDragCommit(1, 80, () => setMode("tiles"));

  // Only when someone waits on you; nothing otherwise (an "all clear" label read as "clear all").
  const pill = waiting.length ? (
    <button type="button" className="bm-need" data-testid="mobile-needs-you" onClick={jumpNeedsYou} aria-label={`${waiting.length} agent${waiting.length === 1 ? "" : "s"} need you: open the next`}>
      {waiting.length} need{waiting.length === 1 ? "s" : ""} you →
    </button>
  ) : null;
  const boardName = boardLabel(boardId);
  const places = useRecentPlaces();
  const elsewhere = otherBoardPlace(places, boardId, Date.now());
  const pageLabel = pages.length > 1 ? (tilePage ? pages.find((p) => p.id === tilePage)?.name ?? "" : "All pages") : "";

  return (
    <div className="bm-root" data-mode={mode}>
      {mode === "frame" && current ? (
        <div className="bm-top" data-mobile-ui data-testid="mobile-top">
          <button type="button" className="bm-back" data-testid="mobile-back" onClick={toTiles} aria-label="Back to frames">
            <AppIcon name="chevron-left" size={22} />
          </button>
          <span className="bm-frame-title" data-testid="mobile-frame-title" role="button" tabIndex={0} aria-label={`${current.name}: tap to rename`} onKeyDown={(e) => { if (e.key === "Enter") setRenaming(current.id); }} {...hswipe((dir) => { const id = neighbour(order, frameId, dir); if (id && id !== frameId) openFrame(id); }, () => setRenaming(current.id))}>
            <StatusDot status={current.rawStatus} />
            <b>{current.name}</b>
          </span>
          {/* A new agent beside this frame, like this one (same model, same machine). */}
          <button type="button" className="bm-newagent" data-testid="mobile-new-agent" aria-label="New agent beside this frame" onClick={() => {
            // biome-ignore lint/suspicious/noExplicitAny: meta JSON.
            const paseo = ((editor.getShape(current.id as TLShapeId)?.meta as any)?.paseo ?? {}) as Record<string, unknown>;
            void startBeside({ frameId: current.id, agentId: typeof paseo.agentId === "string" ? paseo.agentId : undefined, binding: paseo, frameName: current.name, boardId });
          }}>
            + New
          </button>
          <button type="button" className="bm-pinframe" data-testid="mobile-pin-frame" aria-pressed={pins.includes(current.id)} aria-label={pins.includes(current.id) ? `Unpin ${current.name}` : pins.length >= PIN_LIMIT ? `Pin ${current.name} (replaces your least used of ${PIN_LIMIT} pins)` : `Pin ${current.name}`} onClick={() => togglePin(current.id)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill={pins.includes(current.id) ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 4h6l-1 6 3 3H7l3-3-1-6zM12 13v7" />
            </svg>
          </button>
          <FullBoardButton onClick={fullBoard} />
          {/* Portrait: a row under the bar; landscape: in the bar itself, in the title's place
              (the open frame's chip is highlighted), so the frame keeps the screen's height. */}
          {/* With the thread up the chips and jump pills give their row to the conversation
              (collapse the thread, or swipe the title, to switch frames). */}
          {threadOpen ? null : <QuickSwitch frames={frames} order={order} current={current.id} jumps={stepTarget(hist, -1, exists) || stepTarget(hist, 1, exists) ? <JumpPills history={hist} names={(id) => frames.find((f) => f.id === id)?.name ?? "frame"} exists={exists} go={(at) => openFrame(hist.stack[at], undefined, at)} /> : null} openFrame={openFrame} rename={() => setRenaming(current.id)} />}
          {pill}
        </div>
      ) : (
        <div className="bm-top" data-mobile-ui data-testid="mobile-top">
          <button type="button" className="bm-board" data-testid="mobile-board-name" aria-expanded={boards} onClick={() => setBoards((b) => !b)}>
            {boardName}
            {pageLabel ? <small className="bm-board-page" data-testid="mobile-page-name"> · {pageLabel}</small> : null} <span aria-hidden="true">▾</span>
          </button>
          {mode === "board" && boardFocus && frames.some((f) => f.id === boardFocus) ? (
            <button type="button" className="bm-backframe" data-testid="mobile-board-back" onClick={() => openFrame(boardFocus)}>
              ← {frames.find((f) => f.id === boardFocus)?.name}
            </button>
          ) : null}
          {elsewhere ? (
            <button type="button" className="bm-backframe" data-testid="mobile-place-back" onClick={() => openPlace(elsewhere.board, elsewhere.frame)} aria-label={`Back to ${placeLabel(elsewhere)}`}>
              ← {placeLabel(elsewhere)}
            </button>
          ) : null}
          {pill}
        </div>
      )}
      {boards ? (
        <BoardSwitcher boardId={boardId} close={() => setBoards(false)}>
          <PageMenu pages={pages} frames={frames} current={tilePage} pick={(id) => { setBoards(false); setTilePage(id); if (id && id !== editor.getCurrentPageId()) editor.setCurrentPage(id as TLPageId); toTiles(); }} add={() => { setBoards(false); setCreating("page"); }} />
        </BoardSwitcher>
      ) : null}

      {mode === "tiles" ? (
        <TilesHome editor={editor} frames={pageTiles(frames, tilePage)} allFrames={frames} pins={pins} touched={touched} now={now} openFrame={openFrame} openSearch={() => setSearch(true)} toBoard={toBoard} startAgent={startAgent} openNew={() => setNewMenu(true)} />
      ) : null}

      {mode === "frame" && frameId && !reveal ? <FrameSpotlight editor={editor} frameId={frameId} /> : null}
      {mode === "board" && boardFocus ? <FocusOutline key={`o${focusShown}`} editor={editor} frameId={boardFocus} /> : null}
      {mode === "board" && boardFocus ? <FocusLabel key={`l${focusShown}`} editor={editor} frameId={boardFocus} /> : null}
      {reveal ? <Reveal key={reveal.id} editor={editor} frameId={reveal.id} done={revealDone} /> : null}
      <TellBunny editor={editor} boardId={boardId} frames={frames} touched={touched} current={mode === "frame" ? frameId : null} openFrame={(id) => openFrame(id, true)} />

      {mode !== "tiles" && !threadOpen && !search && !startFor && !renaming && !movingSheet && !reveal ? (
        <div className="bm-dock" data-mobile-ui data-testid="mobile-bar">
          {mode === "board" ? (
            <div className="bm-grip" {...boardPull.handlers} style={{ ...boardPull.handlers.style, transform: boardPull.offset ? `translateY(${-boardPull.offset}px)` : undefined }}>
              <span />
              <small>swipe up for frames</small>
            </div>
          ) : current?.agentId ? (
            <ThreadPeek frame={current} open={() => openThread(current.id)} />
          ) : null}
          <div className="bm-tools">
            <button type="button" data-testid="mobile-hand" aria-pressed={tool === "hand"} onClick={() => editor.setCurrentTool("hand")} aria-label="Pan">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11.5v-8a1.5 1.5 0 0 1 3 0V12M14 5.5a1.5 1.5 0 0 1 3 0V13M17 8.5a1.5 1.5 0 0 1 3 0V15a7 7 0 0 1-7 7h-1.2a6 6 0 0 1-4.8-2.4L3.4 15.8a1.6 1.6 0 0 1 2.5-2L8 16" />
              </svg>
              <small>Hand</small>
            </button>
            <AddButton />
            {mode === "frame" && current?.agentId ? null : (
              <button type="button" className="bm-start" data-testid="mobile-start" data-here={mode === "frame" && !!current && !current.agentId && current.rawStatus !== "requested"} onClick={startAgent}>
                {mode === "frame" && current && !current.agentId && current.rawStatus !== "requested" ? "Start agent here" : "+ Start agent"}
              </button>
            )}
            <button type="button" data-testid="mobile-search" onClick={() => setSearch(true)} aria-label="Search frames">
              <AppIcon name="search" size={22} />
              <small>Search</small>
            </button>
            <HistoryButtons editor={editor} />
          </div>
        </div>
      ) : null}
      {/* Editing on the phone (AddSheet.tsx, editGestures.ts): hold to pick up, + Add, undo. */}
      {/* Also with the thread sheet up (at any stop): the canvas above it can be edited too. */}
      {/* Landscape on a frame or the board: an immersive whiteboard (Immersive.tsx). */}
      <Immersive editor={editor} active={mode !== "tiles" && !modalOpen} />
      {mode !== "tiles" && !search ? <MobileEdit editor={editor} frameId={mode === "frame" ? frameId : null} board={mode === "board"} threadOpen={threadOpen} /> : null}

      {movingSheet && frames.some((f) => f.id === movingSheet) ? <MoveSheet editor={editor} frameId={movingSheet} close={() => setMovingSheet(null)} moveOnBoard={() => { if (frameId !== movingSheet) { setFrameId(movingSheet); setHist((h) => visit(h, movingSheet)); } moveOnBoard(movingSheet); }} /> : null}
      {renaming && frames.some((f) => f.id === renaming) ? <RenameSheet editor={editor} frameId={renaming} close={() => setRenaming(null)} moveOnBoard={() => moveOnBoard(renaming)} /> : null}
      {startFor ? <StartSheet key={startFor.id} editor={editor} boardId={boardId} frameId={startFor.id} prefill={startFor.prefill} beside={startFor.beside ? { name: frames.find((f) => f.id === startFor.id)?.name ?? "this frame", make: () => frameBeside(startFor.id) } : undefined} where={startFor.owned ? `New frame ${whereOnBoard(editor, startFor.id)}` : `In “${frames.find((f) => f.id === startFor.id)?.name ?? "this frame"}”`} movable={startFor.owned} onCancel={cancelStart} onStarted={started} /> : null}
      {newMenu ? <NewMenu close={() => setNewMenu(false)} pick={pickNew} /> : null}
      {creating ? <CreateSheet kind={creating} where={creating === "frame" ? `On ${pages.find((p) => p.id === (tilePage ?? editorPage))?.name ?? "this page"}` : "A separate space on this board"} create={creating === "page" ? createPage : createFrame} close={() => setCreating(null)} /> : null}
      {search ? <SearchSheet editor={editor} frames={frames} pins={pins} touched={touched} now={now} close={() => setSearch(false)} openFrame={openFrame} togglePin={togglePin} /> : null}
    </div>
  );
}

export function boardLabel(board: string): string {
  return board === "main" ? "Bunny board" : board;
}

function placeLabel(p: Place): string {
  return p.title ? `${boardLabel(p.board)} · ${p.title}` : boardLabel(p.board);
}

// The last place on another board, if it was within a day: the top bar's jump back to it.
export function otherBoardPlace(places: readonly Place[], boardId: string, now: number): Place | null {
  const p = places.find((x) => x.board !== boardId);
  return p && now - p.at < 24 * 3600_000 ? p : null;
}

function BoardSwitcher({ boardId, close, children }: { boardId: string; close: () => void; children?: React.ReactNode }) {
  const [list, setList] = useState<{ id: string; frames: number; boundFrames: number }[] | null>(null);
  // Frames only: a board's own entry is already in the list under it.
  const recent = useRecentPlaces().filter((p) => p.board !== boardId && p.frame).slice(0, 4);
  useEffect(() => {
    api<{ boards: { id: string; frames: number; boundFrames: number }[] }>("/api/ui/boards").then((r) => setList(r.boards)).catch(() => setList([]));
  }, []);
  return (
    <>
      <div className="bm-scrim bm-scrim-clear" data-mobile-ui onPointerDown={close} />
      <div className="bm-boards" data-mobile-ui data-testid="mobile-boards" role="menu">
        <ThemePicker />
        {/* Frames this phone had open on other boards: one tap back to that board and frame. */}
        {recent.length ? (
          <div className="bm-recent" data-testid="mobile-recent-places">
            <small>Recent</small>
            {recent.map((p) => (
              <button key={p.board} type="button" role="menuitem" data-testid="mobile-recent-place" onClick={() => { close(); openPlace(p.board, p.frame); }}>
                <b>{p.title ?? boardLabel(p.board)}</b>
                <small>{p.title ? boardLabel(p.board) : "board"}</small>
              </button>
            ))}
          </div>
        ) : null}
        {list === null ? <p className="bm-empty">Loading boards…</p> : null}
        {(list ?? []).map((b) => (
          <Fragment key={b.id}>
            <button type="button" role="menuitem" aria-current={b.id === boardId} onClick={() => { close(); if (b.id !== boardId) goToBoard(b.id); }}>
              <b>{b.id === "main" ? "Bunny board" : b.id}</b>
              <small>
                {b.frames} frame{b.frames === 1 ? "" : "s"} · {b.boundFrames} agent{b.boundFrames === 1 ? "" : "s"}
              </small>
            </button>
            {/* The open board's pages, under it (same names and order as desktop). */}
            {b.id === boardId ? children : null}
          </Fragment>
        ))}
      </div>
    </>
  );
}

function TilesHome({ editor, frames, allFrames, pins, touched, now, openFrame, openSearch, toBoard, startAgent, openNew }: { editor: Editor; frames: Frame[]; allFrames: Frame[]; pins: string[]; touched: Map<string, number>; now: number; openFrame: (id: string, thread?: boolean) => void; openSearch: () => void; toBoard: () => void; startAgent: () => void; openNew: () => void }) {
  const { pinned, pinnedFallback, recent, rest } = tileSections(frames, pins, touched, 10, 6, allFrames);
  const pull = useDragCommit(-1, 120, toBoard);
  // All frames: the first rows at once, the rest added in idle time, 12 at a time (a live
  // board has ~150 frames; laying them all out in the first frame cost ~1 s at 4x CPU
  // throttle, and the first render is the tiles' time to interactive).
  const [shown, setShown] = useState(6);
  useEffect(() => {
    if (shown >= rest.length) return;
    const w = window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
    const id = w.requestIdleCallback ? w.requestIdleCallback(() => setShown((n) => n + 12), { timeout: 1500 }) : window.setTimeout(() => setShown((n) => n + 12), 200);
    return () => (w.cancelIdleCallback ? w.cancelIdleCallback(id) : clearTimeout(id));
  }, [shown, rest.length]);
  return (
    <div className="bm-home" data-mobile-ui data-testid="mobile-tiles" style={pull.offset ? { transform: `translateY(${pull.offset}px)`, transition: "none" } : undefined}>
      <div className="bm-grip" {...pull.handlers}>
        <span />
        <small>swipe down for board</small>
      </div>
      <div className="bm-home-body">
        <button type="button" className="bm-search-field" data-testid="mobile-search-open" onClick={openSearch}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5" />
            <path d="M16 16l4.5 4.5" />
          </svg>
          Jump to frame or agent…
        </button>
        {pinned.length ? (
          <section>
            <h3>
              Pinned{pinnedFallback ? <span className="bm-h3-note"> · none yet, showing latest</span> : null}
            </h3>
            {pinnedFallback ? (
              <div className="bm-grid" data-testid="mobile-pinned">
                {pinned.map((f) => (
                  <Tile key={f.id} editor={editor} frame={f} touched={touched.get(f.id)} now={now} open={() => openFrame(f.id)} />
                ))}
              </div>
            ) : (
              // Real pins as a compact list, so all of them fit above the fold.
              <div className="bm-pinlist" data-testid="mobile-pinned">
                {pinned.map((f) => (
                  <PinRow key={f.id} frame={f} touched={touched.get(f.id)} now={now} open={() => openFrame(f.id)} />
                ))}
              </div>
            )}
          </section>
        ) : null}
        {recent.length ? (
          <section>
            <h3>Recent</h3>
            <div className="bm-row" data-testid="mobile-recent">
              {recent.map((f) => (
                <Tile key={f.id} editor={editor} frame={f} touched={touched.get(f.id)} now={now} open={() => openFrame(f.id)} />
              ))}
            </div>
          </section>
        ) : null}
        <section>
          <h3>All frames</h3>
          {rest.length ? (
            <div className="bm-grid" data-testid="mobile-all">
              {rest.slice(0, shown).map((f) => (
                <Tile key={f.id} editor={editor} frame={f} touched={touched.get(f.id)} now={now} open={() => openFrame(f.id)} />
              ))}
            </div>
          ) : (
            <p className="bm-empty">{frames.length ? "Every frame is shown above." : "No frames yet. Tap Start agent, or + New to add a frame or import a conversation."}</p>
          )}
        </section>
      </div>
      <div className="bm-home-bar">
        <button type="button" className="bm-fab" data-testid="mobile-start" onClick={startAgent}>
          + Start agent
        </button>
        <button type="button" className="bm-new" data-testid="mobile-new" aria-haspopup="menu" onClick={openNew}>
          + New
        </button>
        <TellBunnyButton />
      </div>
    </div>
  );
}

function agentLine(frame: Frame, harness: string) {
  if (frame.agentId) return agentLabel(harness, frame.host);
  if (frame.preview) return agentLabel(frame.provider || frame.agentTitle, frame.host);
  return frame.relink ? agentLabel("agent to re-link", frame.host) : "no agent";
}

// True once the element has been on screen (then stays true).
function useSeen(ref: React.RefObject<HTMLElement | null>): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setSeen(true);
        io.disconnect();
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, seen]);
  return seen;
}

function Tile({ editor, frame, touched, now, open }: { editor: Editor; frame: Frame; touched?: number; now: number; open: () => void }) {
  const self = useRef<HTMLButtonElement>(null);
  // The harness ("Claude") is asked for only once the tile is on screen.
  const seen = useSeen(self) ? frame.agentId : "";
  const summary = useAgentSummary(seen, !!seen);
  const harness = harnessOf(seen, summary);
  return (
    <button ref={self} type="button" className="bm-tile" data-testid="mobile-frame-card" data-frame-id={frame.id} data-status={frame.rawStatus} data-touched={touched ?? ""} onClick={open}>
      <LiveThumb editor={editor} id={frame.id} />
      <span className="bm-tile-name">
        <StatusDot status={frame.rawStatus} title={frame.status} />
        <span className="bm-tile-name-text">{frame.name}</span>
      </span>
      <small>{agentLine(frame, harness)}</small>
      <YouLine last={summary?.lastUserMessage} />
      <small className="bm-tile-when" data-tone={frame.preview ? "preview" : frame.rawStatus}>
        {frame.preview
          ? `preview · not connected${touched === undefined ? "" : ` · ${phoneAgo(touched, now)}`}`
          : touched === undefined
            ? frame.rawStatus === "needs-permission"
              ? "needs you"
              : "no interaction yet"
            : `${frame.rawStatus === "needs-permission" ? "needs you ·" : "last interaction"} ${phoneAgo(touched, now)}`}
      </small>
    </button>
  );
}

// A pinned frame on the phone's home: status dot, name, and your last message (or when you
// last used it), one 56px row each.
function PinRow({ frame, touched, now, open }: { frame: Frame; touched?: number; now: number; open: () => void }) {
  const summary = useAgentSummary(frame.agentId, !!frame.agentId);
  const last = summary?.lastUserMessage?.text;
  return (
    <button type="button" className="bm-pinrow" data-testid="mobile-pin-row" data-frame-id={frame.id} data-status={frame.rawStatus} onClick={open}>
      <StatusDot status={frame.rawStatus} title={frame.status} />
      <span className="bm-pinrow-text">
        <span className="bm-pinrow-name">{frame.name}</span>
        <small>{last ? `You: ${last}` : frame.rawStatus === "needs-permission" ? "needs you" : touched === undefined ? "no interaction yet" : phoneAgo(touched, now)}</small>
      </span>
    </button>
  );
}

function SearchSheet({ editor, frames, pins, touched, now, close, openFrame, togglePin }: { editor: Editor; frames: Frame[]; pins: string[]; touched: Map<string, number>; now: number; close: () => void; openFrame: (id: string, thread?: boolean) => void; togglePin: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const t = setTimeout(() => input.current?.focus(), 60);
    return () => clearTimeout(t);
  }, []);
  // Report links, read once per frame list (not on every store change).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `frames` changes with the frames.
  const reports = useMemo(() => new Map(indexFrames(editor.store.allRecords(), window.location.origin).flatMap((f) => (f.reportUrl ? [[f.id, f.reportUrl] as const] : []))), [editor, frames]);
  // The box shows every key at once; the search runs 120 ms after the last one.
  const [q, setQ] = useState("");
  useEffect(() => {
    const next = query.trim();
    if (!next) return setQ("");
    const t = setTimeout(() => setQ(next), 120);
    return () => clearTimeout(t);
  }, [query]);
  // The agents' latest messages: load snapshots of the most recent bound agents (and agents
  // of transcript cards) while the sheet is open, and index again as they arrive.
  const [loaded, setLoaded] = useState(0);
  const agentIds = useMemo(() => {
    const cards = editor.store.query.records("shape").get().flatMap((r) => (r.type === "transcript" && (r.props as { agentId?: string }).agentId ? [(r.props as { agentId: string }).agentId] : []));
    const bound = [...frames].filter((f) => f.agentId).sort((a, b) => (touched.get(b.id) ?? 0) - (touched.get(a.id) ?? 0)).map((f) => f.agentId);
    return [...new Set([...bound, ...cards])].slice(0, 60);
  }, [editor, frames, touched]);
  // Conversations arriving re-index at most twice a second, not once per agent.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const bump = () => {
      timer ??= setTimeout(() => {
        timer = null;
        setLoaded((n) => n + 1);
      }, 500);
    };
    const stops = agentIds.map((id) => agentStore.subscribe(id, bump));
    for (const id of agentIds) agentStore.prefetch(id);
    return () => {
      if (timer) clearTimeout(timer);
      stops.forEach((stop) => stop());
    };
  }, [agentIds]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `loaded` re-reads the agent views.
  const docs = useMemo(
    () => buildDocs(frames.map((f) => ({ id: f.id, name: f.name, agentId: f.agentId, agentTitle: f.agentTitle, harness: f.agentId ? harnessKnown.get(f.agentId) ?? "" : f.provider, host: f.agentId || f.preview ? f.host : "" })), editor.store.allRecords(), (id) => (agentStore.get(id)?.rows ?? []) as { kind: string; text: string }[]),
    [editor, frames, loaded],
  );
  const hits = useMemo(() => (q ? searchDocs(docs, q, touched) : []), [docs, q, touched]);
  const hitOf = useMemo(() => new Map(hits.map((h) => [h.id, h])), [hits]);
  const byId = useMemo(() => new Map(frames.map((f) => [f.id, f])), [frames]);
  const results = useMemo(() => (q ? hits.map((h) => byId.get(h.id)).filter((f): f is Frame => !!f) : tileSections(frames, [], touched, 20, 0).recent), [frames, q, touched, hits, byId]);
  const sheetRef = useRef<HTMLDivElement>(null);
  const dismiss = useDragCommit(-1, (sheetRef.current?.offsetHeight ?? 600) * 0.25, close);
  return (
    <>
      <div className="bm-scrim" data-mobile-ui onPointerDown={close} />
      <div ref={sheetRef} className="bm-sheet" data-mobile-ui data-testid="mobile-search-sheet" role="dialog" aria-label="Jump to frame or agent" style={dismiss.offset ? { transform: `translateY(${dismiss.offset}px)`, transition: "none" } : undefined}>
        <div className="bm-grip" {...dismiss.handlers}>
          <span />
          <small>swipe down to close</small>
        </div>
        <div className="bm-sheet-body">
          <input ref={input} className="bm-search" type="search" data-testid="mobile-search-input" placeholder="Jump to frame or agent…" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && results[0]) openFrame(results[0].id); }} />
          <h3>{q ? `${results.length} match${results.length === 1 ? "" : "es"} · names first, then what's inside` : "Recent"}</h3>
          {results.length ? (
            <ul className="bm-results" data-testid="mobile-search-results">
              {(results as Frame[]).slice(0, 30).map((f) => (
                <ResultRow key={f.id} editor={editor} frame={f} hit={hitOf.get(f.id)} pinned={pins.includes(f.id)} pinsFull={pins.length >= PIN_LIMIT} report={reports.get(f.id)} when={phoneAgo(touched.get(f.id), now)} openFrame={openFrame} togglePin={togglePin} />
              ))}
            </ul>
          ) : (
            <p className="bm-empty">{q ? `No frame or agent matches “${q}”.` : "Frames you open or message show up here."}</p>
          )}
        </div>
      </div>
    </>
  );
}

function ResultRow({ editor, frame, hit, pinned, pinsFull, report, when, openFrame, togglePin }: { editor: Editor; frame: Frame; hit?: SearchHit; pinned: boolean; pinsFull: boolean; report?: string; when: string; openFrame: (id: string, thread?: boolean) => void; togglePin: (id: string) => void }) {
  const summary = useAgentSummary(frame.agentId, !!frame.agentId);
  const harness = harnessOf(frame.agentId, summary);
  return (
    <li data-testid="mobile-search-result" data-frame-id={frame.id}>
      <button type="button" className="bm-result-main" onClick={() => openFrame(frame.id)} aria-label={`Open ${frame.name}`}>
        <LiveThumb editor={editor} id={frame.id} w={120} h={76} />
        <span className="bm-result-text">
          <b>
            <StatusDot status={frame.rawStatus} />
            {frame.name}
          </b>
          <small>
            {agentLine(frame, harness)}
            {editor.getPages().length > 1 ? <span data-testid="mobile-result-page"> · {frame.pageName}</span> : null}
          </small>
          <YouLine last={summary?.lastUserMessage} testid="mobile-result-you" />
          {hit ? (
            <small className="bm-hit" data-testid="mobile-search-snippet" data-field={hit.field} data-kind={hit.kind}>
              {hit.snippet}
            </small>
          ) : null}
          <small data-tone={frame.preview ? "preview" : frame.rawStatus}>
            {frame.status} · {when}
          </small>
        </span>
      </button>
      <span className="bm-result-actions">
        {frame.agentId ? (
          <button type="button" data-testid="mobile-follow" onClick={() => openFrame(frame.id, true)}>
            Follow agent
          </button>
        ) : null}
        <button type="button" data-testid="mobile-pin" aria-pressed={pinned} title={!pinned && pinsFull ? `Replaces your least used of ${PIN_LIMIT} pins` : undefined} onClick={() => togglePin(frame.id)}>
          {pinned ? "Unpin" : "Pin"}
        </button>
        {report ? (
          <a href={report} target="_blank" rel="noopener noreferrer" data-testid="mobile-report">
            Open report ↗
          </a>
        ) : null}
      </span>
    </li>
  );
}

// Under the top bar in frame mode: back/forward through your jumps (JumpPills), then the recent
// conversations (status dot, name); the open one is highlighted. Tap one to go straight in.
// The open frame's chip renames it (in landscape the strip takes the title's place).
function QuickSwitch({ frames, order, current, jumps, openFrame, rename }: { frames: Frame[]; order: string[]; current: string; jumps: React.ReactNode; openFrame: (id: string, thread?: boolean) => void; rename?: () => void }) {
  const byId = new Map(frames.map((f) => [f.id, f]));
  const list = order.map((id) => byId.get(id)).filter((f): f is Frame => !!f);
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    strip.current?.querySelector('[aria-current="true"]')?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
  }, [current]);
  if (!list.length && !jumps) return null;
  return (
    <div className="bm-switch" data-mobile-ui data-testid="mobile-switch">
      {jumps}
      <div className="bm-chips" ref={strip}>
      {list.map((f) => (
        <SwitchChip key={f.id} f={f} current={current} openFrame={openFrame} rename={rename} />
      ))}
      </div>
    </div>
  );
}

// A quick-switch chip: status dot and name, and "You: …" under it where the strip has room
// (portrait; mobile.css hides it in the landscape bar).
function SwitchChip({ f, current, openFrame, rename }: { f: Frame; current: string; openFrame: (id: string, thread?: boolean) => void; rename?: () => void }) {
  const summary = useAgentSummary(f.agentId, !!f.agentId);
  const last = summary?.lastUserMessage;
  return (
    <button type="button" className="bm-chip" data-testid="mobile-switch-chip" data-frame-id={f.id} aria-current={f.id === current} data-has-you={last?.text ? "" : undefined} onClick={() => (f.id !== current ? openFrame(f.id) : rename?.())}>
      <span className="bm-chip-name">
        <StatusDot status={f.rawStatus} />
        {f.name}
      </span>
      {last?.text ? <small className="bm-chip-you" data-testid="mobile-chip-you">You: {last.text}</small> : null}
    </button>
  );
}

// Above the thumb bar in frame mode: the agent at a glance and what your last message is
// doing; tap or swipe up for the thread. Keeps checking that send while the thread is closed.
function ThreadPeek({ frame, open }: { frame: Frame; open: () => void }) {
  const view = useAgentView(frame.agentId);
  const harness = useHarness(frame.agentId);
  const sent = useLastSend(frame.agentId, view, view?.status ?? frame.rawStatus);
  const last = [...(view?.rows ?? [])].reverse().find((r) => r.kind === "assistant" && r.text.trim());
  const waiting = (view?.status ?? frame.rawStatus) === "needs-permission";
  // The live view says idle while a cloud session the frame dispatched still works: show the cloud.
  const status = view?.status === "idle" && frame.rawStatus === "cloud" ? "cloud" : (view?.status ?? frame.rawStatus);
  // Stop here too (the collapsed thread), as in the reply box (StopButton.tsx).
  const working = status === "running" || status === "needs-permission";
  const rows = view?.rows?.length ?? 0;
  const stoppedHere = useStopped(frame.agentId, rows);
  const [stopNote, setStopNote] = useState<string | null>(null);
  return (
    <div className="bm-peek" data-testid="mobile-thread-peek" role="button" tabIndex={0} {...swipe(open, () => undefined, open)} onKeyDown={(e) => { if (e.key === "Enter") open(); }}>
      <span className="bm-grip-bar" aria-hidden="true" />
      <span className="bm-peek-row">
        <StatusDot status={status} />
        <b>{view?.title || frame.agentTitle || frame.name}</b>
        <small>
          {agentLabel(harness, frame.host)} · {STATUS_TEXT[status] ?? status}
        </small>
        {working ? <span style={{ marginLeft: "auto", flex: "none" }}><StopButton agentId={frame.agentId} host={frame.host} rows={rows} size={40} onError={setStopNote} /></span> : null}
      </span>
      {stopNote ? <span className="bm-peek-sent" data-tone="error" role="alert">{stopNote}</span> : null}
      <span className="bm-peek-last">{stoppedHere && !working ? "■ Stopped" : waiting ? "Waiting for you: open the thread to approve or reply." : last ? last.text.replace(/\s+/g, " ").slice(0, 140) : "Swipe up for the thread"}</span>
      {sent ? (
        <span className="bm-peek-sent" data-testid="mobile-peek-sent" data-tone={sent.label.tone}>
          You: “{sent.text.replace(/\s+/g, " ").slice(0, 60)}” · {sent.label.text}
        </span>
      ) : null}
      <SendWatcher agentId={frame.agentId} />
    </div>
  );
}

// Frame mode: everything outside the open frame (and its label) fades to the page colour, so
// the frame reads as its own whiteboard. Purely visual: touches still reach the canvas.
function FrameSpotlight({ editor, frameId }: { editor: Editor; frameId: string }) {
  const r = useValue(
    "mobile-spotlight",
    () => {
      const b = editor.getShapePageBounds(frameId as TLShapeId);
      if (!b) return null;
      const tl = editor.pageToViewport({ x: b.x, y: b.y });
      const br = editor.pageToViewport({ x: b.x + b.w, y: b.y + b.h });
      return { x: tl.x - 2, y: tl.y - 30, w: br.x - tl.x + 4, h: br.y - tl.y + 32 };
    },
    [editor, frameId],
  );
  if (!r) return null;
  const part = (style: React.CSSProperties) => <div className="bm-spot" style={style} />;
  return (
    <div className="bm-spotlight" data-testid="mobile-spotlight" aria-hidden="true">
      {part({ left: 0, right: 0, top: 0, height: Math.max(0, r.y) })}
      {part({ left: 0, right: 0, top: r.y + r.h, bottom: 0 })}
      {part({ left: 0, width: Math.max(0, r.x), top: r.y, height: r.h })}
      {part({ left: r.x + r.w, right: 0, top: r.y, height: r.h })}
    </div>
  );
}
