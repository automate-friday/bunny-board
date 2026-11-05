import type { PluginClientContext } from "@getpaseo/plugin/client";
import { DeltaRow, deltaSchema } from "./client/delta-row";
import { contributePills } from "./client/pill";

export default function contribute(client: PluginClientContext) {
  const stopPills = contributePills(client);
  client.addTimelineRenderer({ kind: "board-delta", version: 1, schema: deltaSchema, Component: DeltaRow });
  return () => {
    stopPills();
  };
}
