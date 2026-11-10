// Is a frame's agent start still under way? A remote start can take minutes: the host
// creates the agent, then the opener is sent, and until then the host may answer
// "agent not found" and the board may not count the agent as bound yet. While it is
// pending, the board says "starting" and keeps retrying; it never calls the agent missing
// or its controls unavailable. It stops being pending when the start completes, or when
// it failed (the frame's status is then "error" with the reason).
export type StartMeta = { status?: string; request?: unknown; remoteStart?: { phase?: string } | null } | null | undefined;

export function startPending(p: StartMeta): boolean {
  if (!p || p.status === "error") return false;
  if (p.request) return true;
  return !!p.remoteStart && p.remoteStart.phase !== "complete";
}

// While the start is pending, what the agent's view says does not count until it reports a
// real status: no view yet, refused (denied), "not found", an error (the host's "Agent not
// found"), or a remote agent not read yet or read too long ago all mean "starting".
export function startingView(view: { status?: string; denied?: boolean; remote?: unknown } | null | undefined, remoteHost: string | null | undefined, stale: boolean): boolean {
  return !view || !!view.denied || view.status === "missing" || view.status === "error" || (!!remoteHost && !view.remote) || stale;
}
