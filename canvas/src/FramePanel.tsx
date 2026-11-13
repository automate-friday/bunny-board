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
import { clearOfHeading, type ScreenRect, usePanelDock } from "./framePanelDock";
import { rememberFrameStart } from "./jumpPaletteModel";
import { Dot } from "./Dot";
import { B, BUNNY_CONTROLS_CSS, DOT, chip, fieldLabel, iconBtn, menuItem, primaryBtn, softBtn, surface } from "./bunnyTheme";
import { FALLBACK_PROVIDERS, effortFor, fallbackCatalogue, rememberedChoice, type StartCatalogue, withCustomModels } from "../../shared/start-catalogue";
import { addCustomModel, customModels, lastStartChoice, rememberStartChoice } from "./startChoice";
import { CLOUD_PROVIDERS, CLOUD_PROVIDER_LABEL, frameCloudProvider, type CloudProvider } from "../../shared/cloud-provider";
import { infoNow } from "./info";
import { MobileCtx } from "./mobile/mobileMode";
import { askStartSheet } from "./mobile/StartSheet";
import { SuggestField, useQuickStartData } from "./QuickStarts";
import { recordOpeningPrompt, takePendingPrompt } from "./quickStartPrompts";
import { modEnterHint, modEnterSubmits } from "./submitShortcut";

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

// Docked pill and docked panel sit in the bottom dock row (DockRow.tsx, next to the
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
// action for unbound frames, ⋯ for everything else). It floats near the top or docks
// bottom-right (minimizable to a pill). Pinning lives in the frame tabs (FrameTabs.tsx).
export function FramePanel({ frame, boardId, onOpen }: { frame: TLFrameShape; boardId: string; onOpen: () => void }) {
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
  const docked = dock !== "float";
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
  // Keys pressed in the panel are the panel's, never canvas shortcuts (Backspace on a focused
  // button must not delete the frame). Esc still reaches the canvas, which deselects as
  // before. Native listener on the panel: tldraw listens on its container, which React's own
  // handlers only see afterwards.
  useEffect(() => {
    const panelEl = root.current;
    if (!panelEl) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return;
      e.stopPropagation();
      // Tab in the empty opening message takes the first suggestion (React never sees this key).
      if (e.key === "Tab" && !e.shiftKey && firstIdea && !line && (e.target as HTMLElement | null)?.dataset?.testid === "opening-line") {
        e.preventDefault();
        setLine(firstIdea);
      }
      // ⌘↵ / Ctrl+↵ in the start form is the Start button; plain Enter stays a new line. Not
      // inside the model/effort popovers (a typed custom model would be dropped) and not on
      // another button (Cancel, a quick-start card), which keep their own meaning.
      const t = e.target as HTMLElement | null;
      if (modEnterSubmits(e) && t?.closest?.('[data-testid="start-form"]') && !t.closest('[data-testid="provider-menu"], [data-testid="effort-menu"]') && (t.tagName !== "BUTTON" || t.dataset.testid === "start-go")) {
        e.preventDefault();
        launch();
      }
    };
    panelEl.addEventListener("keydown", onKey);
    return () => panelEl.removeEventListener("keydown", onKey);
  });
  // A frame the phone shell's Start agent just drew opens straight on the start form.
  const [mode, setMode] = useState<"idle" | "start">(() => (startRequested.delete(frame.id) ? "start" : "idle"));
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
  const [catalogue, setCatalogue] = useState<StartCatalogue | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  // Reasoning effort (Paseo thinkingOptionId); null is the model's default.
  const [effort, setEffort] = useState<string | null>(null);
  // Model ids typed into the picker, remembered on this device.
  const [custom, setCustom] = useState(customModels);
  const [line, setLine] = useState("");
  // Next-step suggestions sit inside the message box while it is empty and the frame has not
  // been renamed since the form opened (naming it is the person saying what they want).
  const quick = useQuickStartData({ editor, frameId: frame.id, active: mode === "start" && !mobile });
  const nameAtOpen = useRef(frame.props.name);
  useEffect(() => { if (mode === "start") nameAtOpen.current = frame.props.name; }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps
  const suggesting = mode === "start" && !mobile && !line.trim() && frame.props.name === nameAtOpen.current;
  const firstIdea = suggesting ? quick.cards[0]?.prompt : undefined;
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
          // The model and effort last started from this device, when still offered.
          setProvider((p) => {
            if (p) return p;
            const r = rememberedChoice(withCustomModels(c, customModels()), lastStartChoice());
            setEffort(r.effort);
            return r.provider;
          });
        });
    const t = setTimeout(load, catalogue ? 5000 : 0);
    return () => {
      gone = true;
      clearTimeout(t);
    };
  }, [mode, catalogue, loadingHarness]);

  const closeMenu = () => {
    setMenuOpen(false);
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
  const shownCatalogue = catalogue ? withCustomModels(catalogue, custom) : null;
  const by = window.__board?.userName ?? "User";
  const name = live.props.name || "Frame";

  const writeRequest = (request: Record<string, unknown>) => {
    // Starting counts as your first message (frame tabs' Recent puts it at the top).
    rememberFrameStart(live.id);
    editor.updateShape<TLFrameShape>({
      id: live.id,
      type: "frame",
      props: { color: "violet" },
      meta: { ...live.meta, paseo: JSON.parse(JSON.stringify({ ...paseo, request: { ...request, requestedAt: Date.now(), by }, status: "requested", error: undefined })) },
    });
    setMode("idle");
    onOpen();
  };

  // Start (button or ⌘↵): one request; the frame's request is written synchronously, so a
  // second press before the form closes finds it and does nothing.
  const startDisabled = !provider || (!!startHost && !startHosts.some((h) => h.host === startHost && h.enabled));
  const launch = () => {
    // biome-ignore lint/suspicious/noExplicitAny: meta JSON.
    if (!provider || startDisabled || (editor.getShape(live.id)?.meta as any)?.paseo?.request) return;
    recordOpeningPrompt(line);
    rememberStartChoice({ provider, effort });
    writeRequest({ kind: "create", provider, ...(effort ? { thinkingOptionId: effort } : {}), prompt: line || undefined, ...runsOnRequest(ephemeral ? false : cloud, cloudProvider, startHost) });
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

  if (dock === "pill") {
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
        data-testid="frame-more"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title="More: send mode, history, frame tools, archive, unbind"
        style={{ ...iconBtn, position: "relative", background: menuOpen ? B.hover : "transparent" }}
        onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}
      >
        ⋯{needsLook ? <span aria-hidden style={{ position: "absolute", top: 4, right: 4, width: 7, height: 7, borderRadius: 4, background: B.orange }} /> : null}
      </button>
      <button type="button" className="bfp-icon" data-testid="frame-panel-minimize" title={docked ? "Collapse to the pill" : "Minimize to the corner"} aria-label="Minimize frame panel" style={iconBtn} onClick={() => { closeMenu(); setDock("pill"); }}>
        –
      </button>
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
        {docked ? divider : null}
        {docked ? (
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
      style={shift ? { ...panel, top: `calc(${typeof panel.top === "number" ? `${panel.top}px` : panel.top} + ${shift}px)` } : panel}
      data-testid="frame-panel"
      data-dock={dock}
      data-frame-id={live.id}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <style>{BUNNY_CONTROLS_CSS}</style>
      {children}
    </div>
  );

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
            <ModelPicker
              catalogue={shownCatalogue}
              value={provider}
              effort={effort}
              up={docked}
              onChange={(v) => {
                const e = effortFor(shownCatalogue, v, effort);
                setProvider(v);
                setEffort(e);
                rememberStartChoice({ provider: v, effort: e });
              }}
              onEffort={(e) => {
                setEffort(e);
                rememberStartChoice({ provider, effort: e });
              }}
              onCustom={(v) => {
                setCustom(addCustomModel(v));
                setProvider(v);
                rememberStartChoice({ provider: v, effort });
              }}
            />
          </div>
          <SuggestField data={quick} show={suggesting} onPick={(s) => setLine(s.prompt)}>
            {(minHeight) => (
              <textarea
                data-testid="opening-line"
                style={{ width: "100%", display: "block", margin: 0, minHeight }}
                rows={3}
                aria-label="Opening message"
                placeholder="Opening message (optional)"
                value={line}
                onChange={(e) => setLine(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
              />
            )}
          </SuggestField>
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
            <button type="button" className="bfp-primary" style={primaryBtn} data-testid="start-go" disabled={startDisabled} aria-label="Start" aria-keyshortcuts="Meta+Enter Control+Enter" data-kbd={modEnterHint()} onClick={launch}>
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
