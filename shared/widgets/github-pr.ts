import { T } from "@tldraw/validate";
import type { WidgetManifest } from "./types";

export interface GitHubPrConfig { org: string; repositories: string; repo: string; number: string }
export interface GitHubPrData { title: string; repo: string; number: number; author: string; agent: string; state: "open" | "merged" | "closed"; url: string; checks: { name: string; state: string }[] }
const org = T.string.check(v => { if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(v)) throw Error("Use a GitHub organization name"); });
const repositories = T.string.check(v => { if (v && !v.split(",").every(s => /^[\w.-]+$/.test(s.trim()))) throw Error("Use comma-separated repository names"); });
export const githubPrWidget: WidgetManifest<GitHubPrConfig, GitHubPrData> = {
  id: "github-pr", label: "GitHub PR tracker", icon: "activity", version: "1.0.0",
  description: "Automatically place live pull request cards in agent frames or the PR inbox.",
  tagline: "Every agent’s pull requests, together on the board.",
  about: "Polls GitHub every five minutes by default, only while a board has a tracker control. Repository discovery is cached for one hour; conditional requests reuse unchanged results, and low quota pauses polling until reset. Each pull request gets one live card with author, CI checks and open, merged or closed state. Session and branch links place cards in the agent’s frame; unmatched requests go to PR inbox.",
  whyItMatters: "Keep track of pull requests opened by multiple coding agents without checking each session.",
  category: "Development", permissions: [{ kind: "network", text: "Reads repositories, pull requests and CI checks through the board host’s GitHub CLI credentials." }, { kind: "board", text: "Creates a PR inbox and deduplicated PR cards; matches cloud session and branch links to frames." }],
  media: [
    { kind: "image", src: "/plugin-media/github-pr/open.png", caption: "Synthetic GitHub fixture on a real board: a linked agent PR and an unmatched PR in the inbox, discovered after 59 seconds." },
    { kind: "image", src: "/plugin-media/github-pr/merged.png", caption: "The same agent PR card after GitHub reports it merged (synthetic REST fixture)." },
    { kind: "video", src: "/plugin-media/github-pr/clip.webm", poster: "/plugin-media/github-pr/open.png", caption: "Live open-to-merged update on the board recorded with the former 60-second polling interval; synthetic PR data." },
  ], size: { w: 360, h: 240 }, staleMs: 660000,
  fields: [
    { key: "org", label: "GitHub organization", kind: "text", required: true },
    { key: "repositories", label: "Repositories", kind: "text", help: "Comma-separated names; blank watches the entire organization." },
    { key: "repo", label: "PR repository", kind: "text", help: "Set automatically on PR cards." },
    { key: "number", label: "PR number", kind: "text", help: "Set automatically on PR cards." },
  ],
  configProps: { org, repositories, repo: T.string.check(v => { if (v && !/^[\w.-]+\/[\w.-]+$/.test(v)) throw Error("Use owner/repo"); }), number: T.string.check(v => { if (v && !/^[1-9]\d*$/.test(v)) throw Error("Use a positive PR number"); }) },
  defaults: () => ({ org: "automate-friday", repositories: "", repo: "", number: "" }),
  configured: c => !!c.org,
  summary: (c, s) => s?.data ? `${s.data.repo}#${s.data.number}` : c.repo ? `${c.repo}#${c.number}` : c.org,
  describe: (c, s) => s?.data ? `${s.data.title} · ${s.data.agent || s.data.author} · ${s.data.state} · ${s.data.checks.map(x => `${x.name}: ${x.state}`).join(", ") || "No checks"}` : `Watching ${c.org}${c.repositories ? "/" + c.repositories : ""}`,
};
