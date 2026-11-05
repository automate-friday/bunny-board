import { remoteStatusLabel } from "../../../../shared/remote-status";
import { PaseoLink, usePaseoLink } from "../../PaseoLink";
import {TranscriptAvailability} from "../../TranscriptAvailability";
import { HostConnectionBadge } from "../../HostConnectionBadge";
import { Emoji } from "../../Emoji";
import { BoardUiCtx } from "../../ui";
import { useAgentCapabilities } from "../../agentCapabilities";
import { RemoteCoverage } from "../../RemoteCoverage";
// Renderer for a transcript card. Everything live (title, status, rows) comes from the
// shared agent store, never from the shape, so streaming never writes the document.

import { MessageBody } from "../../MessageBody";
import { ChatComposer } from "../../ChatComposer";
import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useEditor, useValue } from "tldraw";
import { primerLabel } from "../../../../shared/components/transcript";
import { StatusMark } from "../../Dot";
import { agentStore, boundFrameIndex, cancelAgent, displayStatus, STATUS_DOT, statusLabel, subagentCount, useAgentView, usePageVisible } from "../../agents";
import { useViewState } from "../../viewState";
import type { TranscriptShape } from "./shape";
import type { TranscriptRow } from "../../../../shared/components/transcript";
import { hasItemView, stop as stopDown, TimelineItemView, ToolGroupView } from "../../TimelineItemView";
import { dedupeItemRows, groupRows, rowKey } from "../../timelineItems";
import { useAgentControls } from "../../useAgentControls";
import { AgentLiveStats } from "../../AgentControlsBar";
import { PermissionCards } from "../../PermissionCards";

const ROW_STYLE: Record<string, React.CSSProperties> = {
  user: { background: "#eef4ff", borderLeft: "3px solid #2f80ed" },
  assistant: { background: "#ffffff", borderLeft: "3px solid #27ae60" },
  tool: { color: "#666", fontFamily: "ui-monospace, monospace", fontSize: 11, background: "transparent" },
  "plugin:board-delta": { background: "#fff8e6", borderLeft: "3px solid #f2994a" },
  error: { color: "#c00", background: "#fff0f0" },
  notice: { color: "#666", background: "transparent" },
};

// Not "real" rows for the compact card's last three (reasoning, todos, compaction markers).
const COMPACT_SKIP = new Set(["notice", "reasoning", "todo", "compaction"]);

const LABEL: Record<string, string> = { user: "you / board", assistant: "agent", "plugin:board-delta": "board delta" };

const btn: React.CSSProperties = {
  pointerEvents: "all",
  border: "1px solid #ccc",
  background: "#fff",
  borderRadius: 5,
  padding: "1px 6px",
  font: "11px system-ui, sans-serif",
  cursor: "pointer",
  color: "#333",
  textDecoration: "none",
  whiteSpace: "nowrap",
};

export function TranscriptRender({ shape }: { shape: TranscriptShape }) {
  const editor = useEditor();
  const ui = useContext(BoardUiCtx);
  const { agentId } = shape.props;
  // Full/Compact and Follow are this viewer's choice (localStorage), not the document's.
  const [{ mode, follow }, setView] = useViewState(shape.id, { mode: shape.props.mode, follow: shape.props.follow });
  const pageVisible=usePageVisible();
  const onScreen=useValue("transcript-visible",()=>!editor.getCulledShapes().has(shape.id),[editor,shape.id]);
  const visible=pageVisible&&onScreen;
  const view = useAgentView(agentId,visible);
  // One shared index of bound frames for every card (not a scan of the page per card).
  const bound = useValue("transcript-bound-frame", () => boundFrameIndex(editor).get().get(agentId) ?? null, [editor, agentId]);
  const frameTitle = useValue("transcript-frame-title", () => {
    const frame = bound?.frameId ? editor.getShape(bound.frameId as import("tldraw").TLShapeId) : undefined;
    return frame?.type === "frame" ? frame.props.name : "";
  }, [editor,bound?.frameId]);
  const conversationTitle = view?.title || frameTitle || `agent ${agentId.slice(0,8)}`;
  const [, tick] = useState(0);
  const status = displayStatus(view, bound?.boundAt, bound?.status, bound?.subagents, bound?.cloudSessions, bound?.host);
  const label = statusLabel(status, subagentCount(view, bound?.subagents));
  // Re-evaluate "starting" once the 30 s grace runs out.
  useEffect(() => {
    if (status !== "starting") return;
    const t = setTimeout(() => tick((n) => n + 1), 5000);
    return () => clearTimeout(t);
  });
  const capabilities = useAgentCapabilities(visible?agentId:undefined, bound?.frameId);
  const paseoLink = usePaseoLink({ agentId, remoteHost: bound?.host ?? view?.remote?.host, snapshotUrl: view?.paseoUrl, capabilities: capabilities.value });
  const [stopping, setStopping] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const rows = dedupeItemRows(view?.rows ?? []);
  // Consecutive tool calls fold into one summary badge (running calls stay visible).
  // Compact keeps the last 3 real rows or groups; a silent "seen" to a delta is not one.
  const units = groupRows(mode === "compact" ? rows.filter((r) => !COMPACT_SKIP.has(r.kind) && !r.ack) : rows, status === "running");
  const shown = mode === "compact" ? units.slice(-3).reverse() : units;
  const controls = useAgentControls(agentId, status, visible && !!view && !view.remote && view.status !== "missing" && view.availability!=="not-loaded");
  const exactRoute = capabilities.can("exactTimeline");

  useLayoutEffect(() => {
    if (!body.current) return;
    if (mode === "compact") body.current.scrollTop = 0;
    else if (follow) body.current.scrollTop = body.current.scrollHeight;
  }, [mode, follow, rows]);

  // Let the wheel scroll the log in full mode instead of panning the canvas
  // (ctrl/cmd + wheel still zooms).
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey && el.scrollHeight > el.clientHeight) e.stopPropagation();
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    return () => el.removeEventListener("wheel", onWheel);
  }, [mode]);

  // Mode only: resizing here would reach the frame's agent as a human resize.
  const toggleMode = () => setView({ mode: mode === "compact" ? "full" : "compact" });
  const stop = async () => {
    if (!capabilities.can("stop") || view?.remote) return;
    setStopping(true);
    setErr(null);
    try {
      await cancelAgent(agentId);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setStopping(false);
    }
  };
  const busy = status === "running" || status === "needs-permission";

  // One row of the log. Rows with a Paseo timeline item render as collapsed badges that
  // expand inline; others keep the kind/text rendering.
  const renderRow = (r: TranscriptRow) => {
    const item = hasItemView(r);
    return (
      <div
        data-kind={r.kind}
        style={{
          padding: item ? "2px 6px" : "4px 6px",
          borderRadius: 5,
          whiteSpace: item ? "normal" : "pre-wrap",
          wordBreak: "break-word",
          flexShrink: 0,
          minWidth: 0,
          ...(item && r.item?.type !== "assistant_message" ? {} : (ROW_STYLE[r.kind] ?? {})),
        }}
      >
        {LABEL[r.kind] && !r.ack ? <span style={{ fontSize: 10, color: "#888", marginRight: 4 }}>{LABEL[r.kind]}</span> : null}
        {item ? (
          <TimelineItemView row={r} ctx={{ agentId, compact: true, exact: exactRoute }} />
        ) : r.ack ? (
          <span data-testid="transcript-ack" style={{ color: "#888", fontSize: 11 }} title={`The agent acknowledged the change without replying ("${r.text}")`}>
            <Emoji name="check" /> seen
          </span>
        ) : r.primer ? (
          <span data-testid="transcript-primer" style={{ color: "#666", fontStyle: "italic" }}>
            {primerLabel(r)}
          </span>
        ) : r.kind === "tool" ? (
          <><Emoji name="gear" /> {`${r.text}${r.status && r.status !== "completed" ? ` (${r.status})` : ""}`}</>
        ) : (
          <MessageBody text={r.text} compact={mode === "compact"} />
        )}
      </div>
    );
  };

  return (
    <div
      onPointerEnter={()=>agentStore.prefetch(agentId)}
      onPointerDown={()=>agentStore.prefetch(agentId,true)}
      data-testid="transcript-card"
      data-mode={mode}
      data-agent-id={agentId}
      data-status={status}
      data-rows={rows.length}
      className="tl-compact"
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "#fbfbfa",
        border: `2px solid ${STATUS_DOT[status] ?? "#ccc"}`,
        borderRadius: 10,
        boxShadow: "0 2px 10px rgba(0,0,0,0.10)",
        overflow: "hidden",
        font: "12px system-ui, sans-serif",
        color: "#222",
      }}
    >
      <TranscriptAvailability view={view}/>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, padding: "6px 8px", borderBottom: "1px solid #e4e4e4", background: "#fff", flexShrink: 0 }}>
        <StatusMark status={status} color={STATUS_DOT[status] ?? "#ccc"} title={label} />
        <span data-testid="transcript-title" title={`${conversationTitle} · ${agentId}`} style={{ fontWeight: 600, flex: "1 1 120px", minWidth: 120, overflowWrap: "anywhere" }}>
          {conversationTitle}
          <small data-testid="transcript-identity" style={{display:"block",fontWeight:400,color:"#666"}}>Conversation {agentId.slice(0, 8)}</small>
        </span>
        <HostConnectionBadge view={view}/>
        <span data-testid="transcript-status" style={{ color: "#777", fontSize: 11, whiteSpace: "nowrap" }}>
          {remoteStatusLabel(view?.remote ?? (bound?.host ? {host:bound.host,polledAt:null} : undefined),label)}
          {view && !view.remote ? <AgentLiveStats view={view} status={status} /> : null}
        </span>
        {busy && !view?.remote && capabilities.can("stop") ? (
          <button type="button" data-testid="transcript-stop" style={{ ...btn, borderColor: "#eb5757", color: "#c62828" }} onPointerDown={stopDown} onClick={() => void stop()} disabled={stopping}>
            {stopping ? "Stopping…" : "Stop"}
          </button>
        ) : null}
        {bound ? (
          // Pop out: the same conversation in the sidebar, without moving the camera.
          <button type="button" data-testid="transcript-conversation" style={btn} onPointerDown={stopDown} onClick={() => ui.openConversation(bound.frameId)} title="Open this conversation in the sidebar">
            Open in sidebar ⇥
          </button>
        ) : null}
        <PaseoLink link={paseoLink} testId="transcript-open" style={btn} onPointerDown={stopDown} />
        <button type="button" data-testid="transcript-mode" style={btn} onPointerDown={stopDown} onClick={toggleMode} title="Compact shows the last 3 rows; full scrolls the whole recent log">
          {mode === "compact" ? "Full" : "Compact"}
        </button>
        {mode === "full" ? (
          <button type="button" data-testid="transcript-follow" style={{ ...btn, background: follow ? "#eef4ff" : "#fff" }} onPointerDown={stopDown} onClick={() => setView({ follow: !follow })} title="Auto-scroll to the newest row">
            {follow ? "Following" : "Follow"}
          </button>
        ) : null}
      </div>
      {view?.remote ? <RemoteCoverage view={view} /> : null}
      <div
        ref={body}
        data-testid="transcript-body"
        style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 6, display: "flex", flexDirection: "column", gap: 4, pointerEvents: "all", justifyContent: "flex-start" }}
      >
        {shown.length === 0 ? (
          <div style={{ color: "#999", padding: 4 }}>{status === "starting" ? "Starting the agent…" : view?.error && status === "missing" ? view.error : view ? "No messages yet." : "Connecting…"}</div>
        ) : null}
        {shown.map((u, i) =>
          u.kind === "group" ? (
            <div key={`group:${u.id}`} style={{ padding: "2px 6px", flexShrink: 0 }}>
              <ToolGroupView unit={u} renderRow={renderRow} />
            </div>
          ) : (
            <div key={rowKey(u.row, i)} style={{ display: "contents" }}>{renderRow(u.row)}</div>
          ),
        )}
      </div>
      {mode === "compact" ? <div data-testid="transcript-coverage" style={{ padding: "4px 8px", fontSize: 10, color: "#666", flexShrink: 0 }}>Latest {shown.length} rows, newest first · scroll for more · Full opens the recent log</div> : null}
      {err ? <div style={{ color: "#c00", padding: "2px 8px", fontSize: 11 }}>{err}</div> : null}
      {!view?.remote ? <PermissionCards state={controls} paseoLink={paseoLink} compact /> : null}
      <ChatComposer agentId={agentId} view={view} status={status} canPrompt={capabilities.can("prompt")} unavailable={capabilities.error} compact placeholder={`Reply to ${conversationTitle}…`} />
    </div>
  );
}
