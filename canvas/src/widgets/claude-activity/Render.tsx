// "Claude Code activity" widget body: the session's subagents and background processes,
// each with its status, elapsed time and last line, as read from the session's events by
// the board server (server/cloud-sessions.ts). When the events do not carry task events the
// widget says so instead of showing an empty list.

import { useEffect, useState } from "react";
import type { ActivityItem, ClaudeActivityData } from "../../../../shared/widgets/claude-activity";
import type { WidgetBodyProps } from "../registry";

const STATUS: Record<ActivityItem["status"], { text: string; color: string }> = {
  running: { text: "running", color: "#2f80ed" },
  done: { text: "done", color: "#27ae60" },
  failed: { text: "failed", color: "#eb5757" },
  stopped: { text: "stopped", color: "#9e9e9e" },
  exited: { text: "exited", color: "#27ae60" },
};

function elapsed(i: ActivityItem, now: number): string {
  const a = i.startedAt ? Date.parse(i.startedAt) : NaN;
  if (!Number.isFinite(a)) return "";
  const b = i.endedAt ? Date.parse(i.endedAt) : now;
  const s = Math.max(0, Math.round((b - a) / 1000));
  return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
}

function statusText(i: ActivityItem): string {
  if (i.status === "exited") return i.exitCode === null ? "exited" : `exited ${i.exitCode}`;
  return STATUS[i.status].text;
}

function Row({ i, now }: { i: ActivityItem; now: number }) {
  const failed = i.status === "failed" || (i.status === "exited" && !!i.exitCode);
  const color = failed ? "#eb5757" : STATUS[i.status].color;
  return (
    <div data-testid="activity-row" data-kind={i.kind} data-status={i.status} data-exit={i.exitCode ?? ""} style={{ display: "flex", flexDirection: "column", gap: 1, padding: "4px 0", borderTop: "1px solid #eef" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span className={i.status === "running" ? "cloud-session-pulse" : undefined} style={{ width: 8, height: 8, borderRadius: 4, background: color, flexShrink: 0 }} />
        <span style={{ fontWeight: 600, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: i.kind === "subagent" ? undefined : "ui-monospace, monospace", fontSize: i.kind === "subagent" ? 12 : 11 }} title={i.name}>
          {i.name}
        </span>
        <span style={{ color, fontWeight: 600, whiteSpace: "nowrap" }}>{statusText(i)}</span>
        <span style={{ color: "#889", fontVariantNumeric: "tabular-nums", minWidth: 28, textAlign: "right" }}>{elapsed(i, now)}</span>
      </div>
      {i.lastLine || i.detail ? (
        <div style={{ color: "#667", fontSize: 11, paddingLeft: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={i.lastLine || i.detail}>
          {i.lastLine || i.detail}
        </div>
      ) : null}
    </div>
  );
}

function Section({ title, items, none, now, testid }: { title: string; items: ActivityItem[]; none: string; now: number; testid: string }) {
  const running = items.filter((i) => i.status === "running").length;
  return (
    <div data-testid={testid} style={{ display: "flex", flexDirection: "column" }}>
      <div style={{ fontWeight: 650, color: "#334", padding: "2px 0" }}>
        {title} <span style={{ color: "#889", fontWeight: 500 }}>{items.length ? `${items.length}${running ? ` · ${running} running` : ""}` : ""}</span>
      </div>
      {items.length ? [...items].reverse().map((i) => <Row key={i.id} i={i} now={now} />) : <div style={{ color: "#889", fontSize: 11, paddingBottom: 4 }}>{none}</div>}
    </div>
  );
}

export function ClaudeActivityBody({ state }: WidgetBodyProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const d = state?.data as ClaudeActivityData | null;
  if (!d) return <div style={{ color: "#778", padding: 12 }}>{state?.status === "error" ? state.reason : "Reading the session's events…"}</div>;
  if (!d.available)
    return (
      <div data-testid="activity-unavailable" style={{ color: "#a55", padding: 12, lineHeight: 1.4 }}>
        Subagents and background processes are not available: {d.reason}.
      </div>
    );
  return (
    <div data-testid="activity-body" style={{ padding: "4px 12px 8px", display: "flex", flexDirection: "column", gap: 6, font: "12px system-ui, sans-serif", overflowY: "auto", height: "100%", boxSizing: "border-box", pointerEvents: "all" }} onWheel={(e) => e.stopPropagation()}>
      <Section testid="activity-subagents" title="Subagents" items={d.subagents} none="none in the session's events" now={now} />
      <Section testid="activity-processes" title="Background processes" items={d.processes} none="none in the session's events" now={now} />
      <div style={{ color: "#99a", fontSize: 10 }}>
        from {d.scanned} event{d.scanned === 1 ? "" : "s"}{d.complete ? " (the whole session)" : " (the newest; older ones not read)"} · read {new Date(d.readAt).toLocaleTimeString()}
      </div>
      <style>{"@keyframes cloudSessionPulse{0%,100%{opacity:1}50%{opacity:.35}}.cloud-session-pulse{animation:cloudSessionPulse 1.6s ease-in-out infinite}"}</style>
    </div>
  );
}
