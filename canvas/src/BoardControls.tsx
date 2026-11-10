// The board's two global switches, Lock layout and Pause agents, plus Import. Wide
// screens show them in the header (top right); phones get them in a bar above tldraw's
// toolbar, where a thumb reaches (App.tsx).

import { perfCount } from "./perf";
import { useEffect, useMemo, useState } from "react";
import { type Editor, type TLFrameShape, useValue } from "tldraw";
import { boardLocks, deviceLock, postLocks, setDeviceLock } from "./locks";
import { Emoji } from "./Emoji";
import { pageFrames } from "./pageFrames";

export function useNarrow(limit = 700): boolean {
  const [narrow, setNarrow] = useState(() => window.innerWidth < limit);
  useEffect(() => {
    const on = () => setNarrow(window.innerWidth < limit);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, [limit]);
  return narrow;
}

// Deltas waiting in bound frames (each frame's pendingDeltas), for the Pause button.
// Returned as a "deltas:frames" key so the hook only re-renders when a count changes.
export function useQueued(editor: Editor): { deltas: number; frames: number } {
  const key = useValue(
    "paseo-queued",
    () => {
      perfCount("paseo-queued");
      let deltas = 0;
      let frames = 0;
      for (const s of pageFrames(editor).get()) {
        // biome-ignore lint/suspicious/noExplicitAny: meta JSON.
        const n = Number((s.meta as any)?.paseo?.pendingDeltas ?? 0);
        if (n > 0) {
          deltas += n;
          frames++;
        }
      }
      return `${deltas}:${frames}`;
    },
    [editor],
  );
  return useMemo(() => {
    const [deltas, frames] = key.split(":").map(Number);
    return { deltas, frames };
  }, [key]);
}

const base: React.CSSProperties = { borderRadius: 8, border: "1px solid light-dark(#bbb, var(--bunny-line))", background: "light-dark(#fff, var(--bunny-surface))", color: "light-dark(#222, var(--bunny-ink))", cursor: "pointer", font: "inherit", whiteSpace: "nowrap" };

export function BoardControls({ editor, boardId, onImport, toast, big = false }: { editor: Editor; boardId: string; onImport: () => void; toast: (t: string) => void; big?: boolean }) {
  const locks = useValue("paseo-locks", () => boardLocks(editor).get(), [editor]);
  const device = useValue("paseo-device-lock", () => deviceLock.get(), []);
  const queued = useQueued(editor);
  const [resuming, setResuming] = useState(false);
  const [busy, setBusy] = useState(false);
  const pad = big ? "10px 12px" : "5px 9px";
  const btn = (on: boolean, color: string): React.CSSProperties => ({ ...base, padding: pad, minHeight: big ? 44 : undefined, ...(on ? { background: color, borderColor: color, color: "#fff" } : {}) });

  const call = async (patch: { layout?: boolean; agentsPaused?: boolean; discard?: boolean }, done?: (r: Awaited<ReturnType<typeof postLocks>>) => void) => {
    setBusy(true);
    try {
      const r = await postLocks(boardId, patch);
      done?.(r);
    } catch (e) {
      toast(`Could not change the board locks: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const layoutOn = locks.layout || device;
  const layoutTitle = locks.layout
    ? `Layout locked for everyone${locks.layoutBy ? ` by ${locks.layoutBy}` : ""}: nothing can be moved, resized or deleted; new notes still work. Tap to unlock.`
    : device
      ? "Layout locked on this device (touch screens start locked): two-finger pan and zoom never move anything. Tap to unlock here."
      : "Lock layout: nothing on the board can be moved, resized or deleted (by anyone, or by agents); drawing new notes still works.";
  const onLayout = () => {
    if (locks.layout) void call({ layout: false }, () => setDeviceLock(boardId, false));
    else if (device) setDeviceLock(boardId, false);
    else void call({ layout: true });
  };

  const onPause = () => {
    if (!locks.agentsPaused) return void call({ agentsPaused: true });
    if (queued.deltas) setResuming(true);
    else void call({ agentsPaused: false });
  };

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", justifyContent: big ? "flex-start" : "flex-end" }} onPointerDown={stop} onKeyDown={stop} data-testid="board-controls">
      <button type="button" data-testid="lock-layout" data-on={layoutOn ? (locks.layout ? "board" : "device") : "off"} disabled={busy} onClick={onLayout} title={layoutTitle} style={btn(layoutOn, locks.layout ? "#c0392b" : "#7f8c8d")}>
        <Emoji name={layoutOn ? "lock" : "unlock"} /> {layoutOn ? (locks.layout ? "Locked" : big ? "Locked here" : "Locked (this device)") : big ? "Lock" : "Lock layout"}
      </button>
      {resuming ? (
        <span style={{ display: "inline-flex", gap: 4, alignItems: "center", flexWrap: "wrap" }} data-testid="resume-choice">
          <button type="button" data-testid="resume-send" style={btn(true, "#2f80ed")} disabled={busy} onClick={() => void call({ agentsPaused: false }, (r) => (setResuming(false), toast(`Agents resumed: ${r.flushed ?? 0} frame(s) got their queued changes.`)))}>
            Send {queued.deltas} queued
          </button>
          <button type="button" data-testid="resume-discard" style={btn(false, "")} disabled={busy} onClick={() => void call({ agentsPaused: false, discard: true }, (r) => (setResuming(false), toast(`Agents resumed; ${r.discarded ?? 0} queued change(s) discarded.`)))}>
            Discard
          </button>
          <button type="button" style={btn(false, "")} onClick={() => setResuming(false)}>
            ×
          </button>
        </span>
      ) : (
        <button
          type="button"
          data-testid="pause-agents"
          data-on={locks.agentsPaused ? "1" : "0"}
          disabled={busy}
          onClick={onPause}
          title={locks.agentsPaused ? "Agents are paused: your edits queue up and no frame's agent is told until you resume. Sidebar replies still send." : "Pause agents: queue every frame's board deltas instead of sending them (sidebar replies still send)."}
          style={btn(locks.agentsPaused, "#d35400")}
        >
          <Emoji name="pause" /> {locks.agentsPaused ? `Paused${queued.deltas ? ` · ${queued.deltas}${big ? "" : " queued"}` : ""}` : big ? "Pause" : "Pause agents"}
        </button>
      )}
      <button
        type="button"
        data-testid="import-open"
        onClick={onImport}
        title="Import existing Paseo conversations as frames (right-click the canvas to import at a point)"
        style={{ ...btn(true, "#2f80ed") }}
      >
        {big ? "Import" : "Import conversations"}
      </button>
    </div>
  );
}

// "paused" on every bound frame while agents are paused (InFrontOfTheCanvas).
const NO_PAUSED_BADGES: Array<{ id: string; x: number; y: number; n: number }> = [];
export function PausedBadges({ editor }: { editor: Editor }) {
  const paused = useValue("paseo-paused", () => boardLocks(editor).get().agentsPaused, [editor]);
  const badges = useValue(
    "paseo-paused-badges",
    () => {
      perfCount("paseo-paused-badges");
      if (!paused) return NO_PAUSED_BADGES;
      const vp = editor.getViewportPageBounds();
      const out: Array<{ id: string; x: number; y: number; n: number }> = [];
      for (const s of pageFrames(editor).get()) {
        // biome-ignore lint/suspicious/noExplicitAny: meta JSON.
        const p = (s.meta as any)?.paseo;
        if (!p?.agentId) continue;
        const b = editor.getShapePageBounds(s.id);
        if (!b || !b.collides(vp)) continue;
        const pt = editor.pageToViewport({ x: b.maxX, y: b.minY });
        out.push({ id: s.id, x: pt.x, y: pt.y, n: Number(p.pendingDeltas ?? 0) });
        if (out.length >= 60) break;
      }
      return out;
    },
    [editor, paused],
  );
  return (
    <>
      {badges.map((b) => (
        <div
          key={b.id}
          data-testid="paused-badge"
          data-frame={b.id as TLFrameShape["id"]}
          style={{ position: "absolute", left: b.x, top: b.y, transform: "translate(-100%, -115%)", background: "#d35400", color: "#fff", font: "600 11px system-ui, sans-serif", padding: "2px 7px", borderRadius: 999, pointerEvents: "none", whiteSpace: "nowrap", zIndex: 250 }}
        >
          <Emoji name="pause" /> paused{b.n ? ` · ${b.n} queued` : ""}
        </div>
      ))}
    </>
  );
}
