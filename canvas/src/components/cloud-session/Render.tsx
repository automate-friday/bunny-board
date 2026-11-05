// Renderer for a cloud session card: who builds (Claude Code / Codex), the task, the live
// state with its dot, the PR and its checks once there is one, the last activity, and
// buttons that open the session page and the PR. Everything shown comes from the shape;
// the board server updates it (server/cloud-sessions.ts).

import { useEffect, useRef, useState } from "react";
import { useEditor, useValue } from "tldraw";
import { CLOUD_STATE_TEXT, type CloudState, cloudAgo, isActive, prText } from "../../../../shared/components/cloud-session";
import { Emoji } from "../../Emoji";
import type { CloudSessionShape } from "./shape";

const stopDown = (e: React.PointerEvent) => e.stopPropagation();

export const CLOUD_STATE_COLOR: Record<CloudState, string> = {
  starting: "#9b51e0",
  working: "#2f80ed",
  waiting: "#f2994a",
  idle: "#27ae60",
  unknown: "#9e9e9e",
  ended: "#9e9e9e",
  pr: "#2f80ed",
  merged: "#8250df",
  closed: "#9e9e9e",
  failed: "#eb5757",
};

// Re-render once a minute so "3 min ago" moves without a document change.
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

const button = (primary: boolean): React.CSSProperties => ({
  pointerEvents: "all",
  border: `1px solid ${primary ? "#2f80ed" : "#b9c6dd"}`,
  background: primary ? "#2f80ed" : "#fff",
  color: primary ? "#fff" : "#223",
  borderRadius: 6,
  padding: "3px 10px",
  textDecoration: "none",
  fontWeight: 600,
  whiteSpace: "nowrap",
});

// Opening the session (or clicking the card) means a message to it is likely: ask the board to
// poll this card every few seconds for a while (server/cloud-sessions.ts burst). At most once
// every 20 s per card from this tab.
function useBurst(cardId: string): () => void {
  const last = useRef(0);
  return () => {
    if (Date.now() - last.current < 20_000) return;
    last.current = Date.now();
    const board = new URLSearchParams(window.location.search).get("board") || "main";
    void fetch("/api/ui/cloud-sessions/burst", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ board, id: cardId }) }).catch(() => {});
  };
}

function PrLink({ url, n }: { url: string; n: number }) {
  return (
    <a data-testid="cloud-session-pr" href={url} target="_blank" rel="noreferrer" onPointerDown={stopDown} style={{ ...button(false), padding: "1px 8px", marginLeft: "auto" }} title={url}>
      PR #{n}
    </a>
  );
}

export function CloudSessionRender({ shape }: { shape: CloudSessionShape }) {
  const p = shape.props;
  const now = useMinute();
  const burst = useBurst(shape.id);
  // A click on the card selects it (the canvas takes the pointer, not this HTML): burst then.
  const editor = useEditor();
  const selected = useValue("cloud-card-selected", () => editor.getSelectedShapeIds().includes(shape.id), [editor, shape.id]);
  useEffect(() => {
    if (selected) burst();
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps
  const state = p.state;
  const color = CLOUD_STATE_COLOR[state] ?? "#8aa9d6";
  const who = p.provider === "codex" ? "Codex cloud" : "Claude Code cloud";
  // Codex cards still take their headline from the PR; Claude cards from the session itself,
  // with the PR on a line of its own.
  let line = CLOUD_STATE_TEXT[state] ?? state;
  if (state === "pr" || state === "merged" || state === "closed") line = prText(p) || line;
  const pr = p.pr && state !== "pr" && state !== "merged" && state !== "closed" ? prText(p) : "";
  const detail = p.detail;
  const live = isActive(state);
  return (
    <div
      data-testid="cloud-session-card"
      data-session={p.session}
      data-state={state}
      data-pr={p.pr || ""}
      data-session-status={p.sessionStatus}
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        gap: 4,
        padding: "9px 12px",
        boxSizing: "border-box",
        background: "#f8f7ff",
        border: `2px solid ${color}`,
        borderRadius: 10,
        boxShadow: "0 2px 10px rgba(0,0,0,0.08)",
        font: "12px system-ui, sans-serif",
        color: "#223",
        overflow: "hidden",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 17, color: "#d97757" }}>
          <Emoji name="cloud" />
        </span>
        <span style={{ fontWeight: 650, fontSize: 13, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{who}</span>
        <a data-testid="cloud-session-open" href={p.url} target="_blank" rel="noreferrer" onPointerDown={(e) => { stopDown(e); burst(); }} onClick={burst} style={button(true)} title={p.url}>
          Open session
        </a>
      </div>
      <div data-testid="cloud-session-title" style={{ fontSize: 13, color: "#334", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={p.title}>
        {p.title || p.session}
      </div>
      <div data-testid="cloud-session-status" style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600, color: "#223", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        <span className={live ? "cloud-session-pulse" : undefined} style={{ width: 9, height: 9, borderRadius: 5, background: color, flexShrink: 0 }} />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{line}</span>
        {p.prUrl && !pr ? <PrLink url={p.prUrl} n={p.pr} /> : null}
      </div>
      {pr ? (
        <div data-testid="cloud-session-pr-line" data-pr-state={p.prState} style={{ display: "flex", alignItems: "center", gap: 6, color: "#334", whiteSpace: "nowrap", overflow: "hidden" }}>
          <span style={{ width: 9, height: 9, borderRadius: 5, background: p.prState === "merged" ? "#8250df" : p.prState === "closed" ? "#9e9e9e" : p.checksFail ? "#eb5757" : "#27ae60", flexShrink: 0 }} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{pr}</span>
          {p.prUrl ? <PrLink url={p.prUrl} n={p.pr} /> : null}
        </div>
      ) : null}
      {p.message ? (
        <div data-testid="cloud-session-message" style={{ color: "#334", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontStyle: "italic" }} title={p.message}>
          <span style={{ fontStyle: "normal", fontWeight: 600, color: "#556" }}>{p.messageRole === "user" ? "You: " : "Claude: "}</span>
          {p.message}
        </div>
      ) : null}
      <div data-testid="cloud-session-activity" style={{ color: "#667", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={detail}>
        {detail && state !== "pr" ? `${detail} · ` : ""}last activity {cloudAgo(p.activityAt, now)}
      </div>
      <style>{"@keyframes cloudSessionPulse{0%,100%{opacity:1}50%{opacity:.35}}.cloud-session-pulse{animation:cloudSessionPulse 1.6s ease-in-out infinite}"}</style>
    </div>
  );
}
