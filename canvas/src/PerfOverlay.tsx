// ?perf=1: a small fixed panel with frame time, long tasks and the busiest hook counters.
// Counter rates are per second over the last refresh (500 ms).
import { useEffect, useRef, useState } from "react";
import { perfSample } from "./perf";

export function PerfOverlay() {
  const [s, setS] = useState(() => perfSample());
  const prev = useRef(new Map<string, number>());
  const [rates, setRates] = useState<[string, number, number][]>([]);
  useEffect(() => {
    const t = setInterval(() => {
      const next = perfSample();
      const out: [string, number, number][] = next.counters.map(([k, v]) => [k, v, ((v - (prev.current.get(k) ?? 0)) * 1000) / 500]);
      prev.current = new Map(next.counters);
      out.sort((a, b) => b[2] - a[2] || b[1] - a[1]);
      setRates(out.slice(0, 10));
      setS(next);
    }, 500);
    return () => clearInterval(t);
  }, []);
  const tone = (ms: number) => (ms <= 20 ? "#1f7a3a" : ms <= 40 ? "#9a6700" : "#b3261e");
  return (
    <div
      data-testid="perf-overlay"
      style={{ position: "fixed", right: 8, bottom: 64, zIndex: 10000, background: "light-dark(rgba(255,255,255,0.94), color-mix(in srgb, #20242c 94%, transparent))", color: "light-dark(#222, var(--bunny-ink))", border: "1px solid light-dark(#ccc, var(--bunny-line))", borderRadius: 8, padding: "6px 8px", font: "11px/1.35 ui-monospace,monospace", pointerEvents: "none", minWidth: 200 }}
    >
      <div>
        frame p50 <b style={{ color: tone(s.p50) }}>{s.p50.toFixed(1)}</b> p95 <b style={{ color: tone(s.p95) }}>{s.p95.toFixed(1)}</b> ms
      </div>
      <div>
        long tasks 10s <b>{s.longTasks10s}</b> ({Math.round(s.longTaskMs10s)} ms)
      </div>
      {rates.map(([k, total, rate]) => (
        <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <span>{k}</span>
          <span>
            {rate.toFixed(0)}/s · {total}
          </span>
        </div>
      ))}
    </div>
  );
}
