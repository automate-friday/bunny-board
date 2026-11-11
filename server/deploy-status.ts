import { readFileSync } from "node:fs";

// What the operator's board-deploy last reported for this production host (tools/board-deploy/vps.mjs
// writes <state>/deploy-status.json every tick). Merged is not deployed: live is the commit serving now.
export const DEPLOY_STATUS_STALE_MS = 5 * 60 * 1000;

export function readDeployStatus(file: string, now = Date.now()) {
  let s: any;
  try { s = JSON.parse(readFileSync(file, "utf8")); }
  catch { return { state: "unknown", main: null, live: null, reason: "No deploy report on this host (only the operator's VPS production has one)", at: null, stale: true }; }
  const at = typeof s.at === "string" ? s.at : null;
  const stale = !at || !(now - Date.parse(at) < DEPLOY_STATUS_STALE_MS);
  return {
    state: stale ? "unknown" : s.state, main: s.main ?? null, live: s.live ?? null,
    reason: stale ? `Deploy job has not reported since ${at ?? "ever"}; last state ${s.state}${s.reason ? `: ${s.reason}` : ""}` : s.reason ?? null,
    at, stale,
  };
}
