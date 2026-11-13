// The conversation sidebar's ⋯ menu for a frame (Sidebar.tsx): one menu, in labelled groups,
// for everything the floating frame bar used to hold too (it no longer shows for frames
// with an agent). Agent: model and Paseo (passed in). Changes: send queued changes, and
// when to send them. Frame: pin, show on board, history, fit. Channels: connect this frame's
// agent to another frame's by name, and the channels it has (LinkChannels.tsx). Add to board:
// the drag sources (passed in). More: fork, restart with board tools, unbind (confirmed), archive.
import { useContext, useRef, useState } from "react";
import { type Editor, EditorContext, type TLFrameShape, type TLShapeId, useValue } from "tldraw";
import { api } from "./api";
import { ArchiveCtx } from "./FrameArchive";
import { B, fieldLabel, menuItem, primaryBtn, softBtn, UI_FONT } from "./bunnyTheme";
import { Emoji } from "./Emoji";
import { FrameContentTools } from "./FrameContentTools";
import { HistoryButton } from "./FrameHistory";
import { CHANNEL_MENU_CSS, ChannelMenuItems } from "./LinkChannels";
import { PIN_LIMIT, usePins } from "./pins";
import { jumpToFrame } from "./portals/Portals";
import { BoardUiCtx } from "./ui";

type Paseo = { agentId?: string; host?: string; mode?: string; linked?: boolean; pendingDeltas?: number; status?: string; request?: unknown };

export function MenuSection({ title, children, mobile }: { title: string; children: React.ReactNode; mobile?: boolean }) {
  return (
    <section aria-label={title} className="bunny-menu-section" style={{ display: "flex", flexDirection: "column", gap: 2, ["--row" as string]: mobile ? "44px" : "32px" }}>
      <div style={{ ...fieldLabel, padding: "6px 10px 2px" }}>{title}</div>
      {children}
    </section>
  );
}

// Menu rows: one look for every action (the UI font, 32px rows; 44px on a phone).
export const MENU_CSS = `
.bunny-menu-section > button, .bunny-menu-section .bunny-menu-row, .bunny-menu-section [data-testid="frame-history"] { box-sizing: border-box; min-height: var(--row, 32px); }
.bunny-menu-section > button:hover:not(:disabled), .bunny-menu-section [data-testid="frame-history"]:hover { background: ${B.hover} !important; }
.bunny-menu-section > button:disabled { opacity: .5; cursor: default; }
.bunny-menu-section a { text-decoration: none !important; }
.bunny-menu-section a:hover { background: ${B.hover}; }
/* Add to board: the drag handles keep their dashed edge (it says "drag me"), with the menu's
   font, size and corners; the buttons beside them match. */
.bunny-add-to-board button, .bunny-add-to-board [draggable="true"] { box-sizing: border-box; min-height: var(--row, 32px) !important; padding: 0 12px !important; border-radius: 9px !important; font: 500 13px ${UI_FONT} !important; display: inline-flex !important; align-items: center; }
.bunny-add-to-board button:not([draggable]) { border: 1px solid ${B.line} !important; background: transparent !important; color: ${B.espresso} !important; }
${CHANNEL_MENU_CSS}`;

const row: React.CSSProperties = { ...menuItem, font: `500 13px ${UI_FONT}` };

export function FrameMenuGroups({ editor, frameId, boardId, canRestart, mobile, close, agent, addToBoard, mobileFrameItems }: {
  editor: Editor;
  frameId: string;
  boardId: string;
  /** The agent can be restarted with the board tools (an imported conversation). */
  canRestart: boolean;
  mobile?: boolean;
  /** Close the menu. */
  close(): void;
  agent: React.ReactNode;
  addToBoard: React.ReactNode;
  /** The phone's own frame actions (edit settings, show on board, move). */
  mobileFrameItems?: React.ReactNode;
}) {
  const ui = useContext(BoardUiCtx);
  const archive = useContext(ArchiveCtx);
  const frame = useValue("frame-menu-frame", () => editor.getShape<TLFrameShape>(frameId as TLShapeId), [editor, frameId]);
  const [pins, togglePin] = usePins(editor, boardId);
  const [confirm, setConfirm] = useState<"unbind" | "restart" | null>(null);
  const [archiveOld, setArchiveOld] = useState(false);
  const [busy, setBusy] = useState<"fork" | "restart" | "unbind" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const busyRef = useRef(false);
  if (!frame) return null;
  const paseo = ((frame.meta as { paseo?: Paseo } | undefined)?.paseo ?? {}) as Paseo;
  const bound = !!paseo.agentId && !paseo.request;
  const pinned = pins.includes(frameId);
  const base = `/api/ui/boards/${encodeURIComponent(boardId)}/frames/${encodeURIComponent(frameId)}`;
  const run = async (kind: "fork" | "restart" | "unbind", path: string, body: unknown, done: (r: unknown) => void) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(kind);
    setErr(null);
    try {
      done(await api(`${base}/${path}`, { method: "POST", body: JSON.stringify(body) }));
      setConfirm(null);
      close();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };
  // biome-ignore lint/suspicious/noExplicitAny: meta JSON.
  const setDeltaMode = (m: string) => editor.updateShape<TLFrameShape>({ id: frame.id, type: "frame", meta: { ...frame.meta, paseo: { ...(frame.meta as any)?.paseo, mode: m } } });
  const working = paseo.status === "running" || paseo.status === "needs-permission";
  const confirmRow = (text: string, go: React.ReactNode) => (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "6px 10px" }}>
      <span style={{ flexBasis: "100%", fontSize: 12, color: B.muted }}>{text}</span>
      <span style={{ flex: 1 }} />
      <button type="button" style={softBtn} onClick={() => setConfirm(null)} disabled={!!busy}>
        Cancel
      </button>
      {go}
    </div>
  );
  return (
    <>
      <style>{MENU_CSS}</style>
      <MenuSection title="Agent" mobile={mobile}>
        {agent}
      </MenuSection>
      {bound ? (
        <MenuSection title="Changes" mobile={mobile}>
          {paseo.pendingDeltas ? (
            <button type="button" style={{ ...row, color: B.orange, fontWeight: 600 }} data-testid="menu-send-changes" onClick={() => editor.updateShape<TLFrameShape>({ id: frame.id, type: "frame", meta: { ...frame.meta, paseoFlushAt: Date.now() } })}>
              ↑ Send {paseo.pendingDeltas} change{paseo.pendingDeltas > 1 ? "s" : ""}
            </button>
          ) : null}
          <label className="bunny-menu-row" style={{ ...row, justifyContent: "space-between", cursor: "default" }}>
            <span>Send changes</span>
            <select data-testid="menu-send-mode" aria-label="When to send frame changes" title="Live sends automatically; manual waits for Send changes; on-demand lets the agent read queued changes." value={paseo.mode ?? "live"} onChange={(e) => setDeltaMode(e.target.value)} style={{ font: `500 12px ${UI_FONT}` }}>
              <option value="live">Live</option>
              {paseo.linked ? null : <option value="on-demand">On demand</option>}
              <option value="manual">Manual</option>
            </select>
          </label>
        </MenuSection>
      ) : null}
      <MenuSection title="Frame" mobile={mobile}>
        <button type="button" style={row} data-testid="menu-pin" aria-pressed={pinned} title={pinned ? "Unpin from the frame tabs" : pins.length >= PIN_LIMIT ? `Pin (replaces your least used of ${PIN_LIMIT} pins)` : "Pin to the frame tabs (on every device)"} onClick={() => { togglePin(frameId); close(); }}>
          {pinned ? "Unpin from tabs" : "Pin to tabs"}
        </button>
        {mobile ? null : (
          <button type="button" style={row} data-testid="menu-show-on-board" title="Move the board to this frame (Back returns)" onClick={() => { jumpToFrame(editor, frameId); close(); }}>
            Show on board
          </button>
        )}
        {mobileFrameItems}
        <HistoryButton frameId={frameId} style={row} />
        {/* The fit and add-text tools use the board's editor. */}
        <EditorContext.Provider value={editor}>
          <FrameContentTools frame={frame} />
        </EditorContext.Provider>
      </MenuSection>
      {bound ? (
        <MenuSection title="Channels" mobile={mobile}>
          <ChannelMenuItems editor={editor} boardId={boardId} frameId={frameId} mobile={mobile} close={close} />
        </MenuSection>
      ) : null}
      <MenuSection title="Add to board" mobile={mobile}>
        {addToBoard}
      </MenuSection>
      <MenuSection title="More" mobile={mobile}>
        {bound && !paseo.host ? (
          <button type="button" style={row} data-testid="fork-frame" disabled={!!busy} title="Start a new agent in a new frame beside this one, from this conversation so far; this frame keeps going" onClick={() => void run("fork", "fork", {}, () => ui.toast("Forked into a new frame beside this one; its agent starts from this conversation."))}>
            {busy === "fork" ? "Forking…" : "Fork to new frame"}
          </button>
        ) : null}
        {bound && paseo.linked && !paseo.host && canRestart ? (
          confirm === "restart" ? (
            confirmRow(
              "A fresh agent with the board tools takes over, from this conversation's last message.",
              <>
                <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 12 }}>
                  <input type="checkbox" data-testid="restart-archive-old" checked={archiveOld} onChange={(e) => setArchiveOld(e.target.checked)} /> Archive the old one
                </label>
                <button type="button" style={primaryBtn} data-testid="restart-go" disabled={!!busy} onClick={() => void run("restart", "restart", { archiveOld }, (r) => ui.toast(`Restarted with board tools as a new agent${(r as { archivedOld?: boolean }).archivedOld ? "; the old conversation was archived" : "; the old conversation is still in Paseo"}.`))}>
                  {busy === "restart" ? "Restarting…" : "Restart"}
                </button>
              </>,
            )
          ) : (
            <button type="button" style={row} data-testid="restart-with-tools" disabled={working} title={working ? "The conversation is working; stop it or let it finish first" : "Start a fresh agent in the same workspace with the board tools, handing over this conversation's last message"} onClick={() => setConfirm("restart")}>
              Restart with board tools
            </button>
          )
        ) : null}
        {bound && paseo.status !== "requested" ? (
          confirm === "unbind" ? (
            confirmRow(
              "The conversation stays in Paseo; this becomes a plain frame.",
              <button type="button" style={{ ...primaryBtn, background: B.danger, borderColor: B.danger }} data-testid="unbind-go" disabled={!!busy} onClick={() => void run("unbind", "unbind", {}, () => ui.toast("Unbound. The conversation is still in Paseo."))}>
                {busy === "unbind" ? "Unbinding…" : "Unbind"}
              </button>,
            )
          ) : (
            <button type="button" style={{ ...row, color: B.danger }} data-testid="unbind" title="Detach this frame from its conversation (the agent keeps running in Paseo)" onClick={() => setConfirm("unbind")}>
              Unbind…
            </button>
          )
        ) : null}
        <button type="button" style={{ ...row, color: B.danger }} data-testid="sidebar-archive" title="Take this frame and everything inside it off the board. Restore it from Board menu → Archive." onClick={() => { close(); archive.archive([frameId]); }}>
          <Emoji name="archive" /> Archive frame
        </button>
        {err ? <div role="alert" style={{ color: B.danger, padding: "4px 10px", fontSize: 12 }}>{err}</div> : null}
      </MenuSection>
    </>
  );
}
