// Phone shell: make room for new work. The home bar's "+ New" menu offers a new frame, a new
// page (a separate space on the board, same as a desktop tldraw page) and importing a Paseo
// conversation that was started elsewhere (App.tsx opens the shared ImportPicker). Frame and
// page ask for a name in a small sheet on the visual viewport, so the keyboard never covers
// Create.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { cleanName } from "../../../shared/frame-names";
import { useVisibleViewport } from "./StartSheet";
import { useSwipeDismiss } from "./sheetDrag";
import { useModalHold } from "./modalHold";
import "./startSheet.css";

export type CreateKind = "frame" | "page";

// "Open this frame once it is on the board": a frame the server just created (an import)
// reaches this tab a moment after the request returns; the shell opens it when it arrives.
let pendingOpen: string | null = null;
const openListeners = new Set<() => void>();
export function askOpenFrame(frameId: string | null) {
  pendingOpen = frameId;
  for (const l of openListeners) l();
}
export function useAskedOpenFrame(): string | null {
  return useSyncExternalStore((l) => (openListeners.add(l), () => openListeners.delete(l)), () => pendingOpen);
}

export function NewMenu({ close, pick }: { close: () => void; pick: (what: CreateKind | "import") => void }) {
  const item = (what: CreateKind | "import", label: string, hint: string) => (
    <button type="button" role="menuitem" data-testid={`mobile-new-${what}`} onClick={() => { close(); pick(what); }}>
      <b>{label}</b>
      <small>{hint}</small>
    </button>
  );
  return (
    <>
      <div className="bm-scrim bm-scrim-clear" data-mobile-ui onPointerDown={close} />
      <div className="bm-new-menu" data-mobile-ui data-testid="mobile-new-menu" role="menu" aria-label="New">
        {item("frame", "Frame", "An empty frame on this page, to name and fill")}
        {item("page", "Page", "A new space for a new project")}
        {item("import", "Import from Paseo", "Bring a conversation you started elsewhere")}
      </div>
    </>
  );
}

export function CreateSheet({ kind, where, create, close }: { kind: CreateKind; where?: string; create: (name: string) => void; close: () => void }) {
  useModalHold();
  const [name, setName] = useState("");
  const vp = useVisibleViewport();
  const swipe = useSwipeDismiss(close);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const t = setTimeout(() => input.current?.focus(), 60);
    return () => clearTimeout(t);
  }, []);
  const fallback = kind === "page" ? "New page" : "New frame";
  const save = () => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    create(cleanName(name) || fallback);
  };
  return (
    <div className="bm-start-layer" data-mobile-ui data-testid={`mobile-create-${kind}`} style={{ top: vp.top, height: vp.height }}>
      <div className="bm-start-scrim" onPointerDown={close} />
      <form ref={swipe} className="bm-start-sheet" role="dialog" aria-modal="true" aria-label={kind === "page" ? "New page" : "New frame"} onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") close(); }} onSubmit={(e) => { e.preventDefault(); save(); }}>
        <div className="bm-start-head">
          <span className="bm-grip-bar" aria-hidden="true" />
          <b>{kind === "page" ? "New page" : "New frame"}</b>
          {where ? <small data-testid="create-where">{where}</small> : null}
        </div>
        <div className="bm-start-body">
          <input ref={input} data-testid="mobile-create-name" className="bm-start-input" type="text" maxLength={80} enterKeyHint="done" autoComplete="off" aria-label="Name" placeholder={kind === "page" ? "Name, e.g. Dance" : fallback} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="bm-start-foot">
          <button type="button" className="bm-start-cancel" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="bm-start-go" data-testid="mobile-create-go">
            Create
          </button>
        </div>
      </form>
    </div>
  );
}
