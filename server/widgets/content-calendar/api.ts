// Postiz public API wire shapes (Postiz v2.25.3, apps/backend/src/public-api/routes/v1/
// public.integrations.controller.ts and the posts repository it calls). Base path
// `<backend>/public/v1`; a self-hosted Docker install serves the backend under `/api`,
// so the public API is `<host>/api/public/v1`. Auth: the raw API key in the
// Authorization header (no "Bearer"); a missing or wrong key is HTTP 401 {msg}.
//
//   GET /is-connected                     -> {connected: true}
//   GET /integrations[?group=<customer>]  -> PostizIntegration[]
//   GET /posts?startDate=<ISO>&endDate=<ISO>[&customer=<id>]
//                                         -> {posts: PostizPost[]}  (publishDate in [start, end],
//                                            plus repeating posts expanded to each occurrence)
//   bad dates                             -> HTTP 400 {statusCode, message: string[], error}

export type PostizState = "QUEUE" | "PUBLISHED" | "ERROR" | "DRAFT";
export const POSTIZ_STATES: PostizState[] = ["QUEUE", "PUBLISHED", "ERROR", "DRAFT"];

export interface PostizIntegration {
  id: string;
  name: string;
  identifier: string;
  picture: string | null;
  disabled: boolean;
  profile: string | null;
  customer?: { id: string; name: string };
}

export interface PostizPost {
  id: string;
  // HTML.
  content: string;
  publishDate: string;
  releaseURL: string | null;
  releaseId: string | null;
  state: PostizState;
  error: string | null;
  intervalInDays: number | null;
  group: string;
  creationMethod?: string;
  settings?: string | null;
  tags: Array<{ tag: { id?: string; name: string; color?: string } }>;
  integration: { id: string; providerIdentifier: string; name: string; picture: string | null };
  // A repeating post's occurrence: the original publishDate.
  actualDate?: string;
}

// The three ways a read fails, as the widget names them.
export type PostizErrorCode = "invalid_key" | "postiz_unreachable" | "bad_request";

export class PostizApiError extends Error {
  constructor(
    readonly code: PostizErrorCode,
    readonly detail: string,
    readonly status?: number,
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}
