import { startPending } from "../../shared/start-pending";
import { remoteStatusLabel } from "../../shared/remote-status";
import {startHostsMemo,watchStartHosts} from "./startHosts";
import { upstashDefault, executionLabel, initialRunsOn, runsOnRequest, fleetHostsForRuntime, machineLabel, runsOnSummary } from "../../shared/conversation-links";
import { StartingState } from "./StartingState";
import { useAgentCapabilities } from "./agentCapabilities";
import { RelinkFrame } from "./RelinkFrame";
import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { type Editor, type TLFrameShape, useEditor, useValue } from "tldraw";
import { api } from "./api";
import { HostConnectionBadge } from "./HostConnectionBadge";
import { displayStatus, subagentCount, useAgentView, statusLabel } from "./agents";
import { FrameContentTools } from "./FrameContentTools";
import { HistoryButton } from "./FrameHistory";
import { useNarrow } from "./BoardControls";
import { boardLocks } from "./locks";
import { BoardUiCtx } from "./ui";
import { ArchiveCtx } from "./FrameArchive";
import { Emoji } from "./Emoji";
import { BunnyMark } from "./BunnyMark";
import { ModelPicker } from "./ModelPicker";
import { addPin, clearOfHeading, removePin, type ScreenRect, usePanelDock, usePinJump, usePins } from "./framePanelDock";
import { Dot } from "./Dot";
import { B, BUNNY_CONTROLS_CSS, DOT, chip, fieldLabel, iconBtn, menuItem, primaryBtn, softBtn, surface } from "./bunnyTheme";
import { FALLBACK_PROVIDERS, fallbackCatalogue, initialChoice, type StartCatalogue } from "../../shared/start-catalogue";
import { CLOUD_PROVIDERS, CLOUD_PROVIDER_LABEL, frameCloudProvider, type CloudProvider } from "../../shared/cloud-provider";
import { infoNow } from "./info";
import { MobileCtx } from "./mobile/mobileMode";
import { askStartSheet } from "./mobile/StartSheet";
import { QuickStarts } from "./QuickStarts";
import { recordOpeningPrompt, takePendingPrompt } from "./quickStartPrompts";

const panelBase: React.CSSProperties = {
  ...surface,
  position: "absolute",
  top: 56,
  left: "50%",
  transform: "translateX(-50%)",
  pointerEvents: "all",
  padding: "8px 8px 8px 14px",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  // Sized to the canvas area (the panel's containing layer), not the window: side panels narrow the
  // canvas, and a window-based cap let the panel run under them.
  maxWidth: "min(560px, calc(100% - 24px))",
  boxSizing: "border-box",
  zIndex: 300,
};

// Docked pill and docked panel sit in the bottom dock row (PinDock's DockRow, next to the
// organizer's Bunny launcher), so they are laid out in flow there, not positioned here.
const pillStyle: React.CSSProperties = {
  ...surface,
  position: "relative",
  pointerEvents: "all",
  display: "flex",
  alignItems: "center",
  gap: 7,
  maxWidth: 240,
  padding: "5px 12px 5px 6px",
  borderRadius: 999,
  cursor: "pointer",
};

// Docked and expanded: the full panel in the same corner, anchored at the bottom so it
// grows upward; its menus open upward too.
// Docked panels stay inside the dock row (which already clears the launcher and the canvas edges).
const dockedPanel: React.CSSProperties = { ...panelBase, position: "relative", top: "auto", left: "auto", transform: "none", zIndex: 1, maxWidth: "min(560px, 100%)", minWidth: 0 };
const dockedPanelNarrow: React.CSSProperties = { ...dockedPanel, maxWidth: "100%" };

const menuBase: React.CSSProperties = { ...surface, position: "absolute", top: "calc(100% + 6px)", right: 0, width: 300, padding: 6, display: "flex", flexDirection: "column", gap: 2, zIndex: 10, maxHeight: "calc(100vh - 140px)", overflowY: "auto" };
const menuUp: React.CSSProperties = { ...menuBase, top: "auto", bottom: "calc(100% + 6px)" };
const divider = <div style={{ height: 1, background: B.line, margin: "4px 6px" }} />;

// Frames the phone shell (mobile/MobileShell.tsx) created with Start agent.
export const startRequested = new Set<string>();

// Toolbar shown when exactly one frame is selected: one compact row (status, name, the main
// action for unbound frames, pin, ⋯ for everything else). Unpinned frames float near the top
// or dock bottom-right (minimizable to a pill); a pinned frame's panel is its own pin pill
// expanded in place in the bottom dock (`pinned`), and – collapses it back to that pill.
export function FramePanel({ frame, boardId, onOpen, pinned: inPin = false, onCollapse }: { frame: TLFrameShape; boardId: string; onOpen: () => void; pinned?: boolean; onCollapse?: () => void }) {
  const editor = useEditor();
  const live = useValue("frame", () => editor.getShape(frame.id) as TLFrameShape | undefined, [editor, frame.id]);
  // biome-ignore lint/suspicious/noExplicitAny: meta JSON.
  const paseo = ((live?.meta as any)?.paseo ?? {}) as Record<string, any>;
  const capabilities = useAgentCapabilities(paseo.agentId, `${boardId}:${frame.id}:${paseo.host ?? "local"}`);
  const hostView=useAgentView(paseo.agentId);
  const ui = useContext(BoardUiCtx);
  // The phone shell starts agents from its own bottom sheet (mobile/StartSheet.tsx).
  const mobile = useContext(MobileCtx);
  const archive = useContext(ArchiveCtx);
  const narrow = useNarrow();
  const paused = useValue("frame-panel-paused", () => boardLocks(editor).get().agentsPaused, [editor]);
  const [dock, setDock] = usePanelDock();
  const docked = inPin || dock !== "float";
  const [pins, setPins] = usePins(boardId);
  const [jump, setJump] = usePinJump();
  // Floating near the frame (phones: full width under the header), or docked bottom-right.
  const panel: React.CSSProperties = docked ? (narrow ? dockedPanelNarrow : dockedPanel) : narrow ? { ...panelBase, left: 8, right: 8, top: 58, transform: "none", maxWidth: "none", maxHeight:"calc(100dvh - 74px)", overflowY:"auto" } : panelBase;
  const [menuOpen, setMenuOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  // Floating: never on top of the frame's own title, which is double-clicked to rename it.
  const headingKey = useValue("frame-panel-heading", () => (docked ? "" : headingScreenKey(editor, frame.id)), [editor, frame.id, docked]);
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    const el = root.current;
    const heading = parseRectKey(headingKey);
    if (!el || !heading) {
      setShift(0);
      return;
    }
    const r = el.getBoundingClientRect();
    setShift((cur) => clearOfHeading({ left: r.left, right: r.right, top: r.top - cur, bottom: r.bottom - cur }, heading));
  }, [headingKey]);
  // A pin pill clicked by keyboard or mouse unmounts as this panel replaces it; keep focus in
  // the dock (here) instead of losing it to the page. A canvas selection keeps canvas focus.
  useEffect(() => {
    if (inPin && (!document.activeElement || document.activeElement === document.body)) root.current?.focus();
  }, [inPin]);
  // Keys pressed in the panel are the panel's, never canvas shortcuts (Backspace on a focused
  // button must not delete the frame). Esc collapses a pinned frame's panel; elsewhere it still
  // reaches the canvas, which deselects as before. Native listener on the panel: tldraw
  // listens on its container, which React's own handlers only see afterwards.
  const collapseRef = useRef(onCollapse);
  collapseRef.current = onCollapse;
  useEffect(() => {
    const panelEl = root.current;
    if (!panelEl) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !inPin) return;
      e.stopPropagation();
      if (e.key === "Escape") collapseRef.current?.();
    };
    panelEl.addEventListener("keydown", onKey);
    return () => panelEl.removeEventListener("keydown", onKey);
  });
  // A frame the phone shell's Start agent just drew opens straight on the start form.
  const [mode, setMode] = useState<"idle" | "start" | "restart" | "unbind">(() => (startRequested.delete(frame.id) ? "start" : "idle"));
  // The panel stays mounted when the selection moves to another frame (a conversation's + New
  // agent selects the frame it drew): pick up its request then too.
  useEffect(() => {
    if (startRequested.delete(frame.id)) setMode("start");
  }, [frame.id]);
  // On a phone the start form is the shell's own sheet; this panel's inline form (narrow at
  // the top of the canvas, under the frame spotlight) is never shown there.
  useEffect(() => {
    if (mobile && mode === "start") {
      askStartSheet(frame.id);
      setMode("idle");
    }
  }, [mobile, mode, frame.id]);
  const [unbinding, setUnbinding] = useState(false);
  const [archiveOld, setArchiveOld] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const restartBusy = useRef(false);
  const [catalogue, setCatalogue] = useState<StartCatalogue | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [line, setLine] = useState("");
  // A starter chosen on the empty-board hint opens this frame's start form with it filled.
  // (The phone's start sheet takes the starter itself.)
  useEffect(() => {
    if (mobile) return;
    const p = takePendingPrompt(frame.id);
    if (p === undefined) return;
    setLine(p);
    setMode("start");
  }, [frame.id, mobile]);
  // Cloud path (skills/cloud-dev): a cloud builder (Claude by default, or Codex) codes; this
  // Mac previews and deploys. The Model picker above is the conductor conversation's own.
  const [cloud, setCloudState] = useState(() => {
    try { return initialRunsOn(infoNow(), localStorage.getItem("bunny:runs-on")); }
    catch { return initialRunsOn(infoNow()); }
  });
  const setCloud = (value: boolean) => {
    setCloudState(value);
    try { localStorage.setItem("bunny:runs-on", value ? "worker" : "runtime"); } catch { /* Storage can be disabled. */ }
  };
  const ephemeral = upstashDefault(infoNow());
  const [startHost, setStartHost] = useState(() => {if(upstashDefault(infoNow()))return "";try{const saved=localStorage.getItem("bunny:runs-on");return saved?.startsWith("host:")?saved.slice(5):"";}catch{return "";}});
  // The machine local (and cloud-conducted) agents really run on: what the board's Paseo
  // daemon reports, else the configured runtime host.
  const runtimeMachine = infoNow()?.agentMachine || infoNow()?.runtimeHostname || "";
  const [startHosts, setStartHosts] = useState<Array<{host:string;state:string;enabled:boolean;reason?:string}>>(() => startHostsMemo().hosts);
  const [hostsNote, setHostsNote] = useState<string | null>(null);
  const [hostsLoading, setHostsLoading] = useState(false);
  const [hostsError, setHostsError] = useState<string | null>(null);
  const [hostsRefresh, setHostsRefresh] = useState(0);
  const checkedRefresh=useRef(0);
  useEffect(() => {
    if(mode!=="start")return;
    const force=checkedRefresh.current!==hostsRefresh;checkedRefresh.current=hostsRefresh;
    setHostsError(null);
    return watchStartHosts(r=>{
      setStartHosts(fleetHostsForRuntime(r.hosts,infoNow()?.runtimeHostname || ""));
      setHostsNote(r.note??null);setHostsLoading(r.refreshing);
    },e=>{setHostsError(`Could not check hosts: ${e.message}`);setHostsLoading(false);},force);
  },[mode,hostsRefresh]);
  const [cloudProvider, setCloudProvider] = useState<CloudProvider>("claude");
  const [codexReadiness, setCodexReadiness] = useState<{ ready: boolean; error?: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== "start" || !cloud || cloudProvider !== "codex") return;
    let gone = false;
    setCodexReadiness(null);
    const load = () => api<{ codex: { ready: boolean; error?: string } }>("/api/ui/cloud-doctor")
      .then((result) => { if (!gone) setCodexReadiness(result.codex); })
      .catch(() => { if (!gone) setCodexReadiness({ ready: false, error: "Could not check Codex Cloud readiness" }); });
    void load();
    const timer = setInterval(load, 30_000);
    return () => { gone = true; clearInterval(timer); };
  }, [mode, cloud, cloudProvider]);

  // Paseo's harness and model catalogue, read when the start form opens; asked again while
  // a harness is still loading its models.
  const loadingHarness = !!catalogue?.harnesses.some((h) => h.status === "loading");
  useEffect(() => {
    if (mode !== "start" || (catalogue && !loadingHarness)) return;
    let gone = false;
    const load = () =>
      api<StartCatalogue>("/api/ui/start-options")
        .catch((e: Error) => fallbackCatalogue(FALLBACK_PROVIDERS[0], `Could not load models (${e.message})`))
        .then((c) => {
          if (gone) return;
          setCatalogue(c);
          setProvider((p) => p ?? initialChoice(c));
        });
    const t = setTimeout(load, catalogue ? 5000 : 0);
    return () => {
      gone = true;
      clearTimeout(t);
    };
  }, [mode, catalogue, loadingHarness]);

  const closeMenu = () => {
    setMenuOpen(false);
    setMode((m) => (m === "unbind" || m === "restart" ? "idle" : m));
  };
  useEffect(() => {
    if (!menuOpen) return;
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) closeMenu();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      closeMenu();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", esc, true);
    };
  }, [menuOpen]);

  if (!live) return null;
  const by = window.__board?.userName ?? "User";
  const name = live.props.name || "Frame";

  const writeRequest = (request: Record<string, unknown>) => {
    editor.updateShape<TLFrameShape>({
      id: live.id,
      type: "frame",
      props: { color: "violet" },
      meta: { ...live.meta, paseo: JSON.parse(JSON.stringify({ ...paseo, request: { ...request, requestedAt: Date.now(), by }, status: "requested", error: undefined })) },
    });
    setMode("idle");
    onOpen();
  };

  const bound = !!paseo.agentId;
  // Same status the sidebar shows: the live agent view, falling back to the frame's record.
  const liveStatus = bound ? displayStatus(hostView, paseo.boundAt, paseo.status, paseo.subagents, paseo.cloudSessions, paseo.host, startPending(paseo)) : "";
  const statusKey = bound ? (paused ? "paused" : liveStatus) : paseo.status === "error" ? "error" : paseo.request ? "requested" : "unbound";
  const statusText = bound
    ? `${remoteStatusLabel(hostView?.remote ?? (paseo.host ? {host:paseo.host,polledAt:null} : undefined),statusLabel(liveStatus, subagentCount(hostView, paseo.subagents)), Date.now(), liveStatus === "starting")}${paused ? ` · paused${paseo.pendingDeltas ? `, ${paseo.pendingDeltas} queued` : ""}` : ""}`
    : paseo.status === "error"
      ? "start failed"
      : paseo.request
      ? "starting…"
      : "no conversation yet";
  const needsLook = !!paseo.pendingDeltas || (bound && paused) || !!err;

  const pinned = pins.includes(live.id);
  if (dock === "pill" && !inPin) {
    return (
      <button
        type="button"
        className="bunny-fp"
        data-testid="frame-panel-pill"
        style={pillStyle}
        title={`${name} · ${statusText}. Show the frame panel`}
        aria-label={`Show frame panel for ${name} (${statusText})`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => setDock("open")}
      >
        <style>{BUNNY_CONTROLS_CSS}</style>
        <BunnyMark size={20} mood={statusKey === "running" || statusKey === "subagents" || statusKey === "cloud" || statusKey === "requested" || statusKey === "starting" ? "working" : statusKey === "error" ? "error" : "idle"} />
        <span style={{ font: "600 13px Inter, system-ui, sans-serif", color: B.espresso, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{name}</span>
        <Dot status={statusKey} text={statusText} />
      </button>
    );
  }

  const header = (primary: React.ReactNode) => (
    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
      <Dot status={statusKey} text={statusText} testId={bound ? "frame-status" : "frame-dot"} />
      <b title={name} style={{ font: "600 14px Inter, system-ui, sans-serif", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: "0 1 auto", maxWidth: narrow ? "none" : 240 }}>{name}</b>
      {/* Pushes the actions to the right edge when the panel is wider than the header (start form open). */}
      <span aria-hidden style={{ flex: "1 1 0", minWidth: 0 }} />
      {primary}
      <button
        type="button"
        className="bfp-icon"
        data-testid="frame-pin"
        aria-pressed={pinned}
        title={pinned ? "Unpin this frame" : "Pin this frame for quick switching"}
        aria-label={pinned ? `Unpin ${name}` : `Pin ${name}`}
        style={{ ...iconBtn, background: pinned ? B.lavenderSoft : "transparent", color: pinned ? B.violetDeep : B.muted }}
        onClick={() => setPins(pinned ? removePin(pins, live.id) : addPin(pins, live.id))}
      >
        <PinIcon filled={pinned} />
      </button>
      <button
        type="button"
        className="bfp-icon"
        data-testid="frame-more"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title="More: send mode, history, frame tools, archive, unbind"
        style={{ ...iconBtn, position: "relative", background: menuOpen ? B.hover : "transparent" }}
        onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}
      >
        ⋯{needsLook ? <span aria-hidden style={{ position: "absolute", top: 4, right: 4, width: 7, height: 7, borderRadius: 4, background: B.orange }} /> : null}
      </button>
      {inPin ? (
        <button type="button" className="bfp-icon" data-testid="pin-collapse" title="Collapse to its pin" aria-label={`Collapse ${name} to its pin`} style={iconBtn} onClick={() => { closeMenu(); onCollapse?.(); }}>
          –
        </button>
      ) : (
        <button type="button" className="bfp-icon" data-testid="frame-panel-minimize" title={docked ? "Collapse to the pill" : "Minimize to the corner"} aria-label="Minimize frame panel" style={iconBtn} onClick={() => { closeMenu(); setDock("pill"); }}>
          –
        </button>
      )}
    </div>
  );

  const chips = (
    <div className="bfp-chips" style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: "4px 6px 6px" }}>
      {bound ? <span style={{ ...chip, background: "light-dark(#fff, var(--bunny-surface))", border: `1px solid ${B.line}` }}><HostConnectionBadge view={hostView} /></span> : null}
      {bound && paused ? <span data-testid="frame-paused" title="Board agents are paused; frame changes wait until they resume" style={{ ...chip, background: "light-dark(#FFF0CC, hsl(42 45% 21%))", color: B.espresso }}>⏸ paused{paseo.pendingDeltas ? ` · ${paseo.pendingDeltas} queued` : ""}</span> : null}
      {paseo.host ? <span title="Runs on another Mac, reached through af-network" style={{ ...chip, background: B.lavenderSoft }}>on {paseo.host}</span> : null}
      {paseo.cloud ? <CloudChip provider={frameCloudProvider(paseo)} /> : null}
      {paseo.linked ? <span title="Imported conversations cannot get the board tools mid-session (Paseo limit). They get your changes as messages and answer in the sidebar." style={{ ...chip, background: B.peachSoft }}>imported</span> : null}
    </div>
  );
  const sharedItems = (
    <>
      <HistoryButton frameId={live.id} className="bfp-item" style={menuItem} />
      <FrameContentTools frame={live} />
      <button type="button" className="bfp-item" style={menuItem} data-testid="frame-archive" title="Take this frame and everything inside it off the board. Restore it from Board menu → Archive." onClick={() => { closeMenu(); archive.archive([live.id]); }}>
        <Emoji name="archive" /> Archive frame
      </button>
    </>
  );
  const errLine = err ? <div role="alert" style={{ color: B.danger, padding: "4px 10px", fontSize: 12 }}>{err}</div> : null;
  const menu = (items: React.ReactNode) =>
    menuOpen ? (
      <div role="menu" data-testid="frame-menu" className="bfp-pop" style={narrow ? { ...(docked ? menuUp : menuBase), left: 0, right: 0, width: "auto" } : docked ? menuUp : menuBase}>
        {chips}
        {items}
        {divider}
        <label className="bfp-item" title="When on, clicking a pinned frame also moves the camera to it. Off keeps the view still (good for recording)." style={{ ...menuItem, cursor: "pointer" }}>
          <input type="checkbox" role="menuitemcheckbox" aria-checked={jump} data-testid="pin-jump-toggle" checked={jump} onChange={(e) => setJump(e.target.checked)} />
          Jump to frame when switching
        </label>
        {docked && !inPin ? (
          <button type="button" className="bfp-item" data-testid="frame-panel-float" style={menuItem} onClick={() => { closeMenu(); setDock("float"); }}>
            ↖ Float near frame
          </button>
        ) : null}
      </div>
    ) : null;
  const shell = (children: React.ReactNode) => (
    <div
      ref={root}
      className="bunny-fp"
      style={inPin ? { ...panel, maxWidth: "100%", border: `1px solid ${B.violet}`, outline: "none" } : shift ? { ...panel, top: `calc(${typeof panel.top === "number" ? `${panel.top}px` : panel.top} + ${shift}px)` } : panel}
      data-testid="frame-panel"
      data-dock={inPin ? "pin" : dock}
      data-frame-id={live.id}
      tabIndex={inPin ? -1 : undefined}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <style>{BUNNY_CONTROLS_CSS}</style>
      {children}
    </div>
  );

  if (bound && !paseo.request) {
    const setDeltaMode = (m: string) => editor.updateShape<TLFrameShape>({ id: live.id, type: "frame", meta: { ...live.meta, paseo: { ...paseo, mode: m } } });
    const linked = !!paseo.linked;
    const restart = async () => {
      if (restartBusy.current || !capabilities.can("restartWithTools") || paseo.host) return;
      restartBusy.current = true;
      setRestarting(true);
      setErr(null);
      try {
        const r = await api<{ agentId: string; oldAgentId: string; archivedOld: boolean }>(`/api/ui/boards/${encodeURIComponent(boardId)}/frames/${encodeURIComponent(live.id)}/restart`, {
          method: "POST",
          body: JSON.stringify({ archiveOld }),
        });
        setMode("idle");
        setMenuOpen(false);
        ui.toast(`Restarted with board tools as a new agent${r.archivedOld ? "; the old conversation was archived" : "; the old conversation is still in Paseo"}.`);
        onOpen();
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        restartBusy.current = false;
        setRestarting(false);
      }
    };
    const busy = paseo.status === "running" || paseo.status === "needs-permission";
    return shell(
      <>
        {/* No "Open conversation": selecting the frame already opens it in the sidebar. */}
        {header(null)}
        {menu(
          <>
            {paseo.pendingDeltas ? (
              <button type="button" className="bfp-item" style={{ ...menuItem, color: B.orange, fontWeight: 600 }} onClick={() => editor.updateShape<TLFrameShape>({ id: live.id, type: "frame", meta: { ...live.meta, paseoFlushAt: Date.now() } })}>
                ↑ Send {paseo.pendingDeltas} change{paseo.pendingDeltas > 1 ? "s" : ""}
              </button>
            ) : null}
            <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "4px 10px" }}>
              <span style={fieldLabel}>Send changes</span>
              <select aria-label="When to send frame changes" title="Live sends automatically; manual waits for Send changes; on-demand lets the agent read queued changes." value={paseo.mode ?? "live"} onChange={(e) => setDeltaMode(e.target.value)}>
                <option value="live">Live (automatic)</option>
                {linked ? null : <option value="on-demand">On demand (agent reads)</option>}
                <option value="manual">Manual (I send)</option>
              </select>
            </label>
            {divider}
            {sharedItems}
            {divider}
            {linked && !paseo.host && capabilities.can("restartWithTools") && mode !== "restart" ? (
              <button
                type="button"
                className="bfp-item"
                style={menuItem}
                data-testid="restart-with-tools"
                disabled={busy}
                onClick={() => setMode("restart")}
                title={busy ? "The conversation is working; stop it or let it finish first" : "Start a fresh agent in the same workspace with the board tools, handing over this conversation's last message"}
              >
                Restart with board tools
              </button>
            ) : null}
            {mode === "restart" ? (
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "6px 10px" }}>
                <label style={{ display: "inline-flex", gap: 6, alignItems: "center", flex: "1 1 auto" }}>
                  <input type="checkbox" data-testid="restart-archive-old" checked={archiveOld} onChange={(e) => setArchiveOld(e.target.checked)} /> Archive the old one
                </label>
                <button type="button" style={softBtn} onClick={() => setMode("idle")} disabled={restarting}>
                  Cancel
                </button>
                <button type="button" className="bfp-primary" style={primaryBtn} data-testid="restart-go" disabled={restarting || !capabilities.can("restartWithTools")} onClick={() => void restart()}>
                  {restarting ? "Restarting…" : "Restart"}
                </button>
              </div>
            ) : null}
            {mode === "unbind" ? (
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "6px 10px" }}>
                <span style={{ flexBasis: "100%", fontSize: 12 }}>The conversation stays in Paseo; this becomes a plain frame.</span>
                <span style={{ flex: 1 }} />
                <button type="button" style={softBtn} onClick={() => setMode("idle")} disabled={unbinding}>
                  Cancel
                </button>
                <button
                  type="button"
                  style={{ ...primaryBtn, background: "#C2410C", borderColor: "light-dark(#C2410C, hsl(17 35% 39%))" }}
                  data-testid="unbind-go"
                  disabled={unbinding}
                  onClick={() => {
                    setUnbinding(true);
                    setErr(null);
                    api(`/api/ui/boards/${encodeURIComponent(boardId)}/frames/${encodeURIComponent(live.id)}/unbind`, { method: "POST", body: "{}" })
                      .then(() => {
                        setMode("idle");
                        setMenuOpen(false);
                        ui.toast("Unbound. The conversation is still in Paseo.");
                      })
                      .catch((e: Error) => setErr(e.message))
                      .finally(() => setUnbinding(false));
                  }}
                >
                  {unbinding ? "Unbinding…" : "Unbind"}
                </button>
              </div>
            ) : paseo.status !== "requested" ? (
              <button type="button" className="bfp-item bfp-danger" style={{ ...menuItem, color: B.danger }} data-testid="unbind" onClick={() => setMode("unbind")} title="Detach this frame from its conversation (the agent keeps running in Paseo)">
                Unbind
              </button>
            ) : null}
            {errLine}
          </>,
        )}
      </>,
    );
  }

  if (paseo.request) {
    return shell(
      <>
        {header(null)}
        {menu(sharedItems)}
        <StartingState requestedAt={paseo.request.requestedAt} error={paseo.error} retry={paseo.bindRetry} />
        {paseo.remoteStart && paseo.error ? <button type="button" data-testid="recheck-remote-start" style={softBtn} onClick={() => api("/api/ui/recheck-start",{method:"POST",body:JSON.stringify({boardId,frameId:live.id})}).catch(e=>setErr(e.message))}>Recheck same remote start</button> : null}
      </>,
    );
  }

  return shell(
    <>
      {header(
        mode === "start" ? null : (
          <button type="button" className="bfp-primary" style={primaryBtn} data-testid="start-conversation" onClick={() => (mobile ? askStartSheet(live.id) : setMode("start"))}>
            Start conversation
          </button>
        ),
      )}
      {menu(
        <>
          <button type="button" className="bfp-item" style={menuItem} data-testid="link-conversation" onClick={() => { setMenuOpen(false); ui.openPicker({ kind: "frame", frameId: live.id, frameName: live.props.name }); }}>
            Use existing conversation…
          </button>
          {divider}
          {sharedItems}
        </>,
      )}
      {paseo.relink?.requiresConfirmation === true && typeof paseo.relink.agentId === "string" ? <RelinkFrame key={`${boardId}:${live.id}:${paseo.relink.agentId}:${paseo.relink.host ?? "local"}`} editor={editor} frame={live} boardId={boardId} hint={paseo.relink} onOpen={onOpen} /> : null}
      {paseo.error ? <div role="alert" style={{ color: B.danger, fontSize: 12, paddingRight: 6 }}>Last attempt failed: {paseo.error}</div> : null}
      {mode === "start" && !mobile ? (
        <div data-testid="start-form" style={{ display: "flex", flexDirection: "column", gap: 12, padding: "12px 6px 2px 0", borderTop: `1px solid ${B.line}`, width: narrow ? "auto" : 440, maxWidth: "100%", boxSizing: "border-box" }}>
          <div data-testid="start-model-row" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", minWidth: 0 }}>
            <span style={{ ...fieldLabel, width: 84, flex: "none" }}>Model</span>
            <ModelPicker catalogue={catalogue} value={provider} onChange={setProvider} up={docked} />
          </div>
          <textarea
            data-testid="opening-line"
            style={{ width: "100%", display: "block", margin: 0 }}
            rows={3}
            aria-label="Opening message"
            placeholder="Opening message (optional)"
            value={line}
            onChange={(e) => setLine(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />
          {line.trim() ? null : <QuickStarts onPick={(s) => setLine(s.prompt)} />}
          <div data-testid="start-options-row" style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
            {/* One machine at a time, so a segmented choice (as in Paseo's new-agent form), not checkboxes. */}
            <div data-testid="start-runs-on-row" style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10, minWidth: 0 }}>
              <span data-testid="start-host-label" style={{display:"inline-flex",alignItems:"center",gap:2,whiteSpace:"nowrap",flexShrink:0,width:84}}><span style={fieldLabel} id={`runs-on-${live.id}`}>Runs on</span><button type="button" className="bfp-icon" style={{...iconBtn,width:24,height:24,fontSize:13,color:B.muted}} onClick={()=>setHostsRefresh(n=>n+1)} aria-label="Refresh machines" title="Refresh machines">↻</button></span>
              <div role="radiogroup" aria-labelledby={`runs-on-${live.id}`} aria-describedby={`start-identity-${live.id}`} data-testid="start-runs-on" className="bfp-seg" style={{ minWidth: 0 }}>
                <button type="button" role="radio" aria-checked={!startHost} data-testid="start-host-scope" title={`The board's Paseo runtime on ${runtimeMachine || "the board's Mac"}`} onClick={() => {setStartHost("");setCloud(cloud);}}>
                  {ephemeral ? "Upstash · ephemeral worker" : machineLabel(runtimeMachine, infoNow()?.boardHostname)}
                </button>
                {startHosts.map(h => <button key={h.host} type="button" role="radio" aria-checked={startHost===h.host} data-testid={`start-host-${h.host}`} disabled={!h.enabled} title={h.reason || `Run the agent on ${h.host}`} onClick={() => {setStartHost(h.host);setCloudState(false);try{localStorage.setItem("bunny:runs-on",`host:${h.host}`);}catch{}}}>{executionLabel(h.host)}</button>)}
              </div>
            </div>
            {!ephemeral && !startHost && cloud ? (
              <div data-testid="start-cloud-provider-row" style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10, minWidth: 0 }}>
                <span style={{ ...fieldLabel, width: 84, flex: "none" }} title="The cloud service that writes the code. The Model above is this frame's conversation, which conducts it.">Builder</span>
                <div role="radiogroup" aria-label="Cloud builder: who writes the code (not the Model above)" aria-describedby={cloudProvider === "codex" && codexReadiness?.ready === false ? `codex-hint-${live.id}` : undefined} data-testid="start-cloud-provider" className="bfp-seg">
                  {CLOUD_PROVIDERS.map((p) => (
                    <button key={p} type="button" role="radio" aria-checked={cloudProvider === p} data-testid={`start-cloud-provider-${p}`} onClick={() => setCloudProvider(p)}>
                      {CLOUD_PROVIDER_LABEL[p]}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {!ephemeral && !startHost && cloud && cloudProvider === "codex" && codexReadiness?.ready === false ? (
              <div id={`codex-hint-${live.id}`} data-testid="start-codex-hint" style={{ flexBasis: "100%", fontSize: 11, color: B.espresso, background: B.peachSoft, borderRadius: 8, padding: "4px 8px" }}>
                {codexReadiness.error || "Codex Cloud is not ready on this Mac. Run cloud-task doctor --provider codex for details."}
              </div>
            ) : null}
            {/* The selected machine already says where it runs; this summary is read out with the choice, not shown. */}
            <div id={`start-identity-${live.id}`} data-testid="start-identity" className="bfp-sr">{ephemeral ? (startHost ? `The agent runs on ${executionLabel(startHost)}.` : "The agent runs on an ephemeral Upstash worker. Your selected subscription is used.") : runsOnSummary({ machine: startHost || runtimeMachine, boardHost: infoNow()?.boardHostname, cloudProvider: !startHost && cloud ? cloudProvider : null })}</div>
            {startHosts.filter(h=>!h.enabled).map(h=><div key={h.host} data-testid="start-host-reason" style={{fontSize:11,color:B.muted,paddingLeft:94}}>{h.host}: {h.reason}</div>)}
            {hostsNote ? <div style={{flexBasis:"100%",fontSize:11}}>{hostsNote}</div> : null}
            {hostsLoading ? <div role="status" style={{flexBasis:"100%",fontSize:11}}>Refreshing hosts…</div> : null}
            {hostsError ? <div role="alert" style={{flexBasis:"100%",color:B.danger,fontSize:11}}>{hostsError}</div> : null}
          </div>
          <div data-testid="start-actions-row" style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, minWidth: 0 }}>
            {!ephemeral ? (
              <button type="button" role="switch" aria-checked={!startHost && cloud} data-testid="start-cloud" className="bfp-switch" title={`The agent runs on ${runtimeMachine || "the board's Mac"}; a cloud builder (Claude or Codex) writes the code, and this board only previews and deploys.`} onClick={() => {setStartHost("");setCloud(!(!startHost && cloud));}}>
                <span aria-hidden className="bfp-switch-track"><span className="bfp-switch-thumb" /></span>
                Cloud agent
              </button>
            ) : null}
            <span style={{ flex: 1 }} />
            <button type="button" style={softBtn} onClick={() => setMode("idle")}>
              Cancel
            </button>
            <button type="button" className="bfp-primary" style={primaryBtn} data-testid="start-go" disabled={!provider || (!!startHost && (!startHosts.some(h=>h.host===startHost && h.enabled)))} onClick={() => { if (!provider) return; recordOpeningPrompt(line); writeRequest({ kind: "create", provider, prompt: line || undefined, ...runsOnRequest(ephemeral ? false : cloud, cloudProvider, startHost) }); }}>
              Start
            </button>
          </div>
        </div>
      ) : null}
      {err ? <span style={{ color: B.danger }}>{err}</span> : null}
    </>,
  );
}

// Outline pin when unpinned, filled when pinned; drawn in currentColor so it keeps the theme's contrast.
function PinIcon({ filled }: { filled: boolean }) {
  return (
    <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 4h6l-1 5 3 3v2H7v-2l3-3-1-5z" />
      <path d="M12 14v6" />
    </svg>
  );
}

// The bound frame's cloud builder. A builder the canvas does not know is shown as such, not as Claude.
function CloudChip({ provider }: { provider: CloudProvider | null }) {
  const name = provider ? CLOUD_PROVIDER_LABEL[provider] : "unknown builder";
  const service = provider === "codex" ? "a Codex cloud task" : provider === "claude" ? "a Claude Code cloud session" : "an unknown cloud builder";
  return (
    <span data-testid="frame-cloud" data-cloud-provider={provider ?? "unknown"} title={`Code changes go to ${service} (skills/cloud-dev); this Mac only previews and deploys`} style={{ ...chip, background: B.lavenderSoft }}>
      ☁ {name} cloud
    </span>
  );
}

// The selected frame's title (its heading label) on screen, as a stable string key so the panel
// re-renders only when it actually moves. "" when the frame has no visible heading.
function headingScreenKey(editor: Editor, id: TLFrameShape["id"]): string {
  const shape = editor.getShape(id);
  if (!shape) return "";
  const geometry = editor.getShapeGeometry(shape) as { children?: { isLabel?: boolean; bounds: { corners: { x: number; y: number }[] } }[] };
  const label = geometry.children?.find((c) => c.isLabel);
  if (!label) return "";
  const t = editor.getShapePageTransform(shape);
  const pts = label.bounds.corners.map((p) => editor.pageToScreen(t.applyToPoint(p)));
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(Math.round).join(",");
}
function parseRectKey(key: string): ScreenRect | null {
  const [left, top, right, bottom] = key ? key.split(",").map(Number) : [];
  return key ? { left, top, right, bottom } : null;
}
