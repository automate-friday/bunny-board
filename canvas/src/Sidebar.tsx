import { ChatOutline } from "./ChatOutline";
import { AppIcon } from "./components/AppIcon";
import { B, menuItem, UI_FONT } from "./bunnyTheme";
import { FrameMenuGroups } from "./FrameActions";
import { ChannelOfferStrip } from "./LinkChannels";
import { startPending } from "../../shared/start-pending";
import { remoteStatusLabel } from "../../shared/remote-status";
import { PaseoLink, usePaseoLink } from "./PaseoLink";
import {TranscriptAvailability} from "./TranscriptAvailability";
import { HostConnectionBadge } from "./HostConnectionBadge";
import { Emoji } from "./Emoji";
import { useVisualViewport } from "./visualViewport";
import { useAgentCapabilities } from "./agentCapabilities";
import { RemoteCoverage } from "./RemoteCoverage";
import { MessageBody, ResponseRawCtx, useResponseRaw } from "./MessageBody";
import { Fragment, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type Editor, type TLFrameShape, type TLShapeId, useValue } from "tldraw";
import { INTRO_ROW, primerLabel } from "../../shared/components/transcript";
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
import { setConversationFrame } from "./NewAgentButton";
import { askMove } from "./mobile/MoveSheet";
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
import { SidebarResizer } from "./SidebarResizer";
import { SIDEBAR_MIN } from "./sidebarMemory";
import { LastSentStrip, scrollToRow } from "./LastSentStrip";
import { chooseLastSent, useAgentSummary } from "./lastSent";
import { humanMessages, lastHumanMessage } from "../../shared/last-message";
import { takeHalfStop } from "./mobile/threadStop";
import { forkFromRow } from "./ForkFromHere";
import { RESPONSE_FOOTER_CSS, ResponseFooter, UserMessageActions } from "./ResponseFooter";
import { joinHistory, layoutResponses } from "./responseLayout";
import { anchorShift, createPaging, evaluate, failed, landed, type PagingStep, readingAnchor, rearm, retry, type RowBox, type ReadingAnchor, settle } from "./historyPaging";
import { forkableRow, forkedNotice } from "./forkPoint";
import { BoardUiCtx } from "./ui";

const iconBtn: React.CSSProperties = { display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0, border: "none", background: "transparent", cursor: "pointer", font: "16px system-ui", color: "light-dark(#475569, var(--bunny-muted))", padding: "2px 6px", borderRadius: 6, minWidth: 30, minHeight: 30 };

// The top slot of the conversation (scroll up to load earlier history): its keyboard button is
// out of sight until it has focus.
const PAGING_CSS = `
.bunny-load-earlier { height: 32px; padding: 0 12px; border: 0; border-radius: 999px; background: none; color: ${B.muted}; font: 12px ${UI_FONT}; cursor: pointer; }
.bunny-load-earlier:not(:focus) { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.bunny-load-earlier:focus-visible, .bunny-slot-retry:focus-visible { outline: 2px solid ${B.violet}; outline-offset: -2px; }
.bunny-slot-retry { height: 32px; padding: 0 6px; border: 0; border-radius: 999px; background: none; color: ${B.espresso}; font: 500 11px ${UI_FONT}; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
`;

// Where each conversation unit sits in the scroller's content (for the reading anchor).
function measureRows(el: HTMLElement): RowBox[] {
  const top = el.getBoundingClientRect().top - el.scrollTop;
  return [...el.querySelectorAll<HTMLElement>("[data-history-row-id]")].map((n) => {
    const r = n.getBoundingClientRect();
    return { id: n.dataset.historyRowId ?? "", top: r.top - top, height: r.height };
  });
}
const unitKey = (u: ReturnType<typeof groupRows<HistoryRow>>[number], i: number) => (u.kind === "group" ? `group:${u.id}` : rowKey(u.row, i));

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

// `embedded`: the same conversation in a frame peek's side pane (Portals.tsx); it fills its
// pane and leaves "+ New agent" and the main sidebar alone, and – hides the pane.
export function Sidebar({ editor, frameId, boardId, onClose, sheet = false, mobile = false, reading = false, onReadingChange, embedded = false, width = null, onWidthChange }: { editor: Editor; frameId: string; boardId: string; onClose: () => void; sheet?: boolean; mobile?: boolean; reading?: boolean; onReadingChange?: (reading: boolean) => void; embedded?: boolean; width?: number | null; onWidthChange?: (width: number | null) => void }) {
  // "+ New agent" (top-left bar) goes beside the conversation you are reading.
  useEffect(() => {
    if (embedded) return;
    setConversationFrame(frameId);
    return () => setConversationFrame(null);
  }, [frameId, embedded]);
  const rootRef = useRef<HTMLDivElement>(null);
  const readingButton = useRef<HTMLButtonElement>(null);
  const wideReading = reading && !sheet && !mobile;
  // Desktop: the left edge drags (SidebarResizer). dragW is the live width mid-drag; the
  // committed width comes from App (remembered per board), else the default.
  const [dragW, setDragW] = useState<number | null>(null);
  const resizable = !sheet && !mobile && !embedded && !!onWidthChange;
  const shownW = dragW ?? (wideReading ? null : width);
  const desktopWidth = shownW !== null ? `clamp(${SIDEBAR_MIN}px, ${shownW}px, calc(100vw - ${SIDEBAR_MIN}px))` : wideReading ? `calc(100vw - ${SIDEBAR_MIN}px)` : "min(420px, 45vw)";
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
  // Right after a start it opens at half, so the new frame shows above it (mobile/threadStop.ts).
  const [phoneStop, setPhoneStop] = useState(() => (wideSheet ? PHONE_WIDE_STOPS.length - 1 : takeHalfStop(frameId) ? 1 : PHONE_STOPS.length - 1));
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
  // Scroll up to load earlier history (historyPaging.ts): the reading row is noted right before
  // a page's rows are set, and put back where it was once they are laid out.
  const listRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const anchor = useRef<ReadingAnchor | null>(null);
  const canPage = !!agentId && capabilities.can("olderTimeline");
  const history = useTimelineHistory(agentId, canPage, () => {
    const el = listRef.current;
    anchor.current = el && !pinned.current ? readingAnchor(measureRows(el), el.scrollTop) : null;
  });
  const [primerOpen, setPrimerOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const menuPanel = useRef<HTMLDivElement>(null);
  const [menuHeight, setMenuHeight] = useState<number>();
  // The embedded pane can also be shorter than the viewport. Keep the end of the
  // menu reachable by scrolling inside it rather than clipping it at the pane edge.
  useLayoutEffect(() => {
    if (!menu) return;
    const root = rootRef.current;
    const panel = menuPanel.current;
    if (!root || !panel) return;
    const measure = () => setMenuHeight(Math.max(0, Math.min(root.getBoundingClientRect().bottom, viewport.top + viewport.height) - panel.getBoundingClientRect().top - 8));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    if (panel.offsetParent) observer.observe(panel.offsetParent);
    return () => observer.disconnect();
  }, [menu, viewport.top, viewport.height, viewport.width]);
  // Phone: rename in the header, the Edit agent settings sheet, a message's long-press menu.
  const [editingTitle, setEditingTitle] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [msgMenu, setMsgMenu] = useState<{ at: { x: number; y: number }; text: string; rowId?: string } | null>(null);
  const ui = useContext(BoardUiCtx);
  const titlePress = useLongPress(() => setEditingTitle(true), mobile);
  const paused = useValue("sidebar-paused", () => boardLocks(editor).get().agentsPaused, [editor]);
  const remoteHost: string | null = paseo.host ?? view?.remote?.host ?? null;
  const paseoLink = usePaseoLink({ agentId, remoteHost, snapshotUrl: view?.paseoUrl, capabilities: capabilities.value });
  const [, tick] = useState(0);
  const status = agentId ? displayStatus(view, paseo.boundAt, paseo.status, paseo.subagents, paseo.cloudSessions, paseo.host, pendingStart) : paseo.request ? "starting" : "unbound";
  const meta = useAgentMeta(agentId, remoteHost, !!view && view.status !== "missing" && !view.availability);
  const live = view?.rows ?? [];
  // Earlier pages, then the live rows (which keep streaming while the reader is up in the history).
  const rows: HistoryRow[] = dedupeItemRows(joinHistory(history.page?.rows ?? null, live));
  // Consecutive tool calls fold into one "Edited 3 files, ran 2 commands" badge.
  const units = groupRows(rows, status === "running");
  // Each completed response gets its footer (Copy, Fork from here, time, Raw text) under its last row.
  const responseLayout = layoutResponses(units, unitKey, { active: status === "running" || status === "needs-permission" });
  const [rawOn, setRawOn] = useState<ReadonlySet<string>>(new Set());
  // "You: …" under the header: the last message the person sent (LastSentStrip.tsx).
  const lastFromRows = useMemo(() => lastHumanMessage(rows), [rows]);
  const composerSent = useLastSend(agentId ?? "", view, status);
  const lastSummary = useAgentSummary(agentId ?? "", !!agentId && !lastFromRows);
  const lastSent = agentId ? chooseLastSent(lastFromRows, composerSent ? { text: composerSent.text, at: composerSent.at } : null, lastSummary?.lastUserMessage) : null;
  const lastFull = lastSent ? (lastSent.inRows && lastFromRows ? rows[lastFromRows.index]?.text || lastSent.text : (lastSent.full ?? lastSent.text)) : "";
  // A tap on the strip: scroll to the message; older than what is loaded: open earlier
  // messages, a page at a time, until it is there.
  const [seekAt, setSeekAt] = useState<string | null>(null);
  const [seekStart, setSeekStart] = useState(false);
  const goToRow = (at: string) => {
    setSeekStart(false);
    pinned.current = false;
    setSeekAt(null);
    if (scrollToRow(listRef.current, at)) return;
    setSeekAt(at);
  };
  const goToLast = () => {
    if (lastSent) goToRow(lastSent.at);
  };
  const outline = useMemo(() => humanMessages(rows).reverse(), [rows]);
  // Phone: hold "You: …" for all of them (loaded so far), to jump to one.
  const mine = useMemo(() => (mobile ? humanMessages(rows).map(({ text, at }) => ({ text, at })) : []), [rows, mobile]);
  useEffect(() => {
    if (!seekAt) return;
    if (scrollToRow(listRef.current, seekAt)) return setSeekAt(null);
    if (history.busy) return;
    if (canPage && history.hasOlder) void history.loadOlder().then((r) => { if (r !== "ok") setSeekAt(null); });
    else setSeekAt(null);
  });
  useEffect(() => {
    if (!seekStart || history.busy) return;
    if (history.error) { setSeekStart(false); return; }
    if (canPage && history.hasOlder) {
      void history.loadOlder().then(result => { if (result !== "ok") setSeekStart(false); });
    } else {
      setSeekStart(false);
      if (outline[0]) scrollToRow(listRef.current, outline[0].at);
      else if (listRef.current) listRef.current.scrollTop = 0;
    }
  });
  // Model/mode/thinking/features and pending permissions (local agents only).
  const nativeControls = !remoteHost || capabilities.value?.source === "local-paseo";
  const controls = useAgentControls(agentId, status, visible && !!agentId && nativeControls && !!view && view.status !== "missing" && !view.availability);
  const pendingPermissions = controls.controls?.can.permissions ? controls.controls.pendingPermissions.length : 0;

  useEffect(() => {
    setPrimerOpen(false); setErr(null); setMenu(false); setRawOn(new Set()); setSeekStart(false); setSeekAt(null);
    paging.current = createPaging(); setPagingPhase(paging.current.phase);
  }, [agentId]);

  useEffect(() => {
    if (status !== "starting") return;
    const t = setTimeout(() => tick((n) => n + 1), 5000);
    return () => clearTimeout(t);
  });

  // Stay at the newest message unless the reader scrolled up.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [agentId, rows.length, rows.at(-1)?.text, rows.at(-1)?.item?.status, pendingPermissions]);
  // A page of earlier rows landed: move by the reading row's change in position, now and once
  // more after the next frame (late layout); then settle the paging (load on while near the top).
  useLayoutEffect(() => {
    const el = listRef.current;
    const a = anchor.current;
    if (!el || !a) return;
    anchor.current = null;
    const shift = anchorShift(a, measureRows(el));
    if (shift) el.scrollTop += shift;
    const moved = { id: a.id, top: a.top + shift };
    requestAnimationFrame(() => {
      const again = anchorShift(moved, measureRows(el));
      if (again) el.scrollTop += again;
    });
  });
  const paging = useRef(createPaging());
  const [pagingPhase, setPagingPhase] = useState(paging.current.phase);
  const pagingView = useRef<{ hasOlder: boolean; inFlight: () => boolean }>({ hasOlder: true, inFlight: () => false });
  pagingView.current = { hasOlder: history.hasOlder, inFlight: history.inFlight };
  const viewOf = (el: HTMLElement) => ({ scrollTop: el.scrollTop, hasOlder: pagingView.current.hasOlder, inFlight: pagingView.current.inFlight() });
  const historyRef = useRef(history);
  historyRef.current = history;
  const applyPaging = (step: PagingStep) => {
    paging.current = step.state;
    setPagingPhase(step.state.phase);
    if (!step.fetch) return;
    const forAgent = agentId;
    void historyRef.current.loadOlder().then((result) => {
      if (forAgent !== agentRef.current) return;
      if (result === "error") paging.current = failed(paging.current);
      else if (result === "skip") paging.current = { phase: "ready", failed: false };
      else {
        paging.current = landed(paging.current);
        // Two frames for the rows to lay out and the reading position to be restored.
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const el = listRef.current;
          if (el && forAgent === agentRef.current) applyPaging(settle(paging.current, viewOf(el)));
        }));
      }
      setPagingPhase(paging.current.phase);
    });
  };
  const agentRef = useRef(agentId);
  agentRef.current = agentId;
  const pageCheck = () => {
    const el = listRef.current;
    if (el && canPage) applyPaging(evaluate(paging.current, viewOf(el)));
  };
  // An upward gesture by the reader arms the paging (opening a conversation never pages by itself).
  const pageGesture = () => {
    if (!canPage) return;
    paging.current = rearm(paging.current);
    pageCheck();
  };
  const gestureRef = useRef({ touchY: 0, scrollbar: false, lastTop: 0 });
  const retryPaging = () => {
    if (canPage) applyPaging(retry(paging.current, { hasOlder: history.hasOlder, inFlight: history.inFlight() }));
  };
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
  // "Fork from here" on a message: the conversations the menu's "Fork to new frame" forks.
  const canFork = !!agentId && !paseo.request && !remoteHost;
  // Phone: straight from the message's long-press menu.
  const forkHere = (rowId: string) => {
    setErr(null);
    forkFromRow(boardId, frameId, rowId).then((r) => ui.toast(forkedNotice(r)), (e: Error) => setErr(`Not forked: ${e.message}`));
  };
  // "Exact full text" on a message the server cut short (it used to be on every row once
  // "Show earlier messages" had been opened).
  const exact = !!agentId && capabilities.can("exactTimeline");
  const forkTarget = (row: HistoryRow & { id: string }) => ({ boardId, frameId, rowId: row.id, at: row.at, text: row.primer ? primerLabel(row) : row.text });

  // An unbound frame owns the start form; an empty phone conversation would cover it.
  // (Phone: a start that failed keeps its thread open, saying why.)
  if(sheet && !agentId && !paseo.request && !(mobile && paseo.error))return null;

  return (
    <div
      ref={rootRef}
      data-chat-drop=""
      data-testid={embedded ? "peek-conversation" : "sidebar"}
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
          : embedded
            ? { position: "absolute", inset: 0, borderLeft: "1px solid light-dark(#e2e8f0, var(--bunny-line))" }
            : { position: "relative", boxSizing: "border-box", width: desktopWidth, flexShrink: 0, borderLeft: "1px solid light-dark(#e2e8f0, var(--bunny-line))" }),
        background: "light-dark(#fff, var(--bunny-surface))",
        color: "light-dark(#0f172a, hsl(222 50% 74%))",
        pointerEvents: "all",
        display: "flex",
        flexDirection: "column",
        font: sheet ? "15px system-ui, sans-serif" : "13px system-ui, sans-serif",
        zIndex: embedded ? undefined : 400,
      }}
    >
      {resizable ? (
        <SidebarResizer
          panel={rootRef}
          width={shownW}
          onPreview={setDragW}
          onCommit={(w) => {
            setDragW(null);
            if (wideReading) onReadingChange?.(false);
            onWidthChange?.(w);
          }}
        />
      ) : null}
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
      <header data-testid="sidebar-header" {...(phoneSheet ? { onPointerDown: sheetDrag.onPointerDown, onPointerMove: sheetDrag.onPointerMove, onPointerUp: sheetDrag.onPointerUp, onPointerCancel: sheetDrag.onPointerCancel } : {})} style={{ position: "relative", ...(phoneSheet ? { touchAction: "none" } : {}), flexShrink: 0, display: "flex", alignItems: mobile ? "center" : "flex-start", gap: mobile ? 4 : 8, padding: mobile ? "0 4px 0 14px" : "10px 8px 10px 14px", borderBottom: "1px solid light-dark(#e2e8f0, var(--bunny-line))" }}>
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
        {/* Anchor the menu to the header: the button sits left of Hide chat, so a
            button-aligned menu spills outside the clipped embedded conversation pane. */}
        <div>
          <button type="button" data-testid="sidebar-menu" aria-label="More" aria-expanded={menu} style={{ ...iconBtn, ...(mobile ? { width: 40, height: 40 } : {}) }} onClick={() => setMenu((m) => !m)}><AppIcon name="more" size={20} /></button>
          {menu ? (
            <div ref={menuPanel} role="menu" data-testid="sidebar-menu-panel" style={{ position: "absolute", right: 8, top: "calc(100% + 4px)", boxSizing: "border-box", width: mobile ? "min(320px, calc(100% - 16px))" : "min(300px, calc(100% - 16px))", maxHeight: menuHeight, overflowY: "auto", overscrollBehavior: "contain", background: "light-dark(#fff, var(--bunny-surface))", border: `1px solid ${B.line}`, borderRadius: 14, boxShadow: "0 10px 30px rgba(46,31,22,.14), 0 1px 2px rgba(46,31,22,.06)", padding: 6, display: "flex", flexDirection: "column", gap: 4, zIndex: 2, font: `13px ${UI_FONT}`, color: B.espresso }}>
              {/* One menu for the frame (FrameActions.tsx): what the floating frame bar held, too. */}
              <FrameMenuGroups
                editor={editor}
                frameId={frameId}
                boardId={boardId}
                canRestart={capabilities.can("restartWithTools")}
                mobile={mobile}
                close={() => setMenu(false)}
                agent={
                  <>
                    {!mobile ? <div style={{ padding: "2px 6px" }}><AgentControlsBar state={controls} /></div> : null}
                    {agentId ? <PaseoLink link={paseoLink} testId="sidebar-open-paseo" style={{ ...menuItem, font: `500 13px ${UI_FONT}`, minHeight: mobile ? 44 : 32, boxSizing: "border-box" }} /> : null}
                    {mobile ? (
                      <button type="button" className="bm-menu-action" data-testid="sidebar-edit-agent" onClick={() => { setMenu(false); setSettingsOpen(true); }}>
                        ✎ Edit agent settings
                      </button>
                    ) : null}
                  </>
                }
                mobileFrameItems={
                  mobile ? (
                    <>
                      <button type="button" className="bm-menu-action" data-testid="sidebar-show-on-board" onClick={() => { setMenu(false); askReveal(frameId); }}>
                        ◎ Show on board
                      </button>
                      <button type="button" className="bm-menu-action" data-testid="sidebar-move-frame" onClick={() => { setMenu(false); askMove(frameId); }}>
                        ✥ Move frame…
                      </button>
                    </>
                  ) : null
                }
                addToBoard={
                  <div className="bunny-add-to-board" style={{ display: "flex", flexDirection: "column", gap: 6, padding: "2px 10px 4px" }}>
                    {agentId ? <TranscriptDragSource editor={editor} agentId={agentId} frameId={frameId} /> : null}
                    {frame ? <LinkDragSource boardId={boardId} frameId={frameId} title={frame.props.name ?? ""} /> : null}
                    <ChecklistDragSource editor={editor} frameId={frameId} enabled />
                  </div>
                }
              />
              {agentId ? <div style={{ color: B.muted, fontSize: 11, padding: "4px 10px 2px", overflowWrap: "anywhere" }}>agent {agentId} · {paseo.mode ?? "live"} deltas</div> : null}
            </div>
          ) : null}
        </div>
        {mobile ? <button type="button" data-testid="mobile-collapse" onClick={onClose} style={{ ...iconBtn, width: 40, height: 40 }} aria-label="Collapse the thread"><AppIcon name="chevron-down" size={20} /></button> : null}
        {mobile ? null : embedded ? <button type="button" data-testid="peek-chat-hide" onClick={onClose} style={{ display: "inline-flex", alignItems: "center", gap: 4, flex: "none", minHeight: 32, padding: "0 8px 0 12px", border: `1px solid ${B.line}`, borderRadius: 999, background: "transparent", color: B.espresso, font: `500 12px ${UI_FONT}`, cursor: "pointer" }} aria-label="Hide the conversation" title="Fold the conversation into the strip (click the strip to bring it back)">Hide chat <AppIcon name="chevron-right" size={16} /></button> : <button type="button" onClick={onClose} style={{...iconBtn,minWidth:36,minHeight:36}} aria-label="Collapse sidebar" title="Collapse sidebar; use the edge arrow to reopen"><AppIcon name="chevron-right" /></button>}
      </header>

      {lastSent ? <LastSentStrip text={lastSent.text} full={lastFull} mobile={mobile} onGo={goToLast} mine={mine} onJump={goToRow} /> : null}
      <TranscriptAvailability view={view}/>
      {/* This frame's agent asked to be connected to another frame: answer here or at the frame. */}
      {agentId ? <ChannelOfferStrip editor={editor} boardId={boardId} frameId={frameId} mobile={mobile} /> : null}
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

      <div style={{ position: "relative", display: "flex", flex: 1, minHeight: 0 }}>
      <div
        ref={listRef}
        data-testid="sidebar-scroll-content"
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          // The browser's own scroll anchoring only while following the bottom: the reading
          // anchor above moves it otherwise, and two adjustments would double the jump.
          el.style.overflowAnchor = pinned.current ? "auto" : "none";
          const g = gestureRef.current;
          if (g.scrollbar && el.scrollTop < g.lastTop) paging.current = rearm(paging.current);
          g.lastTop = el.scrollTop;
          pageCheck();
        }}
        onWheel={(e) => { if (e.deltaY < 0) pageGesture(); }}
        onTouchStart={(e) => { gestureRef.current.touchY = e.touches[0]?.clientY ?? 0; }}
        onTouchMove={(e) => { const y = e.touches[0]?.clientY ?? 0; if (y - gestureRef.current.touchY > 4) pageGesture(); gestureRef.current.touchY = y; }}
        onKeyDown={(e) => { if (e.key === "ArrowUp" || e.key === "PageUp" || e.key === "Home" || (e.key === " " && e.shiftKey)) requestAnimationFrame(pageGesture); }}
        onPointerDown={(e) => { if (e.target === e.currentTarget) gestureRef.current.scrollbar = true; }}
        onPointerUp={() => { gestureRef.current.scrollbar = false; }}
        onPointerCancel={() => { gestureRef.current.scrollbar = false; }}
        style={{ flex: 1, minHeight: 0, overflowY: "auto", overscrollBehavior: "contain", padding: wideReading ? "16px max(24px, calc((100% - 1000px) / 2))" : "10px 14px", display: "flex", flexDirection: "column", gap: 10 }}
      >
        <FrameUploadReceipts boardId={boardId} frameId={frameId} compact={mobile} />
        <style>{RESPONSE_FOOTER_CSS + PAGING_CSS}</style>
        {canPage ? (
          // A fixed 32px slot above the first row, so what it shows never moves the conversation.
          <div data-testid="older-history-slot" data-phase={pagingPhase} style={{ position: "relative", flex: "none", height: 32, marginBottom: -6, display: "flex", alignItems: "center", justifyContent: "center", gap: 4, minWidth: 0, font: `11px ${UI_FONT}`, color: B.muted }}>
            {history.busy ? (
              <span role="status" aria-label="Loading earlier messages" data-testid="load-older-history-spinner" className="tl-spinner" style={{ width: 12, height: 12, borderColor: "currentColor", borderTopColor: "transparent", opacity: 0.7 }} />
            ) : history.error ? (
              <span role="alert" data-testid="older-history-error" style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                <span aria-hidden style={{ flex: "none", width: 7, height: 7, borderRadius: 999, background: B.danger }} />
                <span title={history.error} style={{ minWidth: 0, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>Couldn't load earlier messages ·</span>
                <button type="button" className="bunny-slot-retry" data-testid="older-history-retry" onClick={retryPaging}>Retry</button>
              </span>
            ) : !history.hasOlder ? (
              <span data-testid="history-start">Start of conversation</span>
            ) : (
              <button type="button" className="bunny-load-earlier" data-testid="load-earlier" onClick={retryPaging}>Load earlier messages</button>
            )}
          </div>
        ) : null}
        {history.notice ? <div role="status" data-testid="history-notice" style={{ flex: "none", textAlign: "center", font: `11px ${UI_FONT}`, color: B.muted }}>{history.notice}</div> : null}
        <div data-testid="timeline" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {rows.length === 0 ? <div style={{ color: "light-dark(#94a3b8, var(--bunny-muted))", textAlign: "center", padding: 20 }}>{status === "starting" ? `Starting on ${machine}…` : agentId ? "No messages yet." : mobile && paseo.error ? <span role="alert" data-testid="sidebar-start-error" style={{ color: "light-dark(#b00020, hsl(349 88% 74%))" }}>Start failed: {String(paseo.error)}</span> : "Waiting for the agent…"}</div> : null}
          {units.map((u, i) => {
            const renderRow = (r: HistoryRow) => <Row row={r} agentId={agentId} exact={exact} exactRoute={!!agentId && capabilities.can("exactTimeline")} onChanged={history.invalidate} primerOpen={primerOpen} togglePrimer={() => setPrimerOpen((x) => !x)} />;
            const id = unitKey(u, i);
            const response = responseLayout.responseOf[i];
            const footer = responseLayout.footers.get(i);
            let body: React.ReactNode;
            let actions: React.ReactNode = null;
            if (u.kind === "group") body = <ToolGroupView unit={u} renderRow={renderRow} />;
            else {
              const forkRow = canFork && forkableRow(u.row) ? u.row : undefined;
              // Phone: a long-press opens the message's menu (Copy, Start agent about this, Fork from here).
              if (mobile && u.row.text?.trim() && (u.row.kind === "user" || u.row.kind === "assistant")) body = <MessagePress at={u.row.at} text={u.row.text} open={(at) => setMsgMenu({ at, text: u.row.text, rowId: forkRow?.id })}>{renderRow(u.row)}</MessagePress>;
              // The data-at holder stays boxless, so "You: …" still scrolls to and lights up the message itself.
              else body = <div data-at={u.row.at} style={{ display: "contents" }}>{renderRow(u.row)}</div>;
              // Desktop: Copy and Fork from here under your message, shown on hover or focus.
              if (!mobile && u.row.kind === "user") actions = <UserMessageActions text={u.row.primer ? u.row.text || primerLabel(u.row) : u.row.text} fork={forkRow ? forkTarget(forkRow) : undefined} />;
            }
            return (
              <Fragment key={`${agentId}:${id}`}>
                <ResponseRawCtx.Provider value={response === null ? null : rawOn.has(response)}>
                  <div className="bunny-unit" data-history-row-id={id} style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                    {body}
                    {actions}
                  </div>
                </ResponseRawCtx.Provider>
                {footer ? (
                  <ResponseFooter
                    copyText={footer.copyText}
                    fork={footer.forkRow && canFork ? forkTarget(footer.forkRow) : undefined}
                    at={footer.at}
                    touch={mobile}
                    raw={footer.hasText ? { on: rawOn.has(footer.key), toggle: () => setRawOn((was) => { const next = new Set(was); if (!next.delete(footer.key)) next.add(footer.key); return next; }) } : undefined}
                  />
                ) : null}
              </Fragment>
            );
          })}
          {mobile && stoppedHere ? <div data-testid="thread-stopped" role="status" style={{ alignSelf: "center", color: "light-dark(#7f1d1d, hsl(0 63% 74%))", fontSize: 13, fontWeight: 600, background: "light-dark(#fef2f2, var(--bunny-surface))", borderRadius: 999, padding: "4px 12px" }}>{working ? "Stopping…" : "■ Stopped"}</div> : null}
          {status === "running" ? <div data-testid="sidebar-working" style={{ color: "light-dark(#64748b, var(--bunny-muted))", fontSize: 12 }}>● Working…</div> : null}
          {status === "needs-permission" && !pendingPermissions ? <div role="alert" data-testid="permission-alert" style={{ color: "light-dark(#9c4b00, hsl(29 88% 74%))", fontWeight: 600 }}>{remoteHost ? "Last poll reported a permission request. Check the owning host." : "Permission needed: answer in Paseo before work can continue."}</div> : null}
        </div>
        {shownErr ? <div role="alert" style={{ color: "light-dark(#b00020, hsl(349 88% 74%))", fontSize: 12 }}>{shownErr}</div> : null}
      </div>

      <ChatOutline key={agentId ?? frameId} listRef={listRef} prompts={outline} mobile={mobile} atStart={!history.hasOlder} onJump={goToRow}
        onLatest={() => { setSeekStart(false); setSeekAt(null); anchor.current = null; pinned.current = true; const el = listRef.current; if (el) el.scrollTop = el.scrollHeight; }}
        beginning={canPage && history.hasOlder ? { busy: seekStart, go: () => { pinned.current = false; setSeekAt(null); setSeekStart(true); }, cancel: () => setSeekStart(false) } : undefined}
        older={canPage && history.hasOlder ? { busy: history.busy, error: history.error, load: () => { pinned.current = false; retryPaging(); } } : undefined} />
      </div>
      {agentId && nativeControls ? <PermissionCards state={controls} paseoLink={paseoLink} /> : null}
      {mobile && settingsOpen ? <EditAgentSheet name={frame?.props.name || view?.title || ""} controls={controls.controls && !controls.unsupported ? <AgentControlsBar state={controls} /> : null} save={(n) => { renameFrame(editor, frameId, n); setSettingsOpen(false); }} close={() => setSettingsOpen(false)} /> : null}
      {mobile && msgMenu ? <MessageMenu at={msgMenu.at} text={msgMenu.text} close={() => setMsgMenu(null)} startAbout={() => void startBeside({ frameId, agentId, binding: paseo, frameName: frame?.props.name ?? "", boardId, quote: msgMenu.text })} fork={msgMenu.rowId ? () => forkHere(msgMenu.rowId!) : undefined} /> : null}
      {mobile && agentId ? <MobileActions controls={controls} approving={approving} setApproving={setApproving} /> : null}
      {agentId ? (
        <ChatComposer key={agentId} agentId={agentId} view={view} status={status} canPrompt={capabilities.value ? capabilities.can("prompt") : !paseo.request} unavailable={capabilities.error} large={sheet || mobile} maxHeight={mobile ? composerMaxHeight(viewport.height) : undefined} attach={!remoteHost ? (files) => sendPhotosToFrame(editor, boardId, frameId, agentId, files) : undefined} busyAction={mobile && working ? <StopButton agentId={agentId} host={remoteHost} rows={rows.length} onError={setErr} /> : undefined} turnControls={<TurnControls agentId={agentId} host={remoteHost} status={status} rows={rows.length} canPrompt={capabilities.value ? capabilities.can("prompt") : !paseo.request} showStop={!mobile} large={mobile} onError={setErr} />} placeholder={mobile ? "Reply…" : `Reply to ${view?.title || frame?.props.name || "the agent"}…`} />
      ) : (
        <div style={{ flexShrink: 0, padding: 12, borderTop: "1px solid light-dark(#e2e8f0, var(--bunny-line))", color: "light-dark(#94a3b8, var(--bunny-muted))", fontSize: 12 }}>{paseo.request ? "The reply box opens when the agent has started." : "Not bound to an agent."}</div>
      )}
    </div>
  );
}

// One message, Paseo style: your messages as bubbles on the right, the agent's text
// plain, tools and board changes as one quiet line each.
function Row({ row: r, agentId, exact, exactRoute, onChanged, primerOpen, togglePrimer }: { row: HistoryRow; agentId?: string; exact: boolean; exactRoute: boolean; onChanged: () => void; primerOpen: boolean; togglePrimer: () => void }) {
  const raw = useResponseRaw();
  // Not on the board's own summaries (its introduction, the opening prompt), which are short on purpose.
  const exactRow = agentId && exact && typeof r.id === "string" && r.truncated && !r.primer && r.text !== INTRO_ROW ? <ExactRow agentId={agentId} row={r} onChanged={onChanged} /> : null;
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
        <MessageBody text={r.text} raw={raw} />
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
