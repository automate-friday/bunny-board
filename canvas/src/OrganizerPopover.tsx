// The board organizer ("Bunny"): a launcher in the canvas corner and a ⌘⇧P command bar.
// Patterns borrowed from shipped products rather than invented:
// - Raycast / Linear ⌘K: one input near the top, a context chip, suggestions you can arrow
//   through when the input is empty, and a footer of keyboard hints.
// - macOS screenshot bar: Board / View / Selection / Area scope, with a drag picker.
// - Notion AI / Figma AI: the part of the board being worked on glows while it works, and
//   what changed pulses once when it lands.
// - Intercom-style corner launcher with a status ring; Linear/Gmail undo toast with a
//   countdown.
// Requests run in the background; several can run at once, the rest wait their turn.
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Editor, TLShapeId } from "tldraw";
import { api } from "./api";
import { MobileCtx } from "./mobile/mobileMode";
import { openTellBunny } from "./mobile/TellBunny";
import { BUNNY_CSS, BunnyMark, type BunnyMood } from "./BunnyMark";

type ScopeKind = "board" | "view" | "selection" | "area";
interface Run {
  id: string;
  text: string;
  status: "queued" | "working" | "done" | "error";
  summary: string | null;
  moved: number;
  prompted: number;
  undone: boolean;
  seconds: number | null;
  scope?: ScopeKind;
  changedIds?: string[];
  // Frames whose agents this request messaged.
  promptedIds?: string[];
  finishedAt?: number | null;
  phase?: string | null;
  phaseAt?: number | null;
  at?: number;
}
type BrainState = "cold" | "starting" | "warming" | "warm";
interface Status {
  model: string;
  brain?: BrainState;
  run: Run | null;
  queued: number;
  runs: Run[];
}
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Brand palette (Bunny guide v0.2) and frame-state colours.
const C = {
  cream: "light-dark(#FFF8EB, var(--bunny-surface))",
  espresso: "light-dark(#2E1F16, var(--bunny-ink))",
  violet: "#8875F6",
  lavender: "#C8B4F8",
  orange: "#FF682E",
  starting: "#A78BFA",
  working: "#3B82F6",
  done: "#22C55E",
  needs: "#F97316",
  line: "light-dark(rgba(46,31,22,.09), rgba(185,197,216,.22))",
  muted: "light-dark(rgba(46,31,22,.55), color-mix(in srgb, #edf0f7 55%, transparent))",
};
const UI = "Inter, system-ui, -apple-system, sans-serif";
const UNDO_MS = 15000;

const CSS = `${BUNNY_CSS}
@keyframes org-pop { from { opacity: 0; transform: translateY(6px) scale(.98) } to { opacity: 1; transform: none } }
@keyframes org-spin { to { transform: rotate(360deg) } }
@keyframes org-glow { 0%,100% { box-shadow: 0 0 0 3px rgba(136,117,246,.35), 0 0 24px 6px rgba(136,117,246,.35) } 50% { box-shadow: 0 0 0 3px rgba(247,160,202,.5), 0 0 36px 12px rgba(255,159,122,.4) } }
@keyframes org-pulse { 0% { opacity: 0; transform: scale(.98) } 25% { opacity: 1 } 100% { opacity: 0; transform: scale(1.03) } }
@keyframes org-count { from { transform: scaleX(1) } to { transform: scaleX(0) } }
@keyframes org-breathe { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
.org-pop { animation: org-pop .16s ease-out; }
.org-ring { animation: org-spin 1.1s linear infinite; transform-origin: 50% 50%; }
.org-row:hover { background: light-dark(rgba(136,117,246,.07), color-mix(in srgb, hsl(249 45% 21%) 7%, transparent)); }
.org-kbd { font: 11px ${UI}; color: ${C.muted}; border: 1px solid ${C.line}; border-bottom-width: 2px; border-radius: 5px; padding: 0 5px; background: light-dark(#fff, var(--bunny-surface)); }
`;

// macOS screenshot-bar style scope icons.
const SCOPES: Array<{ kind: ScopeKind; label: string; icon: string }> = [
  { kind: "board", label: "Board", icon: "M3 4h18v16H3z M7 8h4v4H7z M13 8h4v4h-4z M7 14h4v2H7z" },
  { kind: "view", label: "View", icon: "M2 5h20v14H2z M2 8h20" },
  { kind: "selection", label: "Selection", icon: "M5 5h6v6H5z M13 13h6v6h-6z M11 11l2 2" },
  { kind: "area", label: "Area", icon: "M3 3h4M3 3v4M21 3h-4M21 3v4M3 21h4M3 21v-4M21 21h-4M21 21v-4" },
];

// Warm/cold, as the owner asked: show it rather than hide it.
const WARMTH: Record<BrainState, { color: string; label: string; pulse: boolean }> = {
  warm: { color: C.done, label: "Warm · answers in a few seconds", pulse: false },
  warming: { color: "light-dark(#FFC65A, hsl(39 88% 74%))", label: "Warming up · ready in a few seconds", pulse: true },
  starting: { color: "light-dark(#FFC65A, hsl(39 88% 74%))", label: "Starting up · first answer is slower", pulse: true },
  cold: { color: "light-dark(rgba(46,31,22,.3), color-mix(in srgb, #edf0f7 55%, transparent))", label: "Cold · opens when you start typing", pulse: false },
};
const dot = (r: Run) => (r.status === "queued" ? C.starting : r.status === "working" ? C.working : r.status === "error" ? C.needs : r.undone ? C.lavender : C.done);
const said = (r: Run) => (r.status === "queued" ? "Waiting" : r.status === "working" ? "Working" : r.undone ? "Undone" : (r.summary ?? (r.status === "error" ? "Something went wrong." : "Done.")));

// Follow the camera so page-space overlays stay glued to the board.
function useCamera(editor: Editor) {
  const [, tick] = useState(0);
  useEffect(() => editor.store.listen(() => tick((n) => n + 1), { scope: "session" }), [editor]);
}

function pageRectToScreen(editor: Editor, r: Rect) {
  const a = editor.pageToScreen({ x: r.x, y: r.y });
  const b = editor.pageToScreen({ x: r.x + r.w, y: r.y + r.h });
  const c = editor.getContainer().getBoundingClientRect();
  return { left: a.x - c.left, top: a.y - c.top, width: b.x - a.x, height: b.y - a.y };
}

// The part of the board a running request is about glows (Notion AI / Figma AI style).
function WorkingGlow({ editor, rects }: { editor: Editor; rects: Rect[] }) {
  useCamera(editor);
  return (
    <>
      {rects.map((r, i) => (
        <div key={i} data-testid="organizer-glow" style={{ position: "absolute", ...pageRectToScreen(editor, r), borderRadius: 10, border: `2px solid ${C.violet}`, animation: "org-glow 1.6s ease-in-out infinite", pointerEvents: "none" }}>
          <span style={{ position: "absolute", top: -26, right: 0, display: "flex", alignItems: "center", gap: 5, background: C.violet, color: "#fff", font: `600 11px ${UI}`, borderRadius: 999, padding: "2px 9px 2px 4px", whiteSpace: "nowrap" }}>
            <BunnyMark size={16} mood="working" /> Bunny is working
          </span>
        </div>
      ))}
    </>
  );
}

// What a finished request changed pulses once.
function ChangedPulse({ editor, ids }: { editor: Editor; ids: string[] }) {
  useCamera(editor);
  const boxes = ids.map((id) => editor.getShapePageBounds(id as TLShapeId)).filter((b): b is NonNullable<typeof b> => !!b);
  return (
    <>
      {boxes.map((b, i) => (
        <div key={i} data-testid="organizer-pulse" style={{ position: "absolute", ...pageRectToScreen(editor, { x: b.x - 6, y: b.y - 6, w: b.w + 12, h: b.h + 12 }), border: `2px solid ${C.violet}`, borderRadius: 10, background: "light-dark(rgba(200,180,248,.12), color-mix(in srgb, hsl(258 45% 21%) 12%, transparent))", animation: "org-pulse 1.4s ease-out forwards", pointerEvents: "none", zIndex: 1140 }} />
      ))}
    </>
  );
}

// Agents a request messaged: name, live status from the frame, and Show (select + zoom,
// which opens the frame's sidebar where the reply appears).
const AGENT_STATUS: Record<string, { label: string; color: string; busy: boolean }> = {
  requested: { label: "starting", color: C.starting, busy: true },
  running: { label: "working", color: C.working, busy: true },
  "needs-permission": { label: "needs you", color: C.needs, busy: true },
  idle: { label: "done, reply in its frame", color: C.done, busy: false },
  error: { label: "error", color: C.needs, busy: false },
  archived: { label: "archived", color: C.lavender, busy: false },
};
// Agents seen working since a request messaged them: until then an "idle" frame means the
// message has not been picked up yet, not that the agent is done.
const SEEN_WORKING = new Set<string>();
const PICKUP_MS = 20000;
function agentState(editor: Editor, id: string, sentAt?: number | null) {
  const f = editor.getShape(id as TLShapeId);
  const st = (f?.meta as { paseo?: { status?: string } } | undefined)?.paseo?.status ?? "idle";
  if (st === "running" || st === "requested" || st === "needs-permission") SEEN_WORKING.add(id);
  const name = (f?.props as { name?: string } | undefined)?.name || "a frame";
  if (st === "idle" && !SEEN_WORKING.has(id) && sentAt && Date.now() - sentAt < PICKUP_MS) return { name, label: "delivered, starting…", color: C.starting, busy: true, exists: !!f };
  return { name, ...(AGENT_STATUS[st] ?? AGENT_STATUS.idle), exists: !!f };
}
function PromptedAgents({ editor, ids, sentAt }: { editor: Editor; ids: string[]; sentAt?: number | null }) {
  const [, tick] = useState(0);
  useEffect(() => editor.store.listen(() => tick((n) => n + 1), { scope: "document" }), [editor]);
  // Re-check once the pick-up window has passed.
  useEffect(() => {
    const t = setTimeout(() => tick((n) => n + 1), PICKUP_MS + 200);
    return () => clearTimeout(t);
  }, [sentAt]);
  return (
    <div data-testid="organizer-prompted" style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
      {ids.map((id) => {
        const a = agentState(editor, id, sentAt);
        return (
          <div key={id} style={{ display: "flex", alignItems: "center", gap: 8, background: C.cream, borderRadius: 10, padding: "6px 8px" }}>
            <span style={{ width: 8, height: 8, borderRadius: 4, flex: "none", background: a.color, animation: a.busy ? "org-breathe 1.2s ease-in-out infinite" : undefined }} />
            <span style={{ flex: 1, minWidth: 0, fontSize: 12 }}>
              Sent to <b>{a.name}</b> · {a.label}
            </span>
            {a.exists ? (
              <button
                type="button"
                data-testid="organizer-show-agent"
                onClick={() => {
                  editor.select(id as TLShapeId);
                  editor.zoomToSelection({ animation: { duration: 300 } });
                }}
                style={{ flex: "none", background: "light-dark(rgba(136,117,246,.12), color-mix(in srgb, hsl(249 45% 21%) 12%, transparent))", border: 0, borderRadius: 999, color: C.violet, font: `600 12px ${UI}`, cursor: "pointer", padding: "2px 9px" }}
              >
                Show
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// Starting points when the input is empty, shaped by what is selected.
function suggestionsFor(editor: Editor): string[] {
  const sel = editor.getSelectedShapes();
  if (sel.length === 1 && sel[0].type === "frame") return ["Tidy this frame", "Put these stickies in one row", "Duplicate this frame", "Sort these stickies by priority"];
  if (sel.length > 1) return ["Line these up in a row", "Group these into a new frame", "Make these the same size"];
  return ["Tidy everything in view", "Line up the frames in one row", "Add a sticky note here", "What is on this board?"];
}

export function OrganizerPopover({ editor, boardId }: { editor: Editor; boardId: string }) {
  const mobile = useContext(MobileCtx);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [status, setStatus] = useState<Status | null>(null);
  const [bubble, setBubble] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [scope, setScope] = useState<ScopeKind>("view");
  const [area, setArea] = useState<Rect | null>(null);
  const [picking, setPicking] = useState(false);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [cursor, setCursor] = useState(0);
  const [regions, setRegions] = useState<Record<string, Rect>>({});
  const [pulse, setPulse] = useState<{ key: string; ids: string[] } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const seen = useRef<Record<string, Run["status"]>>({});
  const base = `/api/ui/boards/${encodeURIComponent(boardId)}/organizer`;
  const busy = !!status?.runs.some((r) => r.status === "queued" || r.status === "working");
  const working = status?.runs.filter((r) => r.status === "working") ?? [];
  const current = working[0] ?? status?.runs.find((r) => r.status === "queued") ?? null;
  const last = status?.run ?? null;
  const queued = status?.queued ?? 0;
  const suggestions = useMemo(() => (open && !text.trim() ? suggestionsFor(editor) : []), [open, text, editor]);

  const refresh = useCallback(async () => {
    const s = await api<Status>(base).catch(() => null);
    if (!s) return null;
    // A request that just finished: pulse what it changed. Only the runs the server still
    // reports are remembered, so this stays small over a long session.
    const next: Record<string, Run["status"]> = {};
    for (const r of s.runs) {
      const was = seen.current[r.id];
      if (was && was !== "done" && r.status === "done" && r.changedIds?.length) setPulse({ key: `${r.id}-${Date.now()}`, ids: r.changedIds });
      next[r.id] = r.status;
    }
    seen.current = next;
    setStatus(s);
    return s;
  }, [base]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!pulse) return;
    const t = setTimeout(() => setPulse(null), 1500);
    return () => clearTimeout(t);
  }, [pulse]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Not while a shape's text is being edited: the keys belong to the text there.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "p" && !editor.getEditingShapeId()) {
        e.preventDefault();
        e.stopPropagation();
        setOpen((o) => !o);
        setError(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [editor]);

  useEffect(() => {
    if (!open) return;
    setCursor(0);
    setTimeout(() => input.current?.focus(), 0);
    // A selection makes "Selection" the natural scope; otherwise keep the last choice.
    if (editor.getSelectedShapeIds().length) setScope((s) => (s === "area" && area ? s : "selection"));
    else setScope((s) => (s === "selection" ? "view" : s === "area" && !area ? "view" : s));
    // Start the shared organizer so the first answer does not wait for it.
    void api(`${base}/warm`, { method: "POST", body: "{}" }).catch(() => undefined);
  }, [open, base, editor, area]);

  // Poll while anything is queued or running, while the bar is open, or while warming up.
  const brain: BrainState = status?.brain ?? "cold";
  const settling = brain === "starting" || brain === "warming";
  useEffect(() => {
    if (!busy && !open && !settling) return;
    const t = setInterval(() => void refresh(), busy ? 600 : 1000);
    return () => clearInterval(t);
  }, [busy, open, settling, refresh]);

  // The live line's seconds counter.
  const [, setNow] = useState(0);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [busy]);

  // The answer stays up long enough to Undo, with a countdown bar; while an agent it
  // messaged is still working, it stays until that agent is done.
  const [, agentTick] = useState(0);
  useEffect(() => editor.store.listen(() => agentTick((n) => n + 1), { scope: "document" }), [editor]);
  const waitingOnAgent = !!last?.promptedIds?.some((id) => agentState(editor, id, last.finishedAt).busy);
  // Re-evaluate after the pick-up window, so an agent that never starts does not hold the bubble.
  useEffect(() => {
    if (!last?.promptedIds?.length) return;
    const t = setTimeout(() => agentTick((n) => n + 1), PICKUP_MS + 200);
    return () => clearTimeout(t);
  }, [last?.id, last?.promptedIds?.length]);
  useEffect(() => {
    if (!bubble || busy || waitingOnAgent) return;
    const t = setTimeout(() => setBubble(false), UNDO_MS);
    return () => clearTimeout(t);
  }, [bubble, busy, waitingOnAgent, last?.id, last?.status]);

  // The page rect a request is about, for the working glow.
  const regionFor = useCallback((): Rect | null => {
    if (scope === "area" && area) return area;
    if (scope === "selection") {
      const b = editor.getSelectionPageBounds();
      return b ? { x: b.x - 8, y: b.y - 8, w: b.w + 16, h: b.h + 16 } : null;
    }
    return null;
  }, [scope, area, editor]);

  const send = useCallback(
    async (raw: string) => {
      const t = raw.trim();
      // Never drop a request because the previous one is still being sent: each send is
      // independent, and the bar clears and closes at once.
      if (!t) return;
      setSending(true);
      setError(null);
      setText("");
      setOpen(false);
      try {
        const b = editor.getViewportPageBounds();
        const run = await api<Run>(base, {
          method: "POST",
          body: JSON.stringify({ text: t, viewport: { x: b.x, y: b.y, w: b.w, h: b.h }, selected: editor.getSelectedShapeIds(), scope, area: scope === "area" ? area : null, pageId: editor.getCurrentPageId() }),
        });
        const region = regionFor();
        if (region) setRegions((m) => ({ ...m, [run.id]: region }));
        seen.current[run.id] = run.status;
        setBubble(true);
        await refresh();
      } catch (e) {
        // Put the request back so it is not lost, and show why.
        setText(t);
        setOpen(true);
        // A board server older than the canvas has no organizer routes yet.
        const msg = (e as Error).message;
        setError(msg === "not found" ? "Bunny isn't running on this board server yet. It needs a board restart." : msg);
      } finally {
        setSending(false);
      }
    },
    [editor, base, refresh, scope, area, regionFor],
  );

  const undo = useCallback(
    async (runId: string) => {
      await api(`${base}/undo`, { method: "POST", body: JSON.stringify({ runId }) }).catch((e) => setError((e as Error).message));
      await refresh();
    },
    [base, refresh],
  );

  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();
  const mood: BunnyMood = current ? "working" : last?.status === "error" ? "error" : bubble && last?.status === "done" && !last.undone ? "done" : "idle";
  const ringColor = current ? C.working : last?.status === "error" ? C.needs : C.done;
  const glowRects = working.map((r) => regions[r.id]).filter((r): r is Rect => !!r);
  if (scope === "area" && area && open) glowRects.push(area);
  const scopeLabel = scope === "area" && area ? `Area ${Math.round(area.w)} × ${Math.round(area.h)}` : (SCOPES.find((x) => x.kind === scope)?.label ?? "View");

  return (
    <>
      <style>{CSS}</style>
      {/* Clipped to the canvas so the glow never spills under the sidebar. */}
      <div style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none", zIndex: 1140 }}>
        {glowRects.length ? <WorkingGlow editor={editor} rects={glowRects} /> : null}
        {pulse ? <ChangedPulse key={pulse.key} editor={editor} ids={pulse.ids} /> : null}
      </div>

      {open ? (
        <div
          data-testid="organizer-backdrop"
          onPointerDown={(e) => {
            stop(e);
            setOpen(false);
          }}
          style={{ position: "fixed", inset: 0, background: "light-dark(rgba(46,31,22,.10), color-mix(in srgb, hsl(23 35% 21%) 10%, transparent))", zIndex: 1200, pointerEvents: "all" }}
        >
          <div
            data-testid="organizer-popover"
            className="org-pop"
            onPointerDown={stop}
            onKeyDown={stop}
            style={{ position: "absolute", top: "16%", left: "50%", transform: "translateX(-50%)", width: "min(640px, 92vw)", background: "light-dark(#fff, var(--bunny-surface))", borderRadius: 16, boxShadow: "0 24px 64px rgba(46,31,22,.22), 0 0 0 1px rgba(46,31,22,.07)", font: `14px ${UI}`, color: C.espresso, overflow: "hidden" }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px 10px" }}>
              <BunnyMark size={28} mood={busy ? "working" : "idle"} />
              <span data-testid="organizer-scope-chip" title="What Bunny looks at" style={{ flex: "none", font: `600 12px ${UI}`, color: C.violet, background: "light-dark(rgba(136,117,246,.1), color-mix(in srgb, hsl(249 45% 21%) 10%, transparent))", borderRadius: 999, padding: "3px 9px" }}>
                {scopeLabel}
              </span>
              <input
                ref={input}
                data-testid="organizer-input"
                value={text}
                placeholder={busy ? "Ask for something else; it runs alongside" : "What should change?"}
                onChange={(e) => {
                  setText(e.target.value);
                  setCursor(0);
                }}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "ArrowDown" && suggestions.length) {
                    e.preventDefault();
                    setCursor((c) => (c + 1) % suggestions.length);
                  }
                  if (e.key === "ArrowUp" && suggestions.length) {
                    e.preventDefault();
                    setCursor((c) => (c - 1 + suggestions.length) % suggestions.length);
                  }
                  if (e.key === "Enter") void send(text.trim() ? text : (suggestions[cursor] ?? ""));
                  if (e.key === "Escape") setOpen(false);
                }}
                style={{ flex: 1, minWidth: 0, border: 0, outline: "none", font: `18px ${UI}`, color: C.espresso, background: "transparent" }}
              />
            </div>

            <div data-testid="organizer-scope" style={{ display: "flex", gap: 2, padding: "0 12px 10px" }}>
              {SCOPES.map((sc) => {
                const on = scope === sc.kind;
                const disabled = sc.kind === "selection" && !editor.getSelectedShapeIds().length;
                return (
                  <button
                    key={sc.kind}
                    type="button"
                    disabled={disabled}
                    data-testid={`organizer-scope-${sc.kind}`}
                    onClick={() => {
                      if (sc.kind === "area") {
                        setOpen(false);
                        setPicking(true);
                        return;
                      }
                      setScope(sc.kind);
                      input.current?.focus();
                    }}
                    style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", border: 0, borderRadius: 8, background: on ? "light-dark(rgba(136,117,246,.12), color-mix(in srgb, hsl(249 45% 21%) 12%, transparent))" : "transparent", color: disabled ? "light-dark(rgba(46,31,22,.25), color-mix(in srgb, #edf0f7 55%, transparent))" : on ? C.violet : C.muted, font: `500 12px ${UI}`, cursor: disabled ? "default" : "pointer" }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d={sc.icon} />
                    </svg>
                    {sc.label}
                  </button>
                );
              })}
            </div>

            {suggestions.length ? (
              <div data-testid="organizer-suggestions" style={{ borderTop: `1px solid ${C.line}`, padding: "6px 0" }}>
                <div style={{ font: `600 11px ${UI}`, color: C.muted, padding: "4px 18px", letterSpacing: ".04em", textTransform: "uppercase" }}>Try</div>
                {suggestions.map((sg, i) => (
                  <div
                    key={sg}
                    className="org-row"
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => void send(sg)}
                    style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 18px", cursor: "pointer", background: i === cursor ? "light-dark(rgba(136,117,246,.1), color-mix(in srgb, hsl(249 45% 21%) 10%, transparent))" : undefined }}
                  >
                    <span style={{ color: C.violet }}>✦</span>
                    <span style={{ flex: 1 }}>{sg}</span>
                    {i === cursor ? <span className="org-kbd">↵</span> : null}
                  </div>
                ))}
              </div>
            ) : null}

            {status?.runs.length ? (
              <div data-testid="organizer-history" style={{ borderTop: `1px solid ${C.line}`, padding: "6px 0", maxHeight: 220, overflowY: "auto" }}>
                <div style={{ font: `600 11px ${UI}`, color: C.muted, padding: "4px 18px", letterSpacing: ".04em", textTransform: "uppercase" }}>Recent</div>
                {[...status.runs].reverse().slice(0, 6).map((r) => (
                  <div key={r.id} style={{ display: "flex", gap: 10, padding: "6px 18px", alignItems: "baseline", fontSize: 13 }}>
                    <span style={{ flex: "none", width: 8, height: 8, borderRadius: 4, background: dot(r), transform: "translateY(-1px)" }} />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontWeight: 600 }}>{r.text}</span>
                      <span style={{ color: C.muted }}>
                        {" · "}
                        {said(r)}
                        {r.status === "done" && r.seconds !== null ? ` · ${r.seconds}s` : ""}
                      </span>
                    </span>
                    {r.status === "done" && !r.undone && r.moved ? (
                      <button type="button" onClick={() => void undo(r.id)} style={{ flex: "none", background: "none", border: 0, color: C.violet, font: `600 12px ${UI}`, cursor: "pointer", padding: 0 }}>
                        Undo
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "8px 16px", background: C.cream, borderTop: `1px solid ${C.line}`, fontSize: 12, color: C.muted }}>
              <span data-testid="organizer-warmth" data-state={brain} style={{ display: "flex", alignItems: "center", gap: 7 }}>
                {error ? (
                  <span style={{ color: C.needs }}>{error}</span>
                ) : (
                  <>
                    <span style={{ width: 8, height: 8, borderRadius: 4, background: WARMTH[brain].color, animation: WARMTH[brain].pulse ? "org-breathe 1.2s ease-in-out infinite" : undefined }} />
                    {sending ? "Sending…" : WARMTH[brain].label}
                  </>
                )}
              </span>
              <span style={{ display: "flex", gap: 8, alignItems: "center", whiteSpace: "nowrap" }}>
                <span className="org-kbd">↵</span> run <span className="org-kbd">↑↓</span> pick <span className="org-kbd">esc</span> close
              </span>
            </div>
          </div>
        </div>
      ) : null}

      {picking ? (
        <div
          data-testid="organizer-area-picker"
          onPointerDown={(e) => {
            stop(e);
            setDrag({ x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY });
          }}
          onPointerMove={(e) => drag && setDrag({ ...drag, x1: e.clientX, y1: e.clientY })}
          onPointerUp={() => {
            if (drag && Math.abs(drag.x1 - drag.x0) > 8 && Math.abs(drag.y1 - drag.y0) > 8) {
              const a = editor.screenToPage({ x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1) });
              const b = editor.screenToPage({ x: Math.max(drag.x0, drag.x1), y: Math.max(drag.y0, drag.y1) });
              setArea({ x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y });
              setScope("area");
            }
            setDrag(null);
            setPicking(false);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setPicking(false);
              setOpen(true);
            }
          }}
          tabIndex={-1}
          ref={(el) => el?.focus()}
          style={{ position: "fixed", inset: 0, zIndex: 1250, cursor: "crosshair", background: "light-dark(rgba(46,31,22,.14), color-mix(in srgb, hsl(23 35% 21%) 14%, transparent))", outline: "none" }}
        >
          <div style={{ position: "absolute", top: 16, left: "50%", transform: "translateX(-50%)", background: C.espresso, color: C.cream, padding: "7px 14px", borderRadius: 999, font: `13px ${UI}`, display: "flex", gap: 8, alignItems: "center" }}>
            <BunnyMark size={18} /> Drag over the part of the board Bunny should work on · esc cancels
          </div>
          {drag ? (
            <div style={{ position: "absolute", left: Math.min(drag.x0, drag.x1), top: Math.min(drag.y0, drag.y1), width: Math.abs(drag.x1 - drag.x0), height: Math.abs(drag.y1 - drag.y0), border: `2px solid ${C.violet}`, background: "light-dark(rgba(136,117,246,.08), color-mix(in srgb, hsl(249 45% 21%) 8%, transparent))", borderRadius: 6 }}>
              <span style={{ position: "absolute", right: 0, bottom: -24, font: `11px ${UI}`, color: C.cream, background: C.espresso, borderRadius: 5, padding: "2px 6px" }}>
                {Math.abs(drag.x1 - drag.x0)} × {Math.abs(drag.y1 - drag.y0)}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* The answer sits above the bunny in the right-hand corner, clear of the bottom toolbar
          and the pinned-frames dock (it used to sit beside the bunny and cover both). */}
      <div data-testid="organizer-corner" onPointerDown={stop} style={{ position: "absolute", right: 16, bottom: 52, zIndex: 1150, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 10, pointerEvents: "none", font: `14px ${UI}` }}>
        {bubble && (current || last) ? (
          <div
            data-testid="organizer-toast"
            className="org-pop"
            style={{ pointerEvents: "all", position: "relative", marginBottom: 8, background: "light-dark(#fff, var(--bunny-surface))", color: C.espresso, padding: "11px 14px 13px", borderRadius: 14, boxShadow: "0 10px 30px rgba(46,31,22,.16), 0 0 0 1px rgba(46,31,22,.07)", width: 290, maxWidth: "calc(100vw - 40px)", fontSize: 13, overflow: "hidden" }}
          >
            <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
              <span style={{ flex: "none", width: 8, height: 8, borderRadius: 4, marginTop: 5, background: current ? C.working : last ? dot(last) : C.done }} />
              <span style={{ flex: 1, lineHeight: 1.4 }}>
                {current ? (
                  <>
                    <b>On it:</b> {working.length > 1 ? `${working.length} requests` : current.text}
                    {queued - (current.status === "queued" ? 1 : 0) > 0 ? <span data-testid="organizer-queue" style={{ color: C.muted }}> · {queued - (current.status === "queued" ? 1 : 0)} waiting</span> : null}
                    <span data-testid="organizer-phase" style={{ display: "block", color: C.muted, fontSize: 12, marginTop: 2 }}>
                      {current.status === "queued" ? "Waiting for a free slot" : (current.phase ?? "Starting")}
                      {current.at ? ` · ${Math.max(0, Math.round((Date.now() - current.at) / 1000))}s` : ""}
                    </span>
                  </>
                ) : last ? (
                  <>
                    {said(last)}
                    {last.status === "done" && !last.undone && last.seconds !== null ? <span style={{ color: C.muted }}> · {last.seconds}s</span> : null}
                    {last.status === "done" && last.promptedIds?.length ? <PromptedAgents editor={editor} ids={last.promptedIds} sentAt={last.finishedAt} /> : null}
                  </>
                ) : null}
              </span>
              {!current && last?.status === "done" && !last.undone && last.moved ? (
                <button type="button" data-testid="organizer-undo" onClick={() => void undo(last.id)} style={{ flex: "none", background: "light-dark(rgba(136,117,246,.12), color-mix(in srgb, hsl(249 45% 21%) 12%, transparent))", border: 0, borderRadius: 999, color: C.violet, font: `600 12px ${UI}`, cursor: "pointer", padding: "3px 10px" }}>
                  Undo
                </button>
              ) : null}
              <button type="button" aria-label="Dismiss" onClick={() => setBubble(false)} style={{ flex: "none", background: "none", border: 0, color: C.muted, cursor: "pointer", padding: 0, font: "inherit" }}>
                ✕
              </button>
            </div>
            {!current && last?.status === "done" && !last.undone && !waitingOnAgent ? <span key={last.id} style={{ position: "absolute", left: 0, bottom: 0, height: 3, width: "100%", background: `linear-gradient(90deg, ${C.violet}, #F7A0CA, #FF9F7A)`, transformOrigin: "left", animation: `org-count ${UNDO_MS}ms linear forwards` }} /> : null}
          </div>
        ) : null}
        <button
          type="button"
          data-testid="organizer-bunny"
          title={`Bunny (⌘⇧P) · ${WARMTH[brain].label}`}
          onClick={() => {
            // Phone shell: Bunny opens Tell Bunny (route a bug or screenshot to an agent).
            if (mobile) return openTellBunny();
            if (last && !bubble) setBubble(true);
            else setOpen(true);
          }}
          style={{ pointerEvents: "all", position: "relative", width: 58, height: 58, borderRadius: 29, border: 0, padding: 0, cursor: "pointer", background: C.cream, boxShadow: "0 8px 22px rgba(46,31,22,.18), 0 0 0 1px rgba(46,31,22,.06)", display: "grid", placeItems: "center" }}
        >
          <BunnyMark size={54} mood={mood} />
          {current ? (
            <svg className="org-ring" width="66" height="66" viewBox="0 0 66 66" style={{ position: "absolute", left: -4, top: -4 }} aria-hidden="true">
              <circle cx="33" cy="33" r="31" fill="none" stroke={ringColor} strokeWidth="3" strokeDasharray="60 135" strokeLinecap="round" />
            </svg>
          ) : null}
          <span data-testid="organizer-launcher-warmth" style={{ position: "absolute", right: 2, bottom: 2, width: 10, height: 10, borderRadius: 5, background: WARMTH[brain].color, boxShadow: "0 0 0 2px " + C.cream, animation: WARMTH[brain].pulse ? "org-breathe 1.2s ease-in-out infinite" : undefined }} />
          {queued ? (
            <span style={{ position: "absolute", top: -4, right: -4, minWidth: 18, height: 18, borderRadius: 9, background: C.orange, color: "#fff", font: `700 11px ${UI}`, display: "grid", placeItems: "center", padding: "0 4px", boxShadow: "0 0 0 2px #fff" }}>{queued}</span>
          ) : null}
        </button>
      </div>
    </>
  );
}
