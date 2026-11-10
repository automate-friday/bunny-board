import type { GitHubPrData } from "../../../../shared/widgets/github-pr";
import type { WidgetBodyProps } from "../registry";
export function GitHubPrBody({ config, state }: WidgetBodyProps) {
  const pr = state?.data as GitHubPrData | null;
  const notice = state?.reason ? <p role="status" data-testid="github-pr-poll-status">{state.reason}</p> : null;
  if (!pr) return <div style={{ padding: 16 }}>Watching <b>{config.org}</b>{config.repositories ? ` / ${config.repositories}` : " repositories"}{notice ?? <p>New pull requests appear in their agent’s frame or PR inbox. Refreshes every five minutes by default.</p>}</div>;
  return <div data-testid="github-pr-card" style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: 9, fontSize: 14, overflow: "auto", height: "100%", boxSizing: "border-box" }}>
    {notice}
    <a href={pr.url} target="_blank" rel="noopener noreferrer" onPointerDown={e => e.stopPropagation()} style={{ color: "light-dark(#345fc0, hsl(222 57% 74%))", fontWeight: 650 }}>{pr.title}</a>
    <div>{pr.repo}#{pr.number}</div>
    <div>{pr.agent ? `${pr.agent} · ` : ""}@{pr.author}</div>
    <strong style={{ color: pr.state === "merged" ? "light-dark(#8250df, hsl(261 69% 74%))" : pr.state === "closed" ? "light-dark(#cf222e, hsl(356 72% 74%))" : "light-dark(#1a7f37, hsl(137 66% 74%))" }}>{pr.state.toUpperCase()}</strong>
    <div>{pr.checks.length ? pr.checks.map((c, i) => <div key={`${c.name}-${i}`}>{c.name}: {c.state}</div>) : "No CI checks reported"}</div>
  </div>;
}
