// Renderer for a board link card: the target board's name, the frame's name and live
// status, and an Open button with the deep link (same tab; ⌘/Ctrl-click for a new one).

import { STATUS_DOT, statusLabel } from "../../agents";
import { deepLink, usePublicBase } from "../../info";
import type { LinkShape } from "./shape";
import { useLinkTarget } from "./targets";
import { Emoji } from "../../Emoji";

const stopDown = (e: React.PointerEvent) => e.stopPropagation();

export function LinkRender({ shape }: { shape: LinkShape }) {
  const { board, frameId, title } = shape.props;
  const base = usePublicBase();
  const { target, error } = useLinkTarget(board, frameId);
  const here = new URLSearchParams(window.location.search).get("board") || "main";
  const href = deepLink(base, board, frameId || null);
  const frame = target?.frame;
  const status = frame?.agentId ? (frame.status ?? "idle") : null;
  const statusKey = status === "requested" ? "starting" : status === "idle" && frame?.subagents ? "subagents" : status;
  let line: string;
  if (error && !target) line = `cannot load: ${error}`;
  else if (!target) line = "loading…";
  else if (!target.exists) line = "new board (opening it creates it)";
  else if (!frameId) line = `whole board · ${target.boundFrames ?? 0}/${target.frames ?? 0} frames bound`;
  else if (!frame) line = "that frame is gone";
  else line = `frame “${frame.name || "unnamed"}” · ${statusKey ? statusLabel(statusKey, frame?.subagents) : "not bound"}`;
  return (
    <div
      data-testid="link-card"
      data-board={board}
      data-frame={frameId}
      data-status={status ?? ""}
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 4,
        padding: "8px 12px",
        boxSizing: "border-box",
        background: "light-dark(#f7f9ff, var(--bunny-surface))",
        border: `2px solid ${statusKey ? (STATUS_DOT[statusKey] ?? "light-dark(#8aa9d6, hsl(216 35% 39%))") : "light-dark(#8aa9d6, hsl(216 35% 39%))"}`,
        borderRadius: 10,
        boxShadow: "0 2px 10px rgba(0,0,0,0.08)",
        font: "12px system-ui, sans-serif",
        color: "light-dark(#223, var(--bunny-ink))",
        overflow: "hidden",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 16 }}><Emoji name="open" /></span>
        <span style={{ fontWeight: 650, fontSize: 14, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} data-testid="link-title">
          {title || (board === here ? "This board" : `Board ${board}`)}
        </span>
        <a
          data-testid="link-open"
          href={href}
          onPointerDown={stopDown}
          style={{ pointerEvents: "all", border: "1px solid light-dark(#2f80ed, hsl(214 35% 39%))", background: "#2f80ed", color: "#fff", borderRadius: 6, padding: "3px 10px", textDecoration: "none", fontWeight: 600 }}
          title={href}
        >
          Open
        </a>
      </div>
      {title || board === here ? <div style={{ color: "light-dark(#556, var(--bunny-muted))", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title ? `board ${board}` : "on this board"}</div> : null}
      <div data-testid="link-status" style={{ display: "flex", alignItems: "center", gap: 6, color: "light-dark(#445, var(--bunny-muted))", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {statusKey ? <span style={{ width: 8, height: 8, borderRadius: 4, background: STATUS_DOT[statusKey] ?? "light-dark(#ccc, var(--bunny-raised))", flexShrink: 0 }} /> : null}
        {line}
      </div>
    </div>
  );
}
