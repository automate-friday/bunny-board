// Optional HTTP basic auth for the whole board (canvas, UI API, assets, SSE, websocket).
// Turned on by BUNNYBOARD_AUTH_USERNAME and BUNNYBOARD_AUTH_PASSWORD together; one
// without the other is a configuration error and the board refuses to start. Neither set
// keeps the tailnet-only posture. Agents keep using their frame bearer token on
// /api/agent/... only; that route is checked by checkFrameToken, not by this gate.
// See docs/AUTH.md.

import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export type BasicAuth = { username: string; password: string };

export const REALM = "Bunnyboard";

export class AuthConfigError extends Error {}

export function loadBasicAuth(env: NodeJS.ProcessEnv = process.env): BasicAuth | null {
  const username = env.BUNNYBOARD_AUTH_USERNAME;
  const password = env.BUNNYBOARD_AUTH_PASSWORD;
  // Off only when both are absent. Present but empty (BUNNYBOARD_AUTH_PASSWORD= in an
  // env file) is a mistake, not a request to turn auth off.
  if (username === undefined && password === undefined) return null;
  // Names only, never values: this message reaches the log.
  if (!username || !password) throw new AuthConfigError("basic auth is half configured: set both BUNNYBOARD_AUTH_USERNAME and BUNNYBOARD_AUTH_PASSWORD, or neither");
  if (username.includes(":")) throw new AuthConfigError("BUNNYBOARD_AUTH_USERNAME must not contain ':'");
  return { username, password };
}

// Hash both sides first so the comparison takes the same time whatever the lengths.
function same(a: string, b: string): boolean {
  const h = (s: string) => createHash("sha256").update(s, "utf8").digest();
  return timingSafeEqual(h(a), h(b));
}

// True when the Authorization header carries the configured Basic credentials. Anything
// else (absent, another scheme, bad base64, no colon) is false; nothing is thrown.
export function basicAuthOk(auth: BasicAuth, header: string | string[] | undefined): boolean {
  if (typeof header !== "string") return false;
  const m = header.match(/^Basic[ ]+([A-Za-z0-9+/]+={0,2})[ ]*$/i);
  if (!m) return false;
  const decoded = Buffer.from(m[1], "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 0) return false;
  const userOk = same(decoded.slice(0, colon), auth.username);
  const passOk = same(decoded.slice(colon + 1), auth.password);
  return userOk && passOk;
}

export function requestAuthorized(auth: BasicAuth | null, req: IncomingMessage): boolean {
  return !auth || basicAuthOk(auth, req.headers.authorization);
}

export const CHALLENGE = `Basic realm="${REALM}", charset="UTF-8"`;
