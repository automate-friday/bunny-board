import { remoteStatusLabel } from "../../shared/remote-status";
import {startHostsMemo,watchStartHosts} from "./startHosts";
import { initialRunsOn, runsOnRequest, fleetHostsForRuntime } from "../../shared/conversation-links";
import { StartingState } from "./StartingState";
import { useAgentCapabilities } from "./agentCapabilities";
import { RelinkFrame } from "./RelinkFrame";
import { useContext, useEffect, useRef, useState } from "react";
import { type TLFrameShape, useEditor, useValue } from "tldraw";
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
import { addPin, removePin, usePanelDock, usePinJump, usePins } from "./framePanelDock";
import { Dot } from "./Dot";
import { B, BUNNY_CONTROLS_CSS, DOT, chip, fieldLabel, iconBtn, menuItem, primaryBtn, softBtn, surface } from "./bunnyTheme";
import { FALLBACK_PROVIDERS, fallbackCatalogue, initialChoice, type StartCatalogue } from "../../shared/start-catalogue";
import { CLOUD_PROVIDERS, CLOUD_PROVIDER_LABEL, frameCloudProvider, type CloudProvider } from "../../shared/cloud-provider";
import { infoNow } from "./info";
import { MobileCtx } from "./mobile/mobileMode";
import { askStartSheet } from "./mobile/StartSheet";

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
  maxWidth: "min(560px, 94vw)",
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
const dockedPanel: React.CSSProperties = { ...panelBase, position: "relative", top: "auto", left: "auto", transform: "none", zIndex: 1, maxWidth: "min(560px, calc(100vw - 110px))" };
const dockedPanelNarrow: React.CSSProperties = { ...dockedPanel, maxWidth: "calc(100vw - 32px)" };

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
  const [startHost, setStartHost] = useState(() => {try{const saved=localStorage.getItem("bunny:runs-on");return saved?.startsWith("host:")?saved.slice(5):"";}catch{return "";}});
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
  const liveStatus = bound ? displayStatus(hostView, paseo.boundAt, paseo.status, paseo.subagents, paseo.cloudSessions, paseo.host) : "";
  const statusKey = bound ? (paused ? "paused" : liveStatus) : paseo.status === "error" ? "error" : paseo.request ? "requested" : "unbound";
  const statusText = bound
    ? `${remoteStatusLabel(hostView?.remote ?? (paseo.host ? {host:paseo.host,polledAt:null} : undefined),statusLabel(liveStatus, subagentCount(hostView, paseo.subagents)))}${paused ? ` · paused${paseo.pendingDeltas ? `, ${paseo.pendingDeltas} queued` : ""}` : ""}`
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
      <b title={name} style={{ font: "600 14px Inter, system-ui, sans-serif", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: "1 1 auto", maxWidth: narrow ? "none" : 240 }}>{name}</b>
      {primary}
      <button
        type="button"
        className="bfp-icon"
        data-testid="frame-pin"
        aria-pressed={pinned}
        title={pinned ? "Unpin this frame" : "Pin this frame for quick switching"}
        aria-label={pinned ? `Unpin ${name}` : `Pin ${name}`}
        style={{ ...iconBtn, fontSize: 14, background: pinned ? B.lavenderSoft : "transparent", filter: pinned ? "none" : "grayscale(1) opacity(.55)" }}
        onClick={() => setPins(pinned ? removePin(pins, live.id) : addPin(pins, live.id))}
      >
        📌
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
      {bound ? <span style={{ ...chip, background: "#fff", border: `1px solid ${B.line}` }}><HostConnectionBadge view={hostView} /></span> : null}
      {bound && paused ? <span data-testid="frame-paused" title="Board agents are paused; frame changes wait until they resume" style={{ ...chip, background: "#FFF0CC", color: B.espresso }}>⏸ paused{paseo.pendingDeltas ? ` · ${paseo.pendingDeltas} queued` : ""}</span> : null}
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
      style={inPin ? { ...panel, maxWidth: "100%", border: `1px solid ${B.violet}`, outline: "none" } : panel}
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
                  style={{ ...primaryBtn, background: B.danger, borderColor: B.danger }}
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
        <div data-testid="start-form" style={{ display: "flex", flexDirection: "column", gap: 10, padding: "10px 6px 2px 0", borderTop: `1px solid ${B.line}`, width: narrow ? "auto" : 440, maxWidth: "100%", boxSizing: "border-box" }}>
          <div data-testid="start-model-row" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", minWidth: 0 }}>
            <span style={{ ...fieldLabel, minWidth: 48 }}>Model</span>
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
          <div data-testid="start-options-row" style={{ display: "flex", alignItems: "center", columnGap: 14, rowGap: 8, flexWrap: "wrap", minWidth: 0 }}>
            <div role="group" aria-label="Runs on" data-testid="start-runs-on" style={{ display: "inline-flex", flexWrap: "wrap", alignItems: "center", gap: 4, flexBasis: "100%", minWidth: 0 }}>
              <span data-testid="start-host-label" style={{display:"inline-flex",alignItems:"center",gap:4,whiteSpace:"nowrap",flexShrink:0}}><span style={fieldLabel}>Runs on</span><button type="button" style={{...iconBtn,width:28,height:28}} onClick={()=>setHostsRefresh(n=>n+1)} aria-label="Refresh hosts">↻</button></span>
              <button type="button" data-testid="start-host-scope" aria-pressed={!startHost && !cloud} onClick={() => {setStartHost("");setCloud(false);}} style={{ ...softBtn, background: !startHost && !cloud ? B.lavenderSoft : "#fff" }} title="Start on the configured Paseo runtime">{infoNow()?.runtimeHostname || "this Mac"}</button>
              {startHosts.map(h => <button key={h.host} type="button" data-testid={`start-host-${h.host}`} aria-pressed={startHost===h.host} disabled={!h.enabled} title={h.reason || `Start on ${h.host}`} onClick={() => {setStartHost(h.host);setCloudState(false);try{localStorage.setItem("bunny:runs-on",`host:${h.host}`);}catch{}}} style={{...softBtn,background:startHost===h.host?B.lavenderSoft:"#fff"}}>{h.host}</button>)}
              <button type="button" data-testid="start-cloud" aria-pressed={!startHost && cloud} onClick={() => {setStartHost("");setCloud(true);}} style={{ ...softBtn, background: !startHost && cloud ? B.lavenderSoft : "#fff" }}>Ephemeral worker</button>
            </div>
            {!startHost && cloud ? (
              <div role="radiogroup" aria-label="Cloud builder: who writes the code (not the Model above)" aria-describedby={cloudProvider === "codex" && codexReadiness?.ready === false ? `codex-hint-${live.id}` : undefined} data-testid="start-cloud-provider" style={{ display: "inline-flex", alignItems: "center", gap: 10, flexWrap: "wrap", flexBasis: "100%" }}>
                <span style={fieldLabel} title="The cloud service that writes the code. The Model above is this frame's conversation, which conducts it.">Cloud builder</span>
                {CLOUD_PROVIDERS.map((p) => (
                  <label key={p} style={{ display: "inline-flex", gap: 5, alignItems: "center", cursor: "pointer", whiteSpace: "nowrap" }}>
                    <input type="radio" name={`cloud-provider-${live.id}`} value={p} data-testid={`start-cloud-provider-${p}`} checked={cloudProvider === p} onChange={() => setCloudProvider(p)} />
                    {CLOUD_PROVIDER_LABEL[p]}
                  </label>
                ))}
              </div>
            ) : null}
            {!startHost && cloud && cloudProvider === "codex" && codexReadiness?.ready === false ? (
              <div id={`codex-hint-${live.id}`} data-testid="start-codex-hint" style={{ flexBasis: "100%", fontSize: 11, color: B.espresso, background: B.peachSoft, borderRadius: 8, padding: "4px 8px" }}>
                {codexReadiness.error || "Codex Cloud is not ready on this Mac. Run cloud-task doctor --provider codex for details."}
              </div>
            ) : null}
            <div data-testid="start-identity" style={{flexBasis:"100%",fontSize:11,color:B.espresso}}>Board: {infoNow()?.boardHostname || infoNow()?.machine || "unknown"} · Agent runs on: {startHost || (cloud ? "Ephemeral worker" : infoNow()?.runtimeHostname || "this Mac")}</div>
            {startHosts.filter(h=>!h.enabled).map(h=><div key={h.host} data-testid="start-host-reason" style={{flexBasis:"100%",fontSize:11}}>{h.host}: {h.reason}</div>)}
            {hostsNote ? <div style={{flexBasis:"100%",fontSize:11}}>{hostsNote}</div> : null}
            {hostsLoading ? <div role="status" style={{flexBasis:"100%",fontSize:11}}>Refreshing hosts…</div> : null}
            {hostsError ? <div role="alert" style={{flexBasis:"100%",color:B.danger,fontSize:11}}>{hostsError}</div> : null}
          </div>
          <div data-testid="start-actions-row" style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <span style={{ flex: 1 }} />
            <button type="button" style={softBtn} onClick={() => setMode("idle")}>
              Cancel
            </button>
            <button type="button" className="bfp-primary" style={primaryBtn} data-testid="start-go" disabled={!provider || (!!startHost && (!startHosts.some(h=>h.host===startHost && h.enabled)))} onClick={() => provider && writeRequest({ kind: "create", provider, prompt: line || undefined, ...runsOnRequest(cloud, cloudProvider, startHost) })}>
              Start
            </button>
          </div>
        </div>
      ) : null}
      {err ? <span style={{ color: B.danger }}>{err}</span> : null}
    </>,
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
