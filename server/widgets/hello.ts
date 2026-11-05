// Hello widget data source: ticks once a second. If the ticks stop (the admin "pause"
// control, or a stalled process) the hub's deadline turns the widget stale.

import type { HelloConfig, HelloData } from "../../shared/widgets/hello";
import type { WidgetSource } from "./types";

export function helloSource(opts: { periodMs?: number } = {}): WidgetSource<HelloConfig> {
  const period = opts.periodMs ?? 1000;
  let pausedUntil = 0;
  return {
    id: "hello",
    watch(config, emit) {
      let tick = 0;
      const send = () => {
        if (Date.now() < pausedUntil) return;
        const data: HelloData = { greeting: `Hello, ${config.name}`, tick: tick++, serverTime: new Date().toISOString() };
        emit({ status: "live", data });
      };
      send();
      const timer = setInterval(send, period);
      timer.unref?.();
      return () => clearInterval(timer);
    },
    // {pauseMs}: stop ticking for that long (proves the stale indicator).
    admin(input) {
      const ms = Math.max(0, Math.min(60_000, Number(input.pauseMs) || 0));
      pausedUntil = Date.now() + ms;
      return { ok: true, pausedMs: ms };
    },
  };
}
