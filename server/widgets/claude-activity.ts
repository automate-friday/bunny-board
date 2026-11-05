// "Claude Code activity" widget data source: a thin adapter over CloudSessions, which reads
// the session's task events together with its cloud session card (same 60 s / 3 s burst
// polling, server/cloud-sessions.ts). Nothing here polls on its own.

import type { ClaudeActivityConfig } from "../../shared/widgets/claude-activity";
import type { CloudSessions } from "../cloud-sessions";
import type { WidgetSource } from "./types";

export function claudeActivitySource(cloud: Pick<CloudSessions, "watchActivity">): WidgetSource<ClaudeActivityConfig> {
  return {
    id: "claude-activity",
    watch(config, emit) {
      emit({ status: "connecting" });
      return cloud.watchActivity(config.session, (u) => {
        if (u.ok) emit({ status: "live", data: u.data, ...(u.data.available ? {} : { reason: u.data.reason }) });
        else emit({ status: "error", reason: u.reason });
      });
    },
  };
}
