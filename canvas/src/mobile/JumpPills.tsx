// Frame mode: back and forward through the frames you jumped between (jumpHistory.ts). Tap
// "← <frame>" to step back one level, "→" to step forward again; long-press the back pill
// for the recent jumps and pick one.

import { useEffect, useRef, useState } from "react";
import { type JumpHistory, recentJumps, stepIndex } from "./jumpHistory";
import "./jumpPills.css";

const HOLD_MS = 450;

export function JumpPills({ history, names, exists, go }: { history: JumpHistory; names: (id: string) => string; exists: (id: string) => boolean; go: (index: number) => void }) {
  const back = stepIndex(history, -1, exists);
  const fwd = stepIndex(history, 1, exists);
  const [list, setList] = useState(false);
  const hold = useRef<{ timer: ReturnType<typeof setTimeout>; fired: boolean } | null>(null);
  useEffect(() => setList(false), [history.index, history.stack.length]);
  useEffect(() => {
    if (!list) return;
    const away = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest(".bm-jumps")) setList(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [list]);
  if (back < 0 && fwd < 0) return null;
  const recent = list ? recentJumps(history, exists) : [];
  const release = () => {
    if (hold.current) clearTimeout(hold.current.timer);
  };
  return (
    <span className="bm-jumps">
      {back >= 0 ? (
        <button
          type="button"
          className="bm-backto"
          data-testid="mobile-back-to"
          data-frame-id={history.stack[back]}
          aria-label={`Back to ${names(history.stack[back])}. Long-press for recent frames`}
          onPointerDown={() => {
            release();
            hold.current = { fired: false, timer: setTimeout(() => { if (hold.current) hold.current.fired = true; setList(true); navigator.vibrate?.(10); }, HOLD_MS) };
          }}
          onPointerUp={release}
          onPointerLeave={release}
          onPointerCancel={release}
          onContextMenu={(e) => {
            // Desktop right-click and a long-press that the browser reports as one.
            e.preventDefault();
            release();
            if (hold.current) hold.current.fired = true;
            setList(true);
          }}
          onClick={() => {
            const fired = hold.current?.fired;
            hold.current = null;
            if (!fired) go(back);
          }}
        >
          ← {names(history.stack[back])}
        </button>
      ) : null}
      {fwd >= 0 ? (
        <button type="button" className="bm-fwd" data-testid="mobile-forward" data-frame-id={history.stack[fwd]} aria-label={`Forward to ${names(history.stack[fwd])}`} title={`Forward to ${names(history.stack[fwd])}`} onClick={() => go(fwd)}>
          →
        </button>
      ) : null}
      {list && recent.length ? (
        <span className="bm-jump-list" role="menu" data-testid="mobile-back-list">
          {recent.map((r) => (
            <button key={`${r.id}:${r.index}`} type="button" role="menuitem" data-testid="mobile-back-item" data-frame-id={r.id} onClick={() => { setList(false); go(r.index); }}>
              <small>{history.index - r.index === 1 ? "1 back" : `${history.index - r.index} back`}</small>
              {names(r.id)}
            </button>
          ))}
        </span>
      ) : null}
    </span>
  );
}
