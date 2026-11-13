// "Connect to…" (the conversation ⋯ menu's Channels group, LinkChannels.tsx): pick another
// frame's agent to open a channel with, on any page. It is the ⌘K palette (JumpPalette.tsx:
// the same dialog, search, order and keys) over the frames this one can be connected to.
// Choosing a row opens a link channel; the server puts a channel sticky in each frame.
import { useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type Editor, useValue } from "tldraw";
import { B } from "./bunnyTheme";
import { askConnect, channelList, connectFor, connectFrames, refreshChannels } from "./channelState";
import { FrameThumb, JumpStyles } from "./JumpPalette";
import { indexFrames, lastInteracted, type PaletteFrame, readAgentSends, readRecents, recencyKey, searchFrames } from "./jumpPaletteModel";
import { channelErrorText, connectCandidates } from "./linkChannelModel";
import { BoardUiCtx } from "./ui";

function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return;
  }
}

/** `mobile`: the phone shell (no keyboard hints, and the search field does not grab the keyboard). */
export function ConnectPicker({ editor, boardId, userId, mobile = false }: { editor: Editor; boardId: string; userId: string; mobile?: boolean }) {
  const frameId = useValue(connectFor);
  // Leaving the board (or a hot reload) never leaves a picker waiting to reopen.
  useEffect(() => () => askConnect(null), []);
  return frameId ? <ConnectDialog key={frameId} editor={editor} boardId={boardId} userId={userId} frameId={frameId} mobile={mobile} /> : null;
}

const short = (text: string, n = 32) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
const srOnly: React.CSSProperties = { position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" };

function ConnectDialog({ editor, boardId, userId, frameId, mobile }: { editor: Editor; boardId: string; userId: string; frameId: string; mobile: boolean }) {
  const ui = useContext(BoardUiCtx);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const channels = useValue(channelList);
  const frames = useValue("connect-picker-frames", () => indexFrames(editor.store.allRecords(), window.location.origin), [editor]);
  // The ⌘K order: frames this viewer touched last come first.
  const [recency] = useState(() => ({ jumps: readRecents(storage(), recencyKey(boardId, userId)), sends: readAgentSends(storage()) }));
  const touched = useMemo(() => lastInteracted(frames, recency.jumps, recency.sends), [frames, recency]);
  const self = frames.find((f) => f.id === frameId);
  const candidates = useMemo(() => connectCandidates(frames, frameId, channels), [frames, frameId, channels]);
  const results = useMemo(() => searchFrames(candidates, query, touched), [candidates, query, touched]);
  const selected = Math.min(active, results.length - 1);
  const close = () => askConnect(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element.showModal();
    // On a phone the list comes first: focusing the field would cover it with the keyboard.
    if (!mobile) input.current?.focus();
    // The list may be a poll old: read it now, so a frame connected a moment ago is not offered.
    void refreshChannels();
    return () => {
      element.close();
      if (previous?.isConnected) previous.focus();
      else editor.focus();
    };
  }, [editor, mobile]);

  useEffect(() => {
    dialog.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const connect = async (target: PaletteFrame) => {
    if (busy) return;
    setBusy(target.id);
    setError(null);
    try {
      await connectFrames(boardId, frameId, target.id);
      ui.toast(`Connected to “${short(target.name)}”. Each frame now has a channel sticky.`);
      close();
    } catch (e) {
      setError(channelErrorText((e as Error).message));
      void refreshChannels();
      setBusy(null);
      input.current?.focus();
    }
  };

  return createPortal(
    <>
      <JumpStyles />
      <dialog
        ref={dialog}
        className="bunny-jump"
        data-testid="connect-picker"
        data-frame={frameId}
        aria-labelledby={titleId}
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        onClick={(event) => {
          if (event.target !== dialog.current) return;
          const rect = dialog.current.getBoundingClientRect();
          if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            close();
          }
        }}
      >
        <header>
          <h2 id={titleId} title={self ? `Connect “${self.name}” to another frame` : undefined} style={{ minWidth: 0, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
            {self ? `Connect “${self.name}” to…` : "Connect to…"}
          </h2>
          <button type="button" className="bunny-jump-close" aria-label="Close" onClick={close}>
            ×
          </button>
        </header>
        <div className="bunny-jump-search">
          <input
            ref={input}
            type="search"
            data-testid="connect-search"
            aria-label="Search frames to connect to"
            placeholder="Search frame or agent name…"
            // 16px on a phone: a smaller field makes iOS zoom the page.
            style={mobile ? { fontSize: 16 } : undefined}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter") {
                event.preventDefault();
                if (results[selected]) void connect(results[selected]);
              }
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                if (results.length) setActive((selected + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length);
              }
            }}
          />
        </div>
        {error ? (
          <p role="alert" data-testid="connect-error" style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 20px 12px", color: B.muted, fontSize: 13 }}>
            <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", background: B.danger, flex: "none" }} />
            <span style={{ minWidth: 0, overflowWrap: "break-word" }}>{error}</span>
          </p>
        ) : null}
        {results.length ? (
          <ul aria-label="Frames to connect to" aria-busy={!!busy}>
            {results.map((frame, i) => (
              <li key={frame.id} data-frame-id={frame.id} data-active={i === selected} onPointerMove={() => setActive(i)}>
                <button type="button" className="bunny-jump-target" data-testid="connect-row" disabled={!!busy} onClick={() => void connect(frame)} aria-label={`Connect to ${frame.name}, on ${frame.pageName}`}>
                  <FrameThumb editor={editor} id={frame.id} />
                  <span className="bunny-jump-label">
                    <strong title={frame.name}>{frame.name}</strong>
                    <small data-testid="connect-row-page" title={`${frame.pageName}${frame.agentTitle ? ` · ${frame.agentTitle}` : ""}`}>
                      {busy === frame.id ? "Connecting…" : `${frame.pageName}${frame.agentTitle ? ` · ${frame.agentTitle}` : ""}`}
                    </small>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="bunny-jump-empty" data-testid="connect-empty">
            {!self?.agentId ? "This frame has no conversation, so there is nothing to connect." : candidates.length ? `No frames match “${query}”.` : "No other frame with a conversation is left to connect to."}
          </p>
        )}
        {/* The keys are for a keyboard; a phone gets the list alone. The count is for screen readers only. */}
        <footer style={mobile ? srOnly : undefined}>
          <span role="status" aria-live="polite" style={srOnly}>
            {results.length} {results.length === 1 ? "frame" : "frames"}
            {results[selected] ? `, ${results[selected].name}` : ""}
          </span>
          {mobile ? null : "↑↓ choose · Enter connect · Esc close"}
        </footer>
      </dialog>
    </>,
    document.body,
  );
}
