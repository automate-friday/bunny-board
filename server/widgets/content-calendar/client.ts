// PostizClient: the read-only Postiz public API calls the content calendar needs. One
// implementation (PostizHttpClient) speaks the wire format over a transport:
// MockPostizClient runs it over the in-process mock (./mock) and LivePostizClient over
// fetch against a real Postiz. Both pass the same contract suite (test/postiz-contract.ts),
// so the mock is held to Postiz's shapes. There is deliberately no write method.

import { PostizApiError, type PostizIntegration, type PostizPost } from "./api";
import type { MockPostiz } from "./mock";

export interface HttpReply {
  status: number;
  // Raw body text; Postiz answers JSON, a proxy or a wrong path may not.
  text: string;
}

export interface PostizTransport {
  // path is relative to the public API base, e.g. "/posts".
  get(path: string, query: Record<string, string>, apiKey: string): Promise<HttpReply>;
}

export interface PostizClient {
  readonly kind: "mock" | "live";
  isConnected(): Promise<{ connected: boolean }>;
  integrations(): Promise<PostizIntegration[]>;
  posts(q: { startDate: string; endDate: string; customer?: string }): Promise<PostizPost[]>;
}

function parse(r: HttpReply, path: string): unknown {
  let body: unknown;
  try {
    body = JSON.parse(r.text);
  } catch {
    body = undefined;
  }
  if (r.status === 401 || r.status === 403) {
    const msg = (body as { msg?: string; message?: string } | undefined)?.msg ?? (body as { message?: string } | undefined)?.message ?? "";
    throw new PostizApiError("invalid_key", String(msg || `HTTP ${r.status}`), r.status);
  }
  if (r.status === 400) {
    const m = (body as { message?: unknown } | undefined)?.message;
    throw new PostizApiError("bad_request", Array.isArray(m) ? m.join("; ") : String(m ?? "HTTP 400"), 400);
  }
  if (r.status < 200 || r.status >= 300) throw new PostizApiError("postiz_unreachable", `HTTP ${r.status} from ${path}`, r.status);
  if (body === undefined) throw new PostizApiError("postiz_unreachable", `${path} did not answer JSON (is the URL the Postiz backend?)`, r.status);
  return body;
}

export class PostizHttpClient implements PostizClient {
  constructor(
    readonly kind: "mock" | "live",
    private readonly apiKey: string,
    private readonly transport: PostizTransport,
  ) {}

  private async get(path: string, query: Record<string, string> = {}): Promise<unknown> {
    let r: HttpReply;
    try {
      r = await this.transport.get(path, query, this.apiKey);
    } catch (e) {
      if (e instanceof PostizApiError) throw e;
      const err = e as Error & { cause?: { code?: string } };
      throw new PostizApiError("postiz_unreachable", err.cause?.code ?? (err.name === "TimeoutError" || err.name === "AbortError" ? "timeout" : err.message));
    }
    return parse(r, path);
  }

  async isConnected(): Promise<{ connected: boolean }> {
    const b = (await this.get("/is-connected")) as { connected?: boolean };
    return { connected: !!b?.connected };
  }

  async integrations(): Promise<PostizIntegration[]> {
    const b = await this.get("/integrations");
    if (!Array.isArray(b)) throw new PostizApiError("postiz_unreachable", "/integrations did not answer a list");
    return b as PostizIntegration[];
  }

  async posts(q: { startDate: string; endDate: string; customer?: string }): Promise<PostizPost[]> {
    const b = (await this.get("/posts", { startDate: q.startDate, endDate: q.endDate, ...(q.customer ? { customer: q.customer } : {}) })) as { posts?: unknown };
    if (!Array.isArray(b?.posts)) throw new PostizApiError("postiz_unreachable", "/posts did not answer {posts: [...]}");
    return b.posts as PostizPost[];
  }
}

export class MockPostizClient extends PostizHttpClient {
  constructor(mock: MockPostiz, apiKey = "mock-valid") {
    super("mock", apiKey, { get: (path, query, key) => mock.request(path, query, key) });
  }
}

// Where the public API lives under a Postiz URL. A Docker install serves the backend at
// /api (so <url>/api/public/v1); a bare backend serves /public/v1. An explicit
// .../public/v1 is used as given.
export function publicApiCandidates(url: string): string[] {
  const u = url.replace(/\/+$/, "");
  if (/\/public\/v1$/.test(u)) return [u];
  if (/\/api$/.test(u)) return [`${u}/public/v1`];
  return [`${u}/api/public/v1`, `${u}/public/v1`];
}

export interface LiveOptions {
  timeoutMs?: number;
  fetch?: typeof fetch;
}

// Live transport: plain fetch, a timeout per request, and the first candidate base that
// answers JSON on /is-connected (200, or 401 for a wrong key) is kept.
export class LivePostizClient extends PostizHttpClient {
  constructor(url: string, apiKey: string, opts: LiveOptions = {}) {
    const doFetch = opts.fetch ?? fetch;
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const candidates = publicApiCandidates(url);
    let base: string | null = candidates.length === 1 ? candidates[0] : null;
    const raw = async (b: string, path: string, query: Record<string, string>, key: string): Promise<HttpReply> => {
      const q = new URLSearchParams(query).toString();
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const res = await doFetch(`${b}${path}${q ? `?${q}` : ""}`, { headers: { authorization: key, accept: "application/json" }, signal: ac.signal });
        return { status: res.status, text: await res.text() };
      } catch (e) {
        if (ac.signal.aborted) throw new PostizApiError("postiz_unreachable", `timeout (${Math.round(timeoutMs / 1000)}s)`);
        throw e;
      } finally {
        clearTimeout(timer);
      }
    };
    const isJson = (r: HttpReply) => {
      try {
        JSON.parse(r.text);
        return true;
      } catch {
        return false;
      }
    };
    super("live", apiKey, {
      async get(path, query, key) {
        if (!base) {
          let last: HttpReply | null = null;
          for (const c of candidates) {
            const r = await raw(c, "/is-connected", {}, key);
            if ((r.status === 200 || r.status === 401) && isJson(r)) {
              base = c;
              break;
            }
            last = r;
          }
          if (!base) throw new PostizApiError("postiz_unreachable", `no Postiz public API at this URL (HTTP ${last?.status ?? "?"})`, last?.status);
        }
        return raw(base, path, query, key);
      },
    });
  }
}
