// Frame tabs: a strip down the left of the board, like a browser's vertical tabs. Collapsed
// it is a column of badges (initials on the frame's own colour, ringed in its status colour);
// the toggle opens it with titles. Hovering a tab shows its full name at once, beside the
// strip; the strip itself never moves under the pointer. Sections (frameTabsModel.ts):
// Pinned (the board's pins, the same on every device), Needs you, and Recent (a small cache
// of what you looked at and what you sent messages to), then Pages: one group per page, like
// a browser's tab groups, listing what is active there, with the rest behind "Show all".
// Drag a pinned tab to reorder the pins (Alt+↑/↓ with the keyboard), drag any tab into Pinned
// to pin it there, or drag a pin out of Pinned to unpin it.
// Clicking a tab peeks at the frame in a live window over the board (Portals.tsx) without
// moving the camera or switching the conversation; "Jump there" (or ↗, or a double-click)
// moves the board to it, and Back returns.
import { useEffect, useMemo, useRef, useState } from "react";
import { type Editor, type TLFrameShape, type TLShapeId, useValue } from "tldraw";
import { startPending } from "../../shared/start-pending";
import { api } from "./api";
import { type AttentionItem, type AttentionRow, attentionItems } from "./attentionItems";
import { displayStatus, statusLabel, subagentCount, useAgentView } from "./agents";
import { B, DOT, UI_FONT } from "./bunnyTheme";
import { badgeColor, frameTabs, pageGroups, type RecentFilter, tabInitials } from "./frameTabsModel";
import { noteViewed, RECENCY_EVENT, readAgentSends, readRecents, recencyKey, timeAgo } from "./jumpPaletteModel";
import { allFrames } from "./pageFrames";
import { PIN_LIMIT, usePins } from "./pins";
import { framePeek, jumpToFrame, togglePeek } from "./portals/Portals";
import { useNow } from "./TimelineItemView";

const OPEN_KEY = "bunny-tabs-open";
const GROUPS_KEY = (boardId: string) => `bunny-tabs-groups:${boardId}`;
const FILTER_KEY = "bunny-tabs-filter";
const COLLAPSED_W = 52;
const OPEN_W = 264;

const storage = (): Storage | undefined => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};
const readFlag = (key: string, fallback: string) => {
  try {
    return storage()?.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};
const writeFlag = (key: string, value: string) => {
  try {
    storage()?.setItem(key, value);
  } catch {
    /* the choice lasts until reload */
  }
};


type Paseo = { agentId?: string; status?: string; request?: unknown; boundAt?: number; subagents?: number; cloudSessions?: number; host?: string };
const paseoOf = (f: TLFrameShape) => ((f.meta as { paseo?: Paseo } | undefined)?.paseo ?? {}) as Paseo;

// The agent directory's attention flags, read once every 30 s (not one transcript
// subscription per frame). Hidden tabs do no background work; requests never overlap.
function useAttention(boardId: string, frames: TLFrameShape[]): AttentionItem[] {
  const hasLocal = frames.some((f) => !!paseoOf(f).agentId && !paseoOf(f).host);
  const [rows, setRows] = useState<AttentionRow[]>([]);
  useEffect(() => {
    if (!hasLocal) {
      setRows([]);
      return;
    }
    const ctl = new AbortController();
    let busy = false;
    const load = async () => {
      if (busy || document.hidden || ctl.signal.aborted) return;
      busy = true;
      try {
        const q = new URLSearchParams({ board: boardId, scope: "all", bound: "1", onBoard: "1", status: "attention,running", limit: "1000" });
        const data = await api<{ rows: AttentionRow[] }>(`/api/ui/agents/list?${q}`, { signal: AbortSignal.any([ctl.signal, AbortSignal.timeout(12000)]) });
        if (!ctl.signal.aborted) setRows(data.rows);
      } catch {
        /* keep the last rows; frame states still work offline */
      } finally {
        busy = false;
      }
    };
    void load();
    const timer = setInterval(load, 30000);
    document.addEventListener("visibilitychange", load);
    return () => {
      ctl.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [boardId, hasLocal]);
  return useMemo(() => attentionItems(frames, rows), [frames, rows]);
}

// This viewer's looks and sends, re-read when either changes (here or in another tab).
function useRecency(boardId: string, userId: string): { viewed: Map<string, number>; sent: Map<string, number> } {
  const key = recencyKey(boardId, userId);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    window.addEventListener(RECENCY_EVENT, bump);
    window.addEventListener("storage", bump);
    return () => {
      window.removeEventListener(RECENCY_EVENT, bump);
      window.removeEventListener("storage", bump);
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` re-reads storage.
  return useMemo(() => ({ viewed: readRecents(storage(), key), sent: readAgentSends(storage()) }), [key, tick]);
}

// Live status of a frame's conversation (the same words and colours as the frame panel).
function useTabStatus(frame: TLFrameShape): { key: string; text: string } {
  const p = paseoOf(frame);
  const view = useAgentView(p.agentId);
  if (!p.agentId) return p.request ? { key: "requested", text: "starting…" } : { key: "unbound", text: "no conversation yet" };
  // biome-ignore lint/suspicious/noExplicitAny: frame meta is untyped JSON.
  const status = displayStatus(view, p.boundAt, p.status, p.subagents, p.cloudSessions, p.host, startPending(p as any));
  return { key: status, text: statusLabel(status, subagentCount(view, p.subagents)) };
}

const CSS = `
.bunny-tabs button{font:inherit;color:inherit}
.bunny-tab{display:flex;align-items:center;gap:10px;width:100%;min-height:40px;padding:4px 8px 4px 9px;border:0;border-radius:10px;background:transparent;cursor:pointer;text-align:left;position:relative}
.bunny-tab:hover{background:${B.hover}}
.bunny-tab[data-active]{background:${B.lavenderSoft}}
.bunny-tab:focus-visible{outline:2px solid ${B.violet};outline-offset:-2px}
.bunny-tab-actions{display:none;gap:2px;margin-left:auto}
.bunny-tab-row:hover .bunny-tab-actions,.bunny-tab-row:focus-within .bunny-tab-actions{display:flex}
.bunny-tab-act{width:26px;height:26px;border:0;border-radius:7px;background:transparent;cursor:pointer;display:grid;place-items:center;color:${B.muted}}
.bunny-tab-act:hover{background:${B.hover};color:${B.espresso}}
.bunny-tab-act[disabled]{opacity:.35;cursor:not-allowed}
.bunny-tab-badge{box-shadow:0 0 0 2px ${B.cream},0 0 0 4.5px var(--ring)}
.bunny-tab-badge[data-working]{animation:bunnyTabPulse 1.6s ease-in-out infinite}
@keyframes bunnyTabPulse{0%,100%{box-shadow:0 0 0 2px ${B.cream},0 0 0 4.5px var(--ring)}50%{box-shadow:0 0 0 2px ${B.cream},0 0 0 4.5px color-mix(in srgb,var(--ring) 35%,transparent)}}
.bunny-tab-name{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;overflow-wrap:anywhere;font-weight:600;font-size:13px;line-height:1.25}
.bunny-tab-flyout{position:absolute;z-index:1;pointer-events:none;width:max-content;max-width:320px;padding:7px 11px;border-radius:10px;background:${B.espresso};color:${B.cream};box-shadow:0 8px 24px rgba(46,31,22,.22);transform:translateY(-50%);animation:bunnyTabFly 90ms ease-out}
.bunny-tab-flyout b{display:block;font-size:13px;line-height:1.3;overflow-wrap:anywhere}
.bunny-tab-flyout small{display:block;font-size:11px;opacity:.75;margin-top:2px}
@keyframes bunnyTabFly{from{opacity:0}}
@media (prefers-reduced-motion: reduce){.bunny-tab-badge[data-working]{animation:none}}
.bunny-tab-drop{height:2px;margin:-1px 6px;border-radius:2px;background:${B.violet};box-shadow:0 0 0 1px ${B.cream}}
.bunny-tabs section[data-drop=unpin]{background:color-mix(in srgb,${B.danger} 8%,transparent)}
.bunny-tabs section[data-drop=full]{background:color-mix(in srgb,${B.danger} 8%,transparent)}
.bunny-group-head{display:flex;align-items:center;gap:8px;width:100%;border:0;background:transparent;cursor:pointer;border-radius:8px;padding:5px 6px;text-align:left}
.bunny-group-head:hover{background:${B.hover}}
.bunny-group-chip{flex:none;display:grid;place-items:center;min-width:22px;height:16px;padding:0 5px;border-radius:999px;color:#fff;font:700 10px ${UI_FONT};letter-spacing:.02em;box-sizing:border-box}
.bunny-group-more{border:0;background:transparent;cursor:pointer;color:${B.muted};font-size:11px;text-align:left;padding:2px 9px 4px}
.bunny-group-more:hover{color:${B.espresso}}
.bunny-tabs-seg{display:inline-flex;border:1px solid ${B.line};border-radius:999px;padding:1px}
.bunny-tabs-seg button{border:0;background:transparent;border-radius:999px;padding:1px 8px;font-size:11px;cursor:pointer;color:${B.muted}}
.bunny-tabs-seg button[aria-pressed=true]{background:${B.lavenderSoft};color:${B.espresso};font-weight:600}
`;

const WORKING = new Set(["running", "subagents", "cloud", "starting", "requested"]);
// What a dragged tab carries (its frame id), so drops from elsewhere are ignored.
const TAB_MIME = "application/x-bunny-frame-tab";

function Badge({ id, name, status, dirty }: { id: string; name: string; status: string; dirty?: boolean }) {
  const ring = DOT[status] ?? DOT.unbound;
  return (
    <span
      className="bunny-tab-badge"
      data-working={WORKING.has(status) || undefined}
      data-color={badgeColor(id)}
      aria-hidden
      style={{ "--ring": ring, position: "relative", flex: "none", width: 28, height: 28, margin: 2, borderRadius: 8, display: "grid", placeItems: "center", background: badgeColor(id), color: "#fff", font: `700 11px ${UI_FONT}`, letterSpacing: ".02em" } as React.CSSProperties}
    >
      {tabInitials(name)}
      {dirty ? <span style={{ position: "absolute", top: -6, right: -6, width: 10, height: 10, borderRadius: 5, background: B.violet, boxShadow: `0 0 0 2px ${B.cream}` }} /> : null}
    </span>
  );
}

const PinGlyph = ({ filled }: { filled: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 4h6l-1 6 3 3H7l3-3-1-6zM12 13v7" />
  </svg>
);
const JumpGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7 17L17 7M9 7h8v8" />
  </svg>
);

function Tab({
  editor,
  frame,
  section,
  wide,
  active,
  pinned,
  pinsFull,
  dirty,
  note,
  onPeek,
  onJump,
  onPin,
  onHover,
  onDragStart,
  onDragEnd,
  onMove,
}: {
  editor: Editor;
  frame: TLFrameShape;
  section: string;
  wide: boolean;
  active: boolean;
  pinned: boolean;
  pinsFull: boolean;
  dirty?: boolean;
  note?: string;
  onPeek: () => void;
  onJump: () => void;
  onPin: () => void;
  /** The tab under the pointer (or focused), for the name flyout; null when it leaves. */
  onHover: (tab: { el: HTMLElement; name: string; detail: string } | null) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  /** Alt+↑ / Alt+↓ on a pinned tab: move it one place up or down. */
  onMove?: (dir: -1 | 1) => void;
}) {
  const status = useTabStatus(frame);
  const name = frame.props.name || "Frame";
  // The page name, for frames that are not on the page you are looking at.
  const elsewhere = useValue(
    `tab-page:${frame.id}`,
    () => {
      const page = editor.getAncestorPageId(frame.id as TLShapeId);
      return page && page !== editor.getCurrentPageId() ? (editor.getPage(page)?.name ?? "") : "";
    },
    [editor, frame.id],
  );
  // A page group already says which page it is.
  const detail = [status.text, elsewhere && section !== "page" ? `on ${elsewhere}` : "", note ?? ""].filter(Boolean).join(" · ");
  const pinLabel = pinned ? `Unpin ${name}` : pinsFull ? `Pins are full (${PIN_LIMIT}): unpin one first` : `Pin ${name}`;
  const show = (e: React.SyntheticEvent<HTMLElement>) => onHover({ el: e.currentTarget, name, detail: `${detail}${dirty ? " · reply not read yet" : ""}` });
  return (
    <div
      className="bunny-tab-row"
      style={{ display: "flex", alignItems: "center", position: "relative" }}
      onPointerEnter={show}
      onPointerLeave={() => onHover(null)}
      onFocus={show}
      onBlur={() => onHover(null)}
    >
      <button
        type="button"
        className="bunny-tab"
        data-testid="frame-tab"
        data-section={section}
        data-frame-id={frame.id}
        data-status={status.key}
        data-active={active || undefined}
        data-dirty={dirty || undefined}
        aria-label={`${name}, ${detail}. Peek${onMove ? "; Alt+Up or Alt+Down to reorder" : ""}`}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(TAB_MIME, frame.id);
          e.dataTransfer.effectAllowed = "move";
          onHover(null);
          onDragStart();
        }}
        onDragEnd={onDragEnd}
        onKeyDown={(e) => {
          if (!onMove || !e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
          e.preventDefault();
          e.stopPropagation();
          onMove(e.key === "ArrowUp" ? -1 : 1);
        }}
        onClick={onPeek}
        onDoubleClick={onJump}
        style={wide ? { paddingRight: 64 } : { justifyContent: "center", padding: 4 }}
      >
        <Badge id={frame.id} name={name} status={status.key} dirty={dirty} />
        {wide ? (
          <span style={{ minWidth: 0, flex: 1 }}>
            <span className="bunny-tab-name">{name}</span>
            <span style={{ display: "block", fontSize: 11, color: status.key === "error" ? B.danger : B.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{detail}</span>
          </span>
        ) : null}
      </button>
      {wide ? (
        <span className="bunny-tab-actions" style={{ position: "absolute", right: 6 }}>
          <button type="button" className="bunny-tab-act" data-testid="tab-pin" aria-pressed={pinned} aria-label={pinLabel} title={pinLabel} disabled={!pinned && pinsFull} onClick={onPin}>
            <PinGlyph filled={pinned} />
          </button>
          <button type="button" className="bunny-tab-act" data-testid="tab-jump" aria-label={`Jump to ${name}`} title="Jump there (Back returns)" onClick={onJump}>
            <JumpGlyph />
          </button>
        </span>
      ) : null}
    </div>
  );
}

function Section({ title, wide, testId, children, extra, drop, minHeight, ...dnd }: { title: string; wide: boolean; testId: string; children: React.ReactNode; extra?: React.ReactNode; drop?: string; minHeight?: number } & Pick<React.HTMLAttributes<HTMLElement>, "onDragOver" | "onDragLeave" | "onDrop">) {
  return (
    <section data-testid={testId} data-drop={drop} aria-label={title} {...dnd} style={{ display: "flex", flexDirection: "column", gap: 2, padding: wide ? "6px 8px" : "6px 4px", borderTop: `1px solid ${B.line}`, minHeight }}>
      {wide ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 6px 4px", font: `600 11px ${UI_FONT}`, letterSpacing: ".04em", textTransform: "uppercase", color: B.muted }}>
          <span style={{ flex: 1 }}>{title}</span>
          {extra}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function FrameTabs({ editor, boardId, userId }: { editor: Editor; boardId: string; userId: string }) {
  const frames = useValue("frame-tabs-frames", () => allFrames(editor).get(), [editor]);
  const [pins, togglePin, placePin] = usePins(editor, boardId);
  const attention = useAttention(boardId, frames);
  const { viewed, sent } = useRecency(boardId, userId);
  const [filter, setFilterState] = useState<RecentFilter>(() => (readFlag(FILTER_KEY, "all") === "sent" ? "sent" : "all"));
  const setFilter = (f: RecentFilter) => {
    setFilterState(f);
    writeFlag(FILTER_KEY, f);
  };
  const [open, setOpenState] = useState(() => readFlag(OPEN_KEY, "0") === "1");
  const setOpen = (v: boolean) => {
    setOpenState(v);
    writeFlag(OPEN_KEY, v ? "1" : "0");
  };
  const wide = open;
  // The full name beside the strip, at once, for the tab under the pointer (or focused).
  const aside = useRef<HTMLElement>(null);
  const [flyout, setFlyout] = useState<{ top: number; name: string; detail: string } | null>(null);
  const onHover = (tab: { el: HTMLElement; name: string; detail: string } | null) => {
    const box = aside.current?.getBoundingClientRect();
    if (!tab || !box) return setFlyout(null);
    const r = tab.el.getBoundingClientRect();
    setFlyout({ top: r.top - box.top + r.height / 2, name: tab.name, detail: tab.detail });
  };
  const peek = useValue(framePeek);
  const now = useNow(wide, 30000);
  // Pages and which page each frame is on (a string, so unrelated edits do not re-render).
  const pagesKey = useValue(
    "frame-tabs-pages",
    () => JSON.stringify({ pages: editor.getPages().map((pg) => ({ id: pg.id, name: pg.name })), of: frames.map((f) => [f.id, editor.getAncestorPageId(f) ?? ""]), here: editor.getCurrentPageId() }),
    [editor, frames],
  );
  const pageInfo = useMemo(() => JSON.parse(pagesKey) as { pages: { id: string; name: string }[]; of: [string, string][]; here: string }, [pagesKey]);
  // Collapsed groups (remembered per board) and groups showing all their frames (this visit).
  const [shut, setShutState] = useState<string[]>(() => {
    try {
      const v = JSON.parse(readFlag(GROUPS_KEY(boardId), "[]"));
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  });
  const toggleGroup = (id: string) => {
    const next = shut.includes(id) ? shut.filter((g) => g !== id) : [...shut, id];
    setShutState(next);
    writeFlag(GROUPS_KEY(boardId), JSON.stringify(next));
  };
  const [allOf, setAllOf] = useState<string[]>([]);

  const byId = useMemo(() => new Map(frames.map((f) => [f.id as string, f])), [frames]);
  const tabs = useMemo(() => {
    const list = frames
      .filter((f) => paseoOf(f).status !== "archived")
      .map((f) => ({ id: f.id as string, name: f.props.name || "Frame", agentId: paseoOf(f).agentId ?? "", status: paseoOf(f).status ?? "" }));
    const needs = attention.filter((a) => a.reason === "Needs input").map((a) => a.frameId);
    const pageOf = new Map(pageInfo.of);
    const groups = pageGroups({ frames: list.map((f) => ({ ...f, pageId: pageOf.get(f.id) ?? "" })), pages: pageInfo.pages, needs, viewed, sent, now: Date.now() });
    return { ...frameTabs({ frames: list, pins, needs, viewed, sent, filter }), groups };
  }, [frames, pins, attention, viewed, sent, filter, pageInfo]);

  const peekAt = (id: string) => {
    if (framePeek.get() !== id) noteViewed(boardId, userId, id);
    togglePeek(id);
  };
  const jump = (id: string) => {
    noteViewed(boardId, userId, id);
    jumpToFrame(editor, id);
  };
  const pinsFull = pins.length >= PIN_LIMIT;
  // Dragging a tab: where it would land in Pinned (before a pin, or "end"), or "unpin" when a
  // pin is over the rest of the strip, or "full" when a new pin would not fit.
  const [drag, setDrag] = useState<{ id: string; pinned: boolean } | null>(null);
  const [drop, setDrop] = useState<{ before: string | "end" } | "unpin" | "full" | null>(null);
  const endDrag = () => {
    setDrag(null);
    setDrop(null);
  };
  const pinnedIds = tabs.pinned.map((f) => f.id);
  const overPinned = (e: React.DragEvent<HTMLElement>) => {
    if (!drag) return;
    if (!drag.pinned && pinsFull) {
      setDrop("full");
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    // The first pinned row whose middle is below the pointer: land before it.
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-section="pinned"]')];
    const hit = rows.find((r) => {
      const b = r.getBoundingClientRect();
      return e.clientY < b.top + b.height / 2;
    });
    const before = hit?.dataset.frameId ?? "end";
    setDrop((d) => (d && typeof d === "object" && d.before === before ? d : { before }));
  };
  const dropOnPinned = (e: React.DragEvent<HTMLElement>) => {
    const id = e.dataTransfer.getData(TAB_MIME);
    if (id && drop && typeof drop === "object") placePin(id, drop.before === "end" ? null : drop.before);
    endDrag();
  };
  const overRest = (e: React.DragEvent<HTMLElement>) => {
    if (!drag?.pinned) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDrop("unpin");
  };
  const dropOnRest = (e: React.DragEvent<HTMLElement>) => {
    const id = e.dataTransfer.getData(TAB_MIME);
    if (id && pins.includes(id)) togglePin(id);
    endDrag();
  };
  const restDnd = { onDragOver: overRest, onDrop: dropOnRest };
  const move = (id: string, dir: -1 | 1) => {
    const i = pinnedIds.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= pinnedIds.length) return;
    // Up: before the previous pin. Down: before the one after the next (or at the end).
    placePin(id, dir < 0 ? pinnedIds[j] : (pinnedIds[j + 1] ?? null));
  };
  const line = (key: string) => <div key={key} className="bunny-tab-drop" data-testid="tab-drop-line" aria-hidden />;
  const tab = (id: string, section: string, extra?: { dirty?: boolean; note?: string }) => {
    const f = byId.get(id);
    if (!f) return null;
    return (
      <Tab
        key={`${section}:${id}`}
        editor={editor}
        frame={f}
        section={section}
        wide={wide}
        active={peek === id}
        pinned={pins.includes(id)}
        pinsFull={pinsFull}
        dirty={extra?.dirty}
        note={extra?.note}
        onPeek={() => peekAt(id)}
        onJump={() => jump(id)}
        onPin={() => togglePin(id)}
        onHover={onHover}
        onDragStart={() => setDrag({ id, pinned: pins.includes(id) })}
        onDragEnd={endDrag}
        onMove={section === "pinned" ? (dir) => move(id, dir) : undefined}
      />
    );
  };
  const empty = (text: string) => (wide ? <p style={{ margin: 0, padding: "4px 8px 6px", fontSize: 12, color: B.muted }}>{text}</p> : null);

  return (
    <aside
      aria-label="Frame tabs"
      data-testid="frame-tabs"
      data-state={open ? "open" : "collapsed"}
      className="bunny-tabs"
      ref={aside}
      style={{ position: "relative", flexShrink: 0, width: open ? OPEN_W : COLLAPSED_W, zIndex: 400, font: `13px/1.35 ${UI_FONT}`, color: B.espresso }}
    >
      <style>{CSS}</style>
      {flyout ? (
        <div className="bunny-tab-flyout" data-testid="tab-flyout" role="tooltip" style={{ left: (open ? OPEN_W : COLLAPSED_W) + 8, top: flyout.top }}>
          <b>{flyout.name}</b>
          <small>{flyout.detail}</small>
        </div>
      ) : null}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          bottom: 0,
          width: open ? OPEN_W : COLLAPSED_W,
          boxSizing: "border-box",
          display: "flex",
          flexDirection: "column",
          background: B.cream,
          borderRight: `1px solid ${B.line}`,
          overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 8px 6px", minHeight: 44, boxSizing: "border-box" }}>
          <button
            type="button"
            data-testid="frame-tabs-toggle"
            aria-expanded={open}
            aria-label={open ? "Collapse frame tabs" : "Keep frame tabs open"}
            title={open ? "Collapse" : "Keep open"}
            onClick={() => {
              setOpen(!open);
              setFlyout(null);
            }}
            style={{ width: 34, height: 34, flex: "none", border: `1px solid ${B.line}`, borderRadius: 9, background: "transparent", cursor: "pointer", display: "grid", placeItems: "center" }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="4" width="18" height="16" rx="3" />
              <path d="M9 4v16" />
              {open ? <path d="M16 10l-2 2 2 2" /> : <path d="M14 10l2 2-2 2" />}
            </svg>
          </button>
          {wide ? <strong style={{ flex: 1, fontSize: 13 }}>Frames</strong> : null}
        </div>
        <div onScroll={() => setFlyout(null)} style={{ overflowY: "auto", overflowX: "hidden", overscrollBehavior: "contain", flex: 1, minHeight: 0 }}>
          <Section
            title={drop === "full" ? `Pins are full (${PIN_LIMIT})` : `Pinned ${tabs.pinned.length}/${PIN_LIMIT}`}
            wide={wide}
            testId="tabs-pinned"
            drop={drop === "full" ? "full" : drop && typeof drop === "object" ? "here" : undefined}
            minHeight={drag ? 44 : undefined}
            onDragOver={overPinned}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null);
            }}
            onDrop={dropOnPinned}
          >
            {tabs.pinned.flatMap((f) => [drop && typeof drop === "object" && drop.before === f.id ? line(`line:${f.id}`) : null, tab(f.id, "pinned")])}
            {drop && typeof drop === "object" && drop.before === "end" ? line("line:end") : null}
            {tabs.pinned.length ? null : empty("Pin a frame to keep it here, on every device. Drag tabs here to pin them.")}
          </Section>
          {tabs.needsYou.length ? (
            <Section title={`Needs you ${tabs.needsYou.length}`} wide={wide} testId="tabs-needs-you" drop={drop === "unpin" ? "unpin" : undefined} {...restDnd}>
              {tabs.needsYou.map((f) => tab(f.id, "needs-you"))}
            </Section>
          ) : null}
          <Section
            title={drop === "unpin" ? "Drop to unpin" : "Recent"}
            wide={wide}
            testId="tabs-recent"
            drop={drop === "unpin" ? "unpin" : undefined}
            minHeight={drag?.pinned ? 120 : undefined}
            {...restDnd}
            extra={
              <span className="bunny-tabs-seg" role="group" aria-label="Recent: all or only frames you messaged" style={{ textTransform: "none", letterSpacing: 0 }}>
                <button type="button" data-testid="tabs-filter-all" aria-pressed={filter === "all"} onClick={() => setFilter("all")} title="Frames you looked at or messaged">
                  All
                </button>
                <button type="button" data-testid="tabs-filter-sent" aria-pressed={filter === "sent"} onClick={() => setFilter("sent")} title="Only frames you sent a message to">
                  Sent
                </button>
              </span>
            }
          >
            {tabs.recent.length
              ? tabs.recent.map((f) => tab(f.id, "recent", { dirty: f.dirty, note: f.at > 0 ? `${f.sentAt === f.at ? "sent" : "seen"} ${timeAgo(f.at, now)}` : undefined }))
              : empty(filter === "sent" ? "Frames you message show up here." : "Frames you open show up here.")}
          </Section>
          <Section title="Pages" wide={wide} testId="tabs-pages" {...restDnd}>
            {tabs.groups.map((g) => {
              const closed = shut.includes(g.id);
              const all = allOf.includes(g.id);
              const here = g.id === pageInfo.here;
              const counts = `${g.active.length} active · ${g.active.length + g.rest.length} frame${g.active.length + g.rest.length === 1 ? "" : "s"}`;
              const chip = (
                <span className="bunny-group-chip" style={{ background: badgeColor(g.id) }}>
                  {wide ? g.active.length || "·" : tabInitials(g.name)}
                </span>
              );
              return (
                <div key={g.id} data-testid="tab-group" data-page={g.id} data-closed={closed || undefined} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <button
                    type="button"
                    className="bunny-group-head"
                    data-testid="tab-group-head"
                    aria-expanded={!closed}
                    aria-label={`${g.name}${here ? " (this page)" : ""}: ${counts}. ${closed ? "Expand" : "Collapse"}`}
                    onClick={() => toggleGroup(g.id)}
                    onPointerEnter={(e) => onHover({ el: e.currentTarget, name: `${g.name}${here ? " · this page" : ""}`, detail: counts })}
                    onPointerLeave={() => onHover(null)}
                    style={wide ? undefined : { justifyContent: "center", padding: "4px 0" }}
                  >
                    {chip}
                    {wide ? (
                      <>
                        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600, fontSize: 12 }}>
                          {g.name}
                          {here ? <span style={{ fontWeight: 500, color: B.muted }}> · here</span> : null}
                        </span>
                        <span aria-hidden style={{ color: B.muted, fontSize: 11 }}>{closed ? "▸" : "▾"}</span>
                      </>
                    ) : null}
                  </button>
                  {closed ? null : (
                    <>
                      {g.active.map((f) => tab(f.id, "page"))}
                      {all ? g.rest.map((f) => tab(f.id, "page")) : null}
                      {wide && g.rest.length ? (
                        <button type="button" className="bunny-group-more" data-testid="tab-group-more" onClick={() => setAllOf((a) => (all ? a.filter((x) => x !== g.id) : [...a, g.id]))}>
                          {all ? "Show active only" : `Show all ${g.active.length + g.rest.length}`}
                        </button>
                      ) : null}
                      {wide && !g.active.length && !all ? <p style={{ margin: 0, padding: "0 9px 4px", fontSize: 11, color: B.muted }}>Nothing active</p> : null}
                    </>
                  )}
                </div>
              );
            })}
          </Section>
        </div>
      </div>
    </aside>
  );
}
