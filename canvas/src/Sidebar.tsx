import { AppIcon } from "./components/AppIcon";
import { startPending } from "../../shared/start-pending";
import { remoteStatusLabel } from "../../shared/remote-status";
import { PaseoLink, usePaseoLink } from "./PaseoLink";
import {TranscriptAvailability} from "./TranscriptAvailability";
import { HostConnectionBadge } from "./HostConnectionBadge";
import { Emoji } from "./Emoji";
import { useVisualViewport } from "./visualViewport";
import { useAgentCapabilities } from "./agentCapabilities";
import { RemoteCoverage } from "./RemoteCoverage";
import { MessageBody } from "./MessageBody";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createShapeId, type Editor, type TLFrameShape, type TLShapeId, useValue } from "tldraw";
import { primerLabel } from "../../shared/components/transcript";
import { StatusMark } from "./Dot";
import { agentStore, displayStatus, STATUS_DOT, statusLabel, subagentCount, useAgentView, usePageVisible } from "./agents";
import { FrameUploadReceipts } from "./frameUploads";
import { ExactRow, type HistoryRow, useTimelineHistory } from "./TimelineHistory";
import { boardLocks } from "./locks";
import { ChecklistDragSource, LinkDragSource, TranscriptDragSource } from "./components/registry";
import { ChatComposer, useLastSend } from "./ChatComposer";
import { TurnControls } from "./TurnControls";
import { agentHost, composerMaxHeight, threadSheet } from "./mobile/mobileMode";
import { EditAgentSheet, MessageMenu, renameFrame, startBeside, TitleEdit, useLongPress } from "./mobile/ThreadTools";
import { askReveal } from "./mobile/Reveal";
import { besideFrame } from "./mobile/placement";
import { startRequested } from "./FramePanel";
import { StopButton, useStopped } from "./mobile/StopButton";
import { snapSheet, upVelocity, useVerticalDrag } from "./mobile/sheetDrag";
import { infoNow } from "./info";
import { sendPhotosToFrame } from "./fileDrop";
import { useAgentMeta } from "./agentMeta";
import { hasItemView, stop, TimelineItemView, ToolGroupView } from "./TimelineItemView";
import { dedupeItemRows, groupRows, rowKey } from "./timelineItems";
import { useAgentControls } from "./useAgentControls";
import { AgentControlsBar, AgentLiveStats } from "./AgentControlsBar";
import { PermissionCards } from "./PermissionCards";
import { installNativeCopy, NATIVE_COPY_ATTR } from "./nativeCopy";
import { LastSentStrip, scrollToRow } from "./LastSentStrip";
import { chooseLastSent, useAgentSummary } from "./lastSent";
import { humanMessages, lastHumanMessage } from "../../shared/last-message";

const iconBtn: React.CSSProperties = { display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0, border: "none", background: "transparent", cursor: "pointer", font: "16px system-ui", color: "light-dark(#475569, var(--bunny-muted))", padding: "2px 6px", borderRadius: 6, minWidth: 30, minHeight: 30 };
const chip: React.CSSProperties = { display: "inline-block", padding: "1px 6px", borderRadius: 999, fontSize: 11, background: "light-dark(#f1f5f9, var(--bunny-raised))", color: "light-dark(#475569, var(--bunny-muted))" };

// Desktop "+ New agent": an empty frame beside this one, selected and in view, its panel open
// on the start form (FramePanel's startRequested). The phone uses its start sheet instead.
function newAgentBeside(editor: Editor, frameId: string): boolean {
  const b = editor.getShapePageBounds(frameId as TLShapeId);
  const page = editor.getAncestorPageId(frameId as TLShapeId);
  if (!b || !page) return false;
  const others = [...editor.getPageShapeIds(page)].flatMap((id) => (editor.getShape(id)?.type === "frame" ? (editor.getShapePageBounds(id) ?? []) : []));
  const at = besideFrame(b, others);
  const id = createShapeId();
  editor.createShape({ id, type: "frame", parentId: page, x: at.x, y: at.y, props: { w: 960, h: 640, name: "New agent" } });
  startRequested.add(id);
  editor.select(id);
  editor.zoomToBounds({ x: at.x, y: at.y, w: 960, h: 640 }, { animation: { duration: 300 }, inset: 80 });
  return true;
}

// Right-hand sidebar for a bound frame, laid out like Paseo's chat: a one-line header
// (agent, model, machine, status), the conversation, and the reply box at the bottom.
// Drag handles and links live in the ⋯ menu. Live data comes from the shared agent
// store (one event stream per page, see agents.ts).
// On phones (sheet) it is a bottom sheet: drag the handle (or tap it) between a peek,
// half and nearly full height; the board stays usable above it.
const SHEET_STOPS = [0.24, 0.55, 0.9];
// Phone shell: peek (header and reply box), half, full; in landscape (the right-hand side) half and full.
const PHONE_STOPS = [0.34, 0.6, 0.94];
const PHONE_WIDE_STOPS = [0.6, 0.98];

export function Sidebar({ editor, frameId, boardId, onClose, onArchive, sheet = false, mobile = false, reading = false, onReadingChange }: { editor: Editor; frameId: string; boardId: string; onClose: () => void; onArchive?: (frameId: string) => void; sheet?: boolean; mobile?: boolean; reading?: boolean; onReadingChange?: (reading: boolean) => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const readingButton = useRef<HTMLButtonElement>(null);
  const wideReading = reading && !sheet && !mobile;
  useEffect(() => {
    if (!wideReading || !onReadingChange) return;
    const exit = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      onReadingChange(false);
      requestAnimationFrame(() => readingButton.current?.focus());
    };
    window.addEventListener('keydown', exit, true);
    return () => window.removeEventListener('keydown', exit, true);
  }, [wideReading, onReadingChange]);
  const [approving, setApproving] = useState(false);
  const viewport = useVisualViewport();
  // Phone shell: the sheet is full width in both orientations. (It once took the right-hand
  // 58% in landscape, judged from the visible viewport's shape, which the keyboard changes:
  // a portrait phone with the keyboard up got a sheet shoved into the right half.)
  const wideSheet = false;
  const [sheetRatio, setSheetRatio] = useState(wideSheet ? SHEET_STOPS[2] : SHEET_STOPS[1]);
  const sheetH = Math.min(viewport.height * 0.92, Math.max(180, viewport.height * sheetRatio));
  // Phone shell: the sheet's stops (peek, half, full) and, while a finger drags it, its live
  // height. With the keyboard up it fills the visible viewport, so the reply box sits right
  // above the keyboard and the thread keeps the rest (mobileMode.ts threadSheet).
  const phoneStops = (wideSheet ? PHONE_WIDE_STOPS : PHONE_STOPS).map((f) => Math.round(viewport.height * f));
  // Opens at the tallest stop: the conversation is what you came for (drag down for the frame).
  const [phoneStop, setPhoneStop] = useState(wideSheet ? PHONE_WIDE_STOPS.length - 1 : PHONE_STOPS.length - 1);
  const [dragH, setDragH] = useState<number | null>(null);
  const phoneSheet = sheet && mobile ? threadSheet({ height: viewport.height, top: viewport.top, innerHeight: document.documentElement.clientHeight || window.innerHeight }, (dragH ?? phoneStops[Math.min(phoneStop, phoneStops.length - 1)]) / viewport.height) : null;
  const dragBase = useRef(0);
  const dragMove = (up: number) => {
    if (dragH === null) {
      dragBase.current = phoneSheet?.height ?? 0;
      (document.activeElement as HTMLElement | null)?.blur?.();
    }
    setDragH(Math.max(100, Math.min(viewport.height, (dragH === null ? (phoneSheet?.height ?? 0) : dragBase.current) + up)));
  };
  const dragEnd = (up: number, velocity: number) => {
    const h = Math.max(100, Math.min(viewport.height, dragBase.current + up));
    const snap = snapSheet(h, velocity, phoneStops, phoneStops[0] * 0.7);
    setDragH(null);
    if (snap.kind === "close") onClose();
    else setPhoneStop(snap.index);
  };
  const sheetDrag = useVerticalDrag(dragMove, dragEnd);
  const setSheetH = (height: number) => setSheetRatio(height / viewport.height);
  const drag = useRef<{ y: number; h: number; moved: boolean } | null>(null);
  const frame = useValue("sidebar-frame", () => editor.getShape(frameId as TLShapeId) as TLFrameShape | undefined, [editor, frameId]);
  // biome-ignore lint/suspicious/noExplicitAny: meta JSON.
  const paseo = ((frame?.meta as any)?.paseo ?? {}) as Record<string, any>;
  const agentId: string | undefined = paseo.agentId;
  const visible=usePageVisible();
  const view = useAgentView(agentId,visible);
  useEffect(()=>{if(agentId)agentStore.prefetch(agentId,true);},[agentId]);
  // Until the capability check answers (a slow board server), a bound frame's reply box
  // stays usable: the prompt route itself refuses an agent that is no longer bound.
  const pendingStart = startPending(paseo);
  const capabilities = useAgentCapabilities(visible?agentId:undefined, `${frameId}:${paseo.host ?? "local"}`, pendingStart);
  const [err, setErr] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const history = useTimelineHistory(agentId, historyOpen, capabilities.can("olderTimeline"));
  const [primerOpen, setPrimerOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  // Phone: rename in the header, the Edit agent settings sheet, a message's long-press menu.
  const [editingTitle, setEditingTitle] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [msgMenu, setMsgMenu] = useState<{ at: { x: number; y: number }; text: string } | null>(null);
  const titlePress = useLongPress(() => setEditingTitle(true), mobile);
  const paused = useValue("sidebar-paused", () => boardLocks(editor).get().agentsPaused, [editor]);
  const remoteHost: string | null = paseo.host ?? view?.remote?.host ?? null;
  const paseoLink = usePaseoLink({ agentId, remoteHost, snapshotUrl: view?.paseoUrl, capabilities: capabilities.value });
  const [, tick] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const status = agentId ? displayStatus(view, paseo.boundAt, paseo.status, paseo.subagents, paseo.cloudSessions, paseo.host, pendingStart) : paseo.request ? "starting" : "unbound";
  const meta = useAgentMeta(agentId, remoteHost, !!view && view.status !== "missing" && !view.availability);
  const live = view?.rows ?? [];
  // Earlier messages: the history snapshot, then any live rows newer than its last row.
  const snapshot = historyOpen ? history.page?.rows ?? null : null;
  const lastSnap = snapshot?.at(-1)?.at;
  const rows: HistoryRow[] = dedupeItemRows(snapshot ? [...snapshot, ...live.filter((r) => !lastSnap || r.at > lastSnap)] : live);
  // Consecutive tool calls fold into one "Edited 3 files, ran 2 commands" badge.
  const units = groupRows(rows, status === "running");
  // "You: …" under the header: the last message the person sent (LastSentStrip.tsx).
  const lastFromRows = useMemo(() => lastHumanMessage(rows), [rows]);
  const composerSent = useLastSend(agentId ?? "", view, status);
  const lastSummary = useAgentSummary(agentId ?? "", !!agentId && !lastFromRows);
  const lastSent = agentId ? chooseLastSent(lastFromRows, composerSent ? { text: composerSent.text, at: composerSent.at } : null, lastSummary?.lastUserMessage) : null;
  const lastFull = lastSent ? (lastSent.inRows && lastFromRows ? rows[lastFromRows.index]?.text || lastSent.text : (lastSent.full ?? lastSent.text)) : "";
  // A tap on the strip: scroll to the message; older than what is loaded: open earlier
  // messages, a page at a time, until it is there.
  const [seekAt, setSeekAt] = useState<string | null>(null);
  const goToRow = (at: string) => {
    if (scrollToRow(listRef.current, at)) return;
    setSeekAt(at);
    if (!historyOpen) setHistoryOpen(true);
  };
  const goToLast = () => {
    if (lastSent) goToRow(lastSent.at);
  };
  // Phone: hold "You: …" for all of them (loaded so far), to jump to one.
  const mine = useMemo(() => (mobile ? humanMessages(rows).map(({ text, at }) => ({ text, at })) : []), [rows, mobile]);
  useEffect(() => {
    if (!seekAt) return;
    if (scrollToRow(listRef.current, seekAt)) return setSeekAt(null);
    if (!historyOpen || history.busy) return;
    if (history.page?.hasOlder && history.page.nextCursor && capabilities.can("olderTimeline")) void history.load(true);
    else setSeekAt(null);
  });
  // Model/mode/thinking/features and pending permissions (local agents only).
  const nativeControls = !remoteHost || capabilities.value?.source === "local-paseo";
  const controls = useAgentControls(agentId, status, visible && !!agentId && nativeControls && !!view && view.status !== "missing" && !view.availability);
  const pendingPermissions = controls.controls?.can.permissions ? controls.controls.pendingPermissions.length : 0;

  useEffect(() => {
    setHistoryOpen(false); setPrimerOpen(false); setErr(null); setMenu(false);
  }, [agentId]);

  useEffect(() => {
    if (status !== "starting") return;
    const t = setTimeout(() => tick((n) => n + 1), 5000);
    return () => clearTimeout(t);
  });

  // Stay at the newest message unless the reader scrolled up.
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [agentId, rows.length, rows.at(-1)?.text, rows.at(-1)?.item?.status, pendingPermissions]);
  // Phone: pulling down on the thread when it is already scrolled to the top drags the sheet
  // (a non-passive touch listener, so Safari does not rubber-band the list instead). Any
  // other touch scrolls the thread as usual.
  const dragRef = useRef({ dragMove, dragEnd });
  dragRef.current = { dragMove, dragEnd };
  const isPhoneSheet = !!phoneSheet;
  useEffect(() => {
    const el = listRef.current;
    if (!el || !isPhoneSheet) return;
    let start: { y: number; top: boolean; samples: { y: number; t: number }[]; dragging: boolean } | null = null;
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return void (start = null);
      start = { y: e.touches[0].clientY, top: el.scrollTop <= 0, samples: [{ y: e.touches[0].clientY, t: e.timeStamp }], dragging: false };
    };
    const onMove = (e: TouchEvent) => {
      if (!start || !start.top || e.touches.length !== 1) return;
      const y = e.touches[0].clientY;
      if (!start.dragging) {
        if (y - start.y < 6 || el.scrollTop > 0) return;
        start.dragging = true;
      }
      e.preventDefault();
      start.samples.push({ y, t: e.timeStamp });
      if (start.samples.length > 12) start.samples.shift();
      dragRef.current.dragMove(start.y - y);
    };
    const onEnd = (e: TouchEvent) => {
      const s0 = start;
      start = null;
      if (!s0?.dragging) return;
      const y = e.changedTouches[0]?.clientY ?? s0.samples.at(-1)!.y;
      s0.samples.push({ y, t: e.timeStamp });
      dragRef.current.dragEnd(s0.y - y, upVelocity(s0.samples));
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [isPhoneSheet]);
  // Cmd+C on selected conversation text copies that text, not the (selected) frame.
  useEffect(() => installNativeCopy(), []);
  // The list shrinks when the reply box grows or the keyboard opens: keep the newest message
  // in view instead of under the box.
  useEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => { if (pinned.current) el.scrollTop = el.scrollHeight; });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // While the start is pending, keep asking for the agent (the stream gives up on a
  // denied agent after a few tries otherwise).
  const retryView = pendingStart && !!agentId && (!view || !!view.denied || view.status === "missing");
  useEffect(() => {
    if (!retryView || !agentId) return;
    const timer = setInterval(() => agentStore.retryStarting(agentId), 4000);
    return () => clearInterval(timer);
  }, [retryView, agentId]);

  const busy = status === "running" || status === "needs-permission";
  // Phone: the turn that Stop cancels (not an idle parent whose subagents still run).
  const working = busy;
  const stoppedHere = useStopped(agentId, rows.length);
  // "agent not found" right after a bind is the agent still starting, not an error.
  // A start that failed says why (the frame's error), not the host's "Agent not found".
  const startFailed = paseo.status === "error" && typeof paseo.error === "string" && (!!paseo.request || (!!paseo.remoteStart && paseo.remoteStart.phase !== "complete"));
  const shownErr = err ?? (startFailed ? `Start failed: ${paseo.error}` : view?.error && !view.availability && status !== "starting" ? view.error : null);
  // Phone: the machine the agent runs on (its binding's host, else where the board's Paseo
  // daemon runs), as on the tiles; left out when unknown, never the board server's name.
  const machine = mobile ? agentHost(remoteHost ? { host: remoteHost } : paseo, (infoNow() as { agentMachine?: string | null } | null)?.agentMachine ?? null) : (meta.machine ?? "this Mac");
  const statusText = remoteStatusLabel(view?.remote ?? (remoteHost ? {host:remoteHost,polledAt:null} : undefined),statusLabel(status, subagentCount(view, paseo.subagents)), Date.now(), status === "starting" || (startFailed && status === "error"));
  const subline = agentId ? [controls.controls?.can.model && controls.controls.models.length ? null : meta.model, remoteHost ? null : machine, statusText].filter(Boolean).join(" · ") : paseo.request ? (machine ? `starting on ${machine}…` : "starting…") : "not bound";
  const canHistory = !!agentId && (capabilities.can("exactTimeline") || capabilities.can("olderTimeline"));
  const exact = !!agentId && capabilities.can("exactTimeline") && !!history.page?.capabilities?.exact;

  // An unbound frame owns the start form; an empty phone conversation would cover it.
  // (Phone: a start that failed keeps its thread open, saying why.)
  if(sheet && !agentId && !paseo.request && !(mobile && paseo.error))return null;

  return (
    <div
      ref={rootRef}
      data-testid="sidebar"
      {...{ [NATIVE_COPY_ATTR]: "" }}
      data-sheet={sheet ? "1" : "0"}
      data-reading={wideReading ? "1" : "0"}
      data-stop={phoneSheet ? (dragH !== null ? "dragging" : phoneSheet.keyboard ? "keyboard" : ["peek", "half", "full"][wideSheet ? phoneStop + 1 : phoneStop]) : undefined}
      onPointerDown={stop}
      onWheel={stop}
      style={{
        ...(sheet
          ? phoneSheet
            ? // Phone: placed against the visual viewport (never wider or taller than it), full
              // width in portrait, the right-hand side in landscape.
              { position: "fixed", left: wideSheet ? viewport.left + viewport.width - Math.min(560, viewport.width * 0.58) : viewport.left, width: wideSheet ? Math.min(560, viewport.width * 0.58) : viewport.width, top: phoneSheet.top, height: phoneSheet.height, maxHeight: viewport.height, boxSizing: "border-box", borderTop: "1px solid light-dark(#e2e8f0, var(--bunny-line))", borderRadius: phoneSheet.keyboard ? 0 : "14px 14px 0 0", boxShadow: "0 -6px 24px rgba(0,0,0,0.16)", paddingBottom: phoneSheet.keyboard ? 0 : "env(safe-area-inset-bottom)", overscrollBehavior: "contain", transition: dragH === null ? "height 160ms ease-out, top 160ms ease-out" : "none" }
            : { position: "fixed", left: 0, right: 0, top: viewport.top + viewport.height - sheetH, height: sheetH, boxSizing: "border-box", borderTop: "1px solid light-dark(#e2e8f0, var(--bunny-line))", borderRadius: "14px 14px 0 0", boxShadow: "0 -6px 24px rgba(0,0,0,0.16)", paddingBottom: "env(safe-area-inset-bottom)", overscrollBehavior: "contain" }
          : { width: wideReading ? "calc(100vw - 320px)" : "min(420px, 45vw)", flexShrink: 0, borderLeft: "1px solid light-dark(#e2e8f0, var(--bunny-line))" }),
        background: "light-dark(#fff, var(--bunny-surface))",
        color: "light-dark(#0f172a, hsl(222 50% 74%))",
        pointerEvents: "all",
        display: "flex",
        flexDirection: "column",
        font: sheet ? "15px system-ui, sans-serif" : "13px system-ui, sans-serif",
        zIndex: 400,
      }}
    >
      {sheet && phoneSheet ? (
        // Phone: the grip follows the finger and snaps to peek / half / full (mobile/sheetDrag.ts).
        <div data-testid="sheet-handle" role="button" aria-label="Drag to resize or collapse the conversation" {...sheetDrag} style={{ ...sheetDrag.style, display: "flex", justifyContent: "center", padding: "6px 0 2px", cursor: "ns-resize", flexShrink: 0 }}>
          <span style={{ width: 40, height: 4, borderRadius: 3, background: "light-dark(#c4c4c4, var(--bunny-raised))" }} />
        </div>
      ) : sheet ? (
        <div
          data-testid="sheet-handle"
          role="button"
          aria-label="Resize the conversation panel"
          style={{ display: "flex", justifyContent: "center", padding: "8px 0 4px", touchAction: "none", userSelect: "none", WebkitUserSelect: "none", cursor: "ns-resize", flexShrink: 0 }}
          onPointerDown={(e) => {
            e.stopPropagation();
            e.preventDefault();
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            drag.current = { y: e.clientY, h: sheetH, moved: false };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            const dy = d.y - e.clientY;
            if (Math.abs(dy) > 4) d.moved = true;
            setSheetH(Math.max(120, Math.min(viewport.height * 0.92, d.h + dy)));
          }}
          onPointerCancel={() => { drag.current = null; }}
          onLostPointerCapture={() => { drag.current = null; }}
          onPointerUp={() => {
            const d = drag.current;
            drag.current = null;
            if (!d) return;
            const stops = SHEET_STOPS.map((f) => Math.round(viewport.height * f));
            if (!d?.moved) {
              // A tap steps through the sizes.
              const i = stops.findIndex((h) => h > sheetH + 10);
              setSheetH(stops[i === -1 ? 0 : i]);
              return;
            }
            setSheetH(stops.reduce((best, h) => (Math.abs(h - sheetH) < Math.abs(best - sheetH) ? h : best), stops[0]));
          }}
        >
          <span style={{ width: 44, height: 5, borderRadius: 3, background: "light-dark(#c4c4c4, var(--bunny-raised))" }} />
        </div>
      ) : null}

      {/* Phone: the connection line only when something is wrong (the header says the rest). */}
      {!mobile || view?.connection?.state !== "connected" ? <div style={{padding:"3px 12px",flexShrink:0}}><HostConnectionBadge view={view}/></div> : null}
      <header data-testid="sidebar-header" {...(phoneSheet ? { onPointerDown: sheetDrag.onPointerDown, onPointerMove: sheetDrag.onPointerMove, onPointerUp: sheetDrag.onPointerUp, onPointerCancel: sheetDrag.onPointerCancel } : {})} style={{ ...(phoneSheet ? { touchAction: "none" } : {}), flexShrink: 0, display: "flex", alignItems: mobile ? "center" : "flex-start", gap: mobile ? 4 : 8, padding: mobile ? "0 4px 0 14px" : "10px 8px 10px 14px", borderBottom: "1px solid light-dark(#e2e8f0, var(--bunny-line))" }}>
        {/* Phone: one line (dot, name, status); the agent controls live in the ⋯ menu. */}
        <div style={mobile ? { flex: 1, minWidth: 0, display: "flex", alignItems: "baseline", gap: 8 } : { flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0, flex: mobile ? "0 1 auto" : undefined }}>
            <StatusMark status={status} color={STATUS_DOT[status] ?? "light-dark(#ccc, var(--bunny-muted))"} />
            {mobile && editingTitle ? (
              <TitleEdit initial={frame?.props.name || view?.title || ""} save={(n) => { renameFrame(editor, frameId, n); setEditingTitle(false); }} cancel={() => setEditingTitle(false)} />
            ) : (
              // Phone: the frame's name first (a rename shows at once; Paseo's title follows),
              // and a long-press edits it.
              <div data-testid="sidebar-title" {...(mobile ? { ...titlePress, "data-no-drag": true, title: "Hold to rename" } : {})} style={{ fontWeight: 600, fontSize: sheet ? 16 : 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", ...(mobile ? { ...titlePress.style, userSelect: "none", WebkitUserSelect: "none" } : {}) }}>{(mobile ? frame?.props.name || view?.title : view?.title || frame?.props.name) || "Frame"}</div>
            )}
          </div>
          <div data-testid="sidebar-status" title={agentId ? `agent ${agentId} · ${paseo.mode ?? "live"} deltas` : undefined} style={{ fontSize: mobile ? 12 : 11, color: "light-dark(#64748b, var(--bunny-muted))", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flex: mobile ? "1 1 0" : undefined }}>
            {subline}
            {paseo.pendingDeltas ? ` · ${paseo.pendingDeltas} queued` : ""}
            {agentId && !remoteHost ? <AgentLiveStats view={view} status={status} /> : null}
          </div>
        </div>
        {/* Stop and Continue sit right above the reply box (TurnControls); on the phone Stop is
            the reply box's Send button while the agent works (StopButton). */}
        {!sheet && !mobile && onReadingChange ? <button ref={readingButton} type="button" data-testid="sidebar-reading-toggle" aria-label={wideReading ? "Exit reading view" : "Expand conversation"} aria-pressed={wideReading} title={wideReading ? "Back to canvas (Esc)" : "Expand conversation for reading"} onClick={() => onReadingChange(!wideReading)} style={{ ...iconBtn, fontSize: 13, whiteSpace: "nowrap" }}>{wideReading ? "↙ Back" : "⛶"}</button> : null}
        {/* One tap to a new agent beside this frame, without going back to the board first. */}
        <button type="button" data-testid="sidebar-new-agent" aria-label="New agent" title="New agent beside this one" style={iconBtn} onClick={() => (mobile ? void startBeside({ frameId, agentId, binding: paseo, frameName: frame?.props.name ?? "", boardId }) : newAgentBeside(editor, frameId))}>+</button>
        <div style={{ position: "relative" }}>
          <button type="button" data-testid="sidebar-menu" aria-label="More" aria-expanded={menu} style={{ ...iconBtn, ...(mobile ? { width: 40, height: 40 } : {}) }} onClick={() => setMenu((m) => !m)}><AppIcon name="more" size={20} /></button>
          {menu ? (
            <div role="menu" data-testid="sidebar-menu-panel" style={{ position: "absolute", right: 0, top: "calc(100% + 4px)", width: mobile ? "min(300px, calc(100vw - 24px))" : 260, maxHeight: mobile ? "60vh" : undefined, overflowY: mobile ? "auto" : undefined, background: "light-dark(#fff, var(--bunny-surface))", border: "1px solid light-dark(#e2e8f0, var(--bunny-line))", borderRadius: 10, boxShadow: "0 8px 24px rgba(15,23,42,0.14)", padding: 10, display: "flex", flexDirection: "column", gap: 8, zIndex: 2, fontSize: 12 }}>
              {!mobile ? <AgentControlsBar state={controls} /> : null}
              {agentId ? <PaseoLink link={paseoLink} testId="sidebar-open-paseo" style={{fontSize:12,color:"light-dark(#0f172a, hsl(222 50% 74%))"}} /> : null}
              {mobile ? (
                <>
                  <button type="button" className="bm-menu-action" data-testid="sidebar-edit-agent" onClick={() => { setMenu(false); setSettingsOpen(true); }}>
                    ✎ Edit agent settings
                  </button>
                  <button type="button" className="bm-menu-action" data-tone="primary" data-testid="sidebar-agent-here" onClick={() => { setMenu(false); void startBeside({ frameId, agentId, binding: paseo, frameName: frame?.props.name ?? "", boardId }); }}>
                    + Agent here
                  </button>
                  <button type="button" className="bm-menu-action" data-testid="sidebar-show-on-board" onClick={() => { setMenu(false); askReveal(frameId); }}>
                    ◎ Show on board
                  </button>
                </>
              ) : null}
              {agentId ? <TranscriptDragSource editor={editor} agentId={agentId} frameId={frameId} /> : null}
              {frame ? <LinkDragSource boardId={boardId} frameId={frameId} title={frame.props.name ?? ""} /> : null}
              <ChecklistDragSource editor={editor} frameId={frameId} enabled />
              {frame && onArchive ? <button type="button" data-testid="sidebar-archive" title="Take this frame and everything inside it off the board. Restore it from Board menu → Archive." onClick={() => { setMenu(false); onArchive(frameId); }} style={{ textAlign: "left", padding: "6px 8px", border: "1px solid light-dark(#e2e8f0, var(--bunny-line))", borderRadius: 8, background: "light-dark(#fff, var(--bunny-surface))", color: "light-dark(#0f172a, hsl(222 50% 74%))", font: "inherit", cursor: "pointer" }}><Emoji name="archive" /> Archive frame</button> : null}
              {agentId ? <div style={{ color: "light-dark(#94a3b8, var(--bunny-muted))", fontSize: 11 }}>agent {agentId} · {paseo.mode ?? "live"} deltas</div> : null}
            </div>
          ) : null}
        </div>
        {mobile ? <button type="button" data-testid="mobile-collapse" onClick={onClose} style={{ ...iconBtn, width: 40, height: 40 }} aria-label="Collapse the thread"><AppIcon name="chevron-down" size={20} /></button> : null}
        {mobile ? null : <button type="button" onClick={onClose} style={{...iconBtn,minWidth:36,minHeight:36}} aria-label="Collapse sidebar" title="Collapse sidebar; use the edge arrow to reopen"><AppIcon name="chevron-right" /></button>}
      </header>

      {lastSent ? <LastSentStrip text={lastSent.text} full={lastFull} mobile={mobile} onGo={goToLast} mine={mine} onJump={goToRow} /> : null}
      <TranscriptAvailability view={view}/>
      {/* Notices: only when they apply. */}
      {paused || remoteHost || (capabilities.error && !capabilities.value && !pendingStart) ? (
        <div style={{ flexShrink: 0, padding: "6px 14px", display: "flex", flexDirection: "column", gap: 4, fontSize: 11, borderBottom: "1px solid light-dark(#f1f5f9, var(--bunny-line))" }}>
          {paused ? <div data-testid="sidebar-paused" style={{ color: "light-dark(#c2410c, hsl(17 88% 74%))" }}>Agents are paused on this board: your edits queue up. Replies here still send.</div> : null}
          {remoteHost ? (
            <div data-testid="sidebar-remote" style={{ color: "light-dark(#7b5ea7, hsl(264 50% 74%))" }} title="This conversation remains on its selected host. Available controls reflect the connection to that host.">
              <RemoteCoverage view={view} host={remoteHost} starting={status === "starting"} />
              {paseo.lastReceipt ? ` · last delta ${paseo.lastReceipt.delivery === "accepted_by_paseo" ? "accepted" : paseo.lastReceipt.delivery}` : ""}
            </div>
          ) : null}
          {/* While the start is pending a refusal is "not created yet", not an error. */}
          {capabilities.error && !capabilities.value && !pendingStart ? <div role="alert" data-testid="capability-error" style={{ color: "light-dark(#b00020, hsl(349 88% 74%))" }}>Controls unavailable: {capabilities.error} <button type="button" onClick={capabilities.retry}>Retry</button></div> : null}
        </div>
      ) : null}

      <div
        ref={listRef}
        data-testid="sidebar-scroll-content"
        onScroll={(e) => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}
        style={{ flex: 1, minHeight: 0, overflowY: "auto", overscrollBehavior: "contain", padding: wideReading ? "16px max(24px, calc((100% - 1000px) / 2))" : "10px 14px", display: "flex", flexDirection: "column", gap: 10 }}
      >
        <FrameUploadReceipts boardId={boardId} frameId={frameId} compact={mobile} />
        {canHistory ? (
          <div style={{ textAlign: "center" }}>
            {!historyOpen ? (
              <button type="button" data-testid="load-history" style={{ ...chip, border: "none", cursor: "pointer" }} onClick={() => { pinned.current = false; setHistoryOpen(true); }}>Show earlier messages</button>
            ) : history.busy ? (
              <span role="status" style={chip}>Loading…</span>
            ) : history.error ? (
              <span role="alert" style={{ ...chip, color: "light-dark(#b00020, hsl(349 88% 74%))" }}>{history.error} <button type="button" onClick={() => void history.retry()}>Retry</button></span>
            ) : history.page?.hasOlder && history.page.nextCursor && capabilities.can("olderTimeline") ? (
              <button type="button" style={{ ...chip, border: "none", cursor: "pointer" }} onClick={() => void history.load(true)}>Show more</button>
            ) : (
              <span style={chip}>Beginning of available history</span>
            )}
            {history.notice ? <div role="status" style={{ fontSize: 11, color: "light-dark(#64748b, var(--bunny-muted))" }}>{history.notice}</div> : null}
          </div>
        ) : null}
        <div data-testid="timeline" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {rows.length === 0 ? <div style={{ color: "light-dark(#94a3b8, var(--bunny-muted))", textAlign: "center", padding: 20 }}>{status === "starting" ? `Starting on ${machine}…` : agentId ? "No messages yet." : mobile && paseo.error ? <span role="alert" data-testid="sidebar-start-error" style={{ color: "light-dark(#b00020, hsl(349 88% 74%))" }}>Start failed: {String(paseo.error)}</span> : "Waiting for the agent…"}</div> : null}
          {units.map((u, i) => {
            const renderRow = (r: HistoryRow) => <Row row={r} agentId={agentId} exact={exact} exactRoute={!!agentId && capabilities.can("exactTimeline")} onChanged={history.invalidate} primerOpen={primerOpen} togglePrimer={() => setPrimerOpen((x) => !x)} />;
            return u.kind === "group" ? <ToolGroupView key={`${agentId}:group:${u.id}`} unit={u} renderRow={renderRow} /> : mobile && u.row.text?.trim() && (u.row.kind === "user" || u.row.kind === "assistant") ? <MessagePress key={`${agentId}:${rowKey(u.row, i)}`} at={u.row.at} text={u.row.text} open={(at) => setMsgMenu({ at, text: u.row.text })}>{renderRow(u.row)}</MessagePress> : <div key={`${agentId}:${rowKey(u.row, i)}`} data-at={u.row.at} style={{ display: "contents" }}>{renderRow(u.row)}</div>;
          })}
          {mobile && stoppedHere ? <div data-testid="thread-stopped" role="status" style={{ alignSelf: "center", color: "light-dark(#7f1d1d, hsl(0 63% 74%))", fontSize: 13, fontWeight: 600, background: "light-dark(#fef2f2, var(--bunny-surface))", borderRadius: 999, padding: "4px 12px" }}>{working ? "Stopping…" : "■ Stopped"}</div> : null}
          {status === "running" ? <div data-testid="sidebar-working" style={{ color: "light-dark(#64748b, var(--bunny-muted))", fontSize: 12 }}>● Working…</div> : null}
          {status === "needs-permission" && !pendingPermissions ? <div role="alert" data-testid="permission-alert" style={{ color: "light-dark(#9c4b00, hsl(29 88% 74%))", fontWeight: 600 }}>{remoteHost ? "Last poll reported a permission request. Check the owning host." : "Permission needed: answer in Paseo before work can continue."}</div> : null}
        </div>
        {shownErr ? <div role="alert" style={{ color: "light-dark(#b00020, hsl(349 88% 74%))", fontSize: 12 }}>{shownErr}</div> : null}
      </div>

      {agentId && nativeControls ? <PermissionCards state={controls} paseoLink={paseoLink} /> : null}
      {mobile && settingsOpen ? <EditAgentSheet name={frame?.props.name || view?.title || ""} controls={controls.controls && !controls.unsupported ? <AgentControlsBar state={controls} /> : null} save={(n) => { renameFrame(editor, frameId, n); setSettingsOpen(false); }} close={() => setSettingsOpen(false)} /> : null}
      {mobile && msgMenu ? <MessageMenu at={msgMenu.at} text={msgMenu.text} close={() => setMsgMenu(null)} startAbout={() => void startBeside({ frameId, agentId, binding: paseo, frameName: frame?.props.name ?? "", boardId, quote: msgMenu.text })} /> : null}
      {mobile && agentId ? <MobileActions controls={controls} approving={approving} setApproving={setApproving} /> : null}
      {agentId ? (
        <ChatComposer agentId={agentId} view={view} status={status} canPrompt={capabilities.value ? capabilities.can("prompt") : !paseo.request} unavailable={capabilities.error} large={sheet || mobile} maxHeight={mobile ? composerMaxHeight(viewport.height) : undefined} attach={mobile && !remoteHost ? (files) => sendPhotosToFrame(editor, boardId, frameId, agentId, files) : undefined} busyAction={mobile && working ? <StopButton agentId={agentId} host={remoteHost} rows={rows.length} onError={setErr} /> : undefined} turnControls={<TurnControls agentId={agentId} host={remoteHost} status={status} rows={rows.length} canPrompt={capabilities.value ? capabilities.can("prompt") : !paseo.request} showStop={!mobile} large={mobile} onError={setErr} />} placeholder={mobile ? "Reply…" : `Reply to ${view?.title || frame?.props.name || "the agent"}…`} />
      ) : (
        <div style={{ flexShrink: 0, padding: 12, borderTop: "1px solid light-dark(#e2e8f0, var(--bunny-line))", color: "light-dark(#94a3b8, var(--bunny-muted))", fontSize: 12 }}>{paseo.request ? "The reply box opens when the agent has started." : "Not bound to an agent."}</div>
      )}
    </div>
  );
}

// One message, Paseo style: your messages as bubbles on the right, the agent's text
// plain, tools and board changes as one quiet line each.
function Row({ row: r, agentId, exact, exactRoute, onChanged, primerOpen, togglePrimer }: { row: HistoryRow; agentId?: string; exact: boolean; exactRoute: boolean; onChanged: () => void; primerOpen: boolean; togglePrimer: () => void }) {
  const exactRow = agentId && exact && typeof r.id === "string" ? <ExactRow agentId={agentId} row={r} onChanged={onChanged} /> : null;
  if (r.ack) return <div data-testid="sidebar-ack" data-kind={r.kind} style={{ color: "light-dark(#94a3b8, var(--bunny-muted))", fontSize: 11 }} title={`The agent acknowledged the change without replying ("${r.text}")`}><Emoji name="check" /> seen</div>;
  if (r.primer)
    return (
      <div data-testid="sidebar-primer" data-kind={r.kind} style={{ alignSelf: "flex-end", maxWidth: "88%", background: "light-dark(#f1f5f9, var(--bunny-raised))", borderRadius: 14, padding: "8px 12px", color: "light-dark(#475569, var(--bunny-muted))" }}>
        <span style={{ fontStyle: "italic" }}>{primerLabel(r)}</span>{" "}
        <button type="button" onClick={togglePrimer} style={{ border: "none", padding: 0, color: "light-dark(#2f80ed, hsl(214 84% 74%))", background: "none", cursor: "pointer", font: "inherit", fontSize: 12 }}>{primerOpen ? "hide" : "show what was sent"}</button>
        {primerOpen ? <div style={{ marginTop: 6, fontSize: 12, whiteSpace: "pre-wrap" }}>{r.full}</div> : null}
        {exactRow}
      </div>
    );
  // Rows with a Paseo timeline item render like Paseo's app (tool badges, reasoning, todos…).
  if (hasItemView(r)) return <TimelineItemView row={r} ctx={{ agentId, exact: exactRoute }} />;
  if (r.kind === "user")
    return (
      <div data-kind={r.kind} style={{ alignSelf: "flex-end", maxWidth: "88%", background: "light-dark(#eef4ff, var(--bunny-raised))", borderRadius: 14, padding: "8px 12px", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        {r.text}
        {exactRow}
      </div>
    );
  if (r.kind === "assistant")
    return (
      <div data-kind={r.kind} style={{ overflowWrap: "anywhere", lineHeight: 1.5 }}>
        <MessageBody text={r.text} />
        {r.text.length >= 4000 ? <div style={{ fontSize: 11, color: "light-dark(#94a3b8, var(--bunny-muted))" }}>Possibly truncated at the server limit.</div> : null}
        {exactRow}
      </div>
    );
  if (r.kind === "tool")
    return (
      <details data-kind={r.kind} style={{ color: "light-dark(#64748b, var(--bunny-muted))", fontSize: 12 }}>
        <summary style={{ cursor: "pointer", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontFamily: "ui-monospace, monospace" }}><Emoji name="gear" /> {r.text}{r.status && r.status !== "completed" ? ` · ${r.status}` : ""}</summary>
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: "4px 0 0" }}>{r.text}</pre>
        {exactRow ?? <div style={{ fontSize: 11 }}>Full arguments and output aren't available here.</div>}
      </details>
    );
  if (r.kind === "plugin:board-delta")
    return (
      <details data-kind={r.kind} style={{ alignSelf: "flex-end", maxWidth: "88%", fontSize: 12, color: "light-dark(#92400e, hsl(23 83% 74%))" }}>
        <summary style={{ cursor: "pointer", textAlign: "right" }}>Board change sent</summary>
        <div style={{ background: "light-dark(#fff8e6, hsl(43 45% 21%))", borderRadius: 10, padding: "6px 10px", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{r.text}</div>
        {exactRow}
      </details>
    );
  return <div data-kind={r.kind} style={{ color: r.kind === "error" ? "light-dark(#b00020, hsl(349 88% 74%))" : "light-dark(#64748b, var(--bunny-muted))", fontSize: 12, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{r.text}{exactRow}</div>;
}

// Phone shell (mobile/MobileShell.tsx): a thumb-sized Approve for the first pending
// permission that is not a question. The reply box below is the reply (no extra button).
function MobileActions({ controls, approving, setApproving }: { controls: ReturnType<typeof useAgentControls>; approving: boolean; setApproving: (v: boolean) => void }) {
  const c = controls.controls;
  const pending = c?.can.permissions ? c.pendingPermissions.find((p) => p.kind !== "question") : undefined;
  const allow = pending?.actions?.find((a) => a.behavior === "allow")?.id ?? "accept";
  if (!pending) return null;
  return (
    <div className="bm-actions" data-testid="mobile-thread-actions">
      {(
        <button
          type="button"
          className="bm-approve"
          data-testid="mobile-approve"
          disabled={approving || !!controls.busy}
          onClick={() => {
            setApproving(true);
            void controls.post(`permissions/${encodeURIComponent(pending.id)}`, { behavior: "allow", selectedActionId: allow }, "Allowed").finally(() => setApproving(false));
          }}
        >
          {approving ? "Approving…" : "Approve"}
        </button>
      )}
    </div>
  );
}

// Phone: a message that opens its menu (Start agent about this, Copy) on a long-press.
function MessagePress({ at, text, open, children }: { at?: string; text: string; open: (at: { x: number; y: number }) => void; children: React.ReactNode }) {
  const press = useLongPress(open);
  return (
    <div data-testid="thread-message" data-at={at} data-text-length={text.length} {...press} style={{ ...press.style, minWidth: 0, display: "flex", flexDirection: "column" }}>
      {children}
    </div>
  );
}
