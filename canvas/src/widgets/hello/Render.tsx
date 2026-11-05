// Hello widget body: the greeting and a seconds counter streamed from the server.

import type { HelloData } from "../../../../shared/widgets/hello";
import type { WidgetBodyProps } from "../registry";

export function HelloBody({ state }: WidgetBodyProps) {
  const data = state?.data as HelloData | null;
  if (!data) return <div style={{ color: "#778", padding: 12 }}>Waiting for the first tick…</div>;
  return (
    <div data-testid="hello-body" style={{ padding: "8px 14px", display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ fontSize: 20, fontWeight: 650, color: "#223" }} data-testid="hello-greeting">
        {data.greeting}
      </div>
      <div style={{ color: "#556" }}>
        tick <b data-testid="hello-tick" style={{ fontVariantNumeric: "tabular-nums" }}>{data.tick}</b> · server {new Date(data.serverTime).toLocaleTimeString()}
      </div>
    </div>
  );
}
