import { remoteFreshness } from "./RemoteCoverage";
import { MessageBody } from "./MessageBody";
import type { AgentView } from "./agents";

function excerpt(text: string, max = 220): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

// A deterministic overview of observed work. Never invent a task, result or next step.
export function ConversationOverview({ view, status, boundAt, now, open, onToggle, mobile = false }: {
  view: AgentView | null; status: string; boundAt?: number; now: number;
  open: boolean; onToggle: () => void; mobile?: boolean;
}) {
  const rows = view?.rows ?? [];
  const request = rows.findLast((r) => r.kind === "user");
  const reply = rows.findLast((r) => r.kind === "assistant" && !r.ack && r.text.trim());
  const tool = rows.findLast((r) => r.kind === "tool");
  const error = rows.findLast((r) => r.kind === "error");
  const at = view?.remote ? view.remote.polledAt : view?.updatedAt;
  const age = at ? Math.max(0, Math.floor((now - at) / 1000)) : null;
  const stale = view?.remote ? remoteFreshness(view, now).stale : age === null || age > 60;
  const waiting = (status === "starting" || status === "running" || status === "loading") && !reply;
  const elapsed = boundAt ? Math.max(0, Math.floor((now - boundAt) / 1000)) : null;
  return <section data-testid="conversation-overview" aria-label="Conversation overview" style={{ padding: "10px 12px", borderBottom: "1px solid #ddd", background: "#fff", overflowWrap: "anywhere" }}>
    <strong>Overview</strong>
    <div style={{ color: "#666", fontSize: 11 }}>Message excerpts, shortened for overview; expand the log for received detail.</div>
    {status === "needs-permission" ? <div role="alert" data-testid="permission-alert" style={{ color: "#9c4b00", fontWeight: 600 }}>{view?.remote ? `Last poll reported a permission request.${stale ? " Current status unknown; check the owning host." : " Check the owning host."}` : "Permission needed — answer in Paseo before work can continue."}</div> : null}
    {status === "error" || view?.error || error ? <div role="alert" style={{ color: "#b00020" }}>{view?.error || (error ? `Recorded error: ${error.text}` : "") || "Agent reported an error. Open the log for details."}</div> : null}
    {request ? <p style={{ margin: "6px 0" }}><b>Latest request: </b>{excerpt(request.text || "Board opening prompt")}</p> : null}
    {reply ? <div style={{ margin: "6px 0", maxHeight: mobile ? undefined : 220, overflowY: mobile ? "visible" : "auto" }}><b>Latest reply: </b><MessageBody text={reply.text} /></div> : null}
    {tool ? <p style={{ margin: "6px 0", fontSize: 12 }}><b>Last tool: </b>{excerpt(tool.text, 120)}{tool.status ? ` · ${tool.status}` : ""}</p> : null}
    {waiting ? <div data-testid="first-reply-wait">{view?.remote ? `No reply in cached messages.${stale ? " Current status unknown." : " Waiting for the next poll."}` : <>Waiting for first reply{elapsed !== null ? ` · ${elapsed}s since binding` : ""}. No reply received yet.</>}</div> : null}
    <div data-testid="timeline-freshness" style={{ marginTop: 6, fontSize: 11, color: stale ? "#9c4b00" : "#666" }}>
      {view?.remote ? "Remote, message-only coverage; tool detail unavailable. " : "Local timeline. "}
      {age === null ? "First snapshot pending." : `Last snapshot ${age}s ago${stale ? " · stale; current status unknown" : ""}.`}
    </div>
    <button type="button" data-testid="toggle-timeline" aria-expanded={open} onClick={onToggle} style={{ marginTop: 8, padding: "5px 8px", cursor: "pointer" }}>{open ? "Collapse log" : `Inspect sent text and tools (${rows.length} recent rows)`}</button>
  </section>;
}
