// The slice of Slack's public Web API and Socket Mode the Slack widget uses, as
// documented on docs.slack.dev. Shapes here are what both the in-process mock
// (./mock) and the real API return; only the fields the widget reads are typed.

export interface SlackChannel {
  id: string;
  name: string;
  is_channel: boolean;
  is_group: boolean;
  is_im: boolean;
  is_private: boolean;
  is_archived: boolean;
  is_general: boolean;
  is_member: boolean;
  created: number;
  creator: string;
  name_normalized: string;
  num_members?: number;
  topic: { value: string; creator: string; last_set: number };
  purpose: { value: string; creator: string; last_set: number };
}

export interface SlackMessage {
  type: "message";
  subtype?: string;
  ts: string;
  user?: string;
  bot_id?: string;
  text?: string;
  thread_ts?: string;
  parent_user_id?: string;
  reply_count?: number;
  reply_users_count?: number;
  latest_reply?: string;
  reply_users?: string[];
  hidden?: boolean;
  // message_changed / message_replied carry the updated message here.
  message?: SlackMessage;
  channel?: string;
  event_ts?: string;
  channel_type?: string;
  client_msg_id?: string;
}

export interface SlackUser {
  id: string;
  team_id: string;
  name: string;
  deleted: boolean;
  real_name?: string;
  is_bot: boolean;
  profile: { display_name: string; real_name: string; image_48?: string };
}

export interface AuthTest {
  url: string;
  team: string;
  user: string;
  team_id: string;
  user_id: string;
  bot_id?: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string;
  hasMore?: boolean;
}

// Socket Mode envelope payload for events_api.
export interface EventCallback {
  token: string;
  team_id: string;
  api_app_id: string;
  event: SlackMessage & { type: string };
  type: "event_callback";
  event_id: string;
  event_time: number;
}

export type SocketFrame =
  | { type: "hello"; num_connections: number; debug_info: { host: string; approximate_connection_time?: number }; connection_info: { app_id: string } }
  | { type: "disconnect"; reason: "warning" | "refresh_requested" | "link_disabled"; debug_info: { host: string } }
  | { type: "events_api"; envelope_id: string; payload: EventCallback; accepts_response_payload: boolean; retry_attempt: number; retry_reason: string };

// A Web API error ({ok:false,error}) or HTTP 429.
export class SlackApiError extends Error {
  constructor(
    readonly code: string,
    readonly method: string,
    readonly extra: { retryAfter?: number; needed?: string; provided?: string; status?: number } = {},
  ) {
    super(`${method}: ${code}${extra.needed ? ` (needs ${extra.needed})` : ""}${extra.retryAfter !== undefined ? ` (retry after ${extra.retryAfter}s)` : ""}`);
  }
}

// Errors that will not fix themselves by retrying: the widget goes red.
export const FATAL_SLACK_ERRORS = new Set([
  "invalid_auth",
  "not_authed",
  "token_revoked",
  "token_expired",
  "account_inactive",
  "missing_scope",
  "channel_not_found",
  "not_in_channel",
  "thread_not_found",
  "not_allowed_token_type",
  "user_not_found",
  "no_text",
  "invalid_cursor",
]);
