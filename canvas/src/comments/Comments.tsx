// Figma-style comments: comment mode (C), pins that follow shapes, threads with replies,
// reactions, @mentions, resolve, unread state, a comments panel and deep links.

import { perfCount } from "../perf";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type Editor, type TLFrameShape, type TLShapeId, useValue } from "tldraw";
import {
  addReply,
  type CommentMessage,
  type CommentThread,
  COMMENT_MAX_LENGTH,
  createThread,
  deleteMessage,
  deleteThread,
  editMessage,
  firstMessage,
  isUnreadFor,
  lastActivity,
  moveThread,
  orderedMessages,
  QUICK_REACTIONS,
  setResolved,
  shareThread,
  splitMentions,
  toggleReaction,
} from "../../../shared/comments";
import { boardLocks } from "../locks";
import { pageFrames } from "../pageFrames";
import { BoardUiCtx } from "../ui";
import { useVisualViewport } from "../visualViewport";
import {
  anchorAt,
  areaCorners,
  areaDrag,
  closeAll,
  COMMENT_TOOL,
  draft,
  hoverThread,
  markRead,
  newId,
  nowIso,
  openThread,
  pageThreads,
  pinPagePoint,
  readMarks,
  setShowPins,
  showPins,
  showResolved,
  who,
  writeComments,
} from "./state";
import "./comments.css";

// ---------- small helpers ----------

function ago(iso: string): string {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s)) return "";
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function hue(key: string): number {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts.at(-1)![0] : "")).toUpperCase();
}

function Avatar({ id, name, size = 24 }: { id: string; name: string; size?: number }) {
  return (
    <span className="cmt-avatar" title={name} style={{ width: size, height: size, fontSize: size * 0.42, background: `hsl(${hue(id || name)} 60% 45%)` }}>
      {initials(name)}
    </span>
  );
}

const isUnread = isUnreadFor;

// Phones: threads and drafts open as a bottom sheet above the keyboard.
const NARROW = 700;
function useSheet(): React.CSSProperties | null {
  const vv = useVisualViewport();
  if (window.innerWidth > NARROW) return null;
  const bottom = Math.max(0, window.innerHeight - (vv.top + vv.height));
  return { left: 0, right: 0, top: "auto", bottom, width: "auto", maxWidth: "none", maxHeight: Math.max(180, Math.min(vv.height * 0.6, vv.height - 60)), borderRadius: "14px 14px 0 0" };
}

function copyText(text: string): boolean {
  // The board is served over plain http on the tailnet, where navigator.clipboard is missing.
  if (navigator.clipboard && window.isSecureContext) {
    void navigator.clipboard.writeText(text);
    return true;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  return ok;
}

function threadLink(id: string): string {
  const u = new URL(window.location.href);
  u.searchParams.delete("frame");
  u.searchParams.set("comment", id);
  return u.toString();
}

const stop = {
  onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
  onPointerUp: (e: React.PointerEvent) => e.stopPropagation(),
  onKeyDown: (e: React.KeyboardEvent) => {
    if (e.key !== "Escape") e.stopPropagation();
  },
  onWheel: (e: React.WheelEvent) => e.stopPropagation(),
  onDoubleClick: (e: React.MouseEvent) => e.stopPropagation(),
  // The cards are portalled from inside tldraw, so React would bubble a right-click to its
  // canvas context menu. Stop it here: the browser's own menu (paste, spelling) shows instead.
  onContextMenu: (e: React.MouseEvent) => e.stopPropagation(),
};

function useIsCommentMode(editor: Editor) {
  return useValue("comment-mode", () => editor.getCurrentToolId() === COMMENT_TOOL, [editor]);
}

function usePeople(editor: Editor, threads: CommentThread[]): string[] {
  const collaborators = useValue("comment-collaborators", () => editor.getCollaborators().map((c) => c.userName), [editor]);
  return useMemo(() => {
    const names = new Set<string>([who().userName, ...collaborators]);
    for (const t of threads) for (const m of Object.values(t.messages)) names.add(m.author);
    return [...names].filter(Boolean).sort((a, b) => a.localeCompare(b));
  }, [collaborators, threads]);
}

// Frames with an agent on this page: @-mentionable and "Send to agent…" targets.
interface AgentFrame { id: string; name: string }
const AgentFramesCtx = createContext<AgentFrame[]>([]);

function useAgentFrames(editor: Editor): AgentFrame[] {
  const list = useValue(
    "comment-agent-frames",
    () =>
      (perfCount("comment-agent-frames"), pageFrames(editor))
        .get()
        .filter((s) => !!(s.meta as { paseo?: { agentId?: string } })?.paseo?.agentId)
        .map((f) => ({ id: f.id, name: (f.props.name || "Untitled frame").trim() }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [editor],
  );
  const key = list.map((f) => `${f.id}:${f.name}`).join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on content.
  return useMemo(() => list, [key]);
}

// ---------- text with @mentions ----------

function MessageText({ text, people }: { text: string; people: string[] }) {
  const agents = useContext(AgentFramesCtx);
  return (
    <p className="cmt-text">
      {splitMentions(text, [...people, ...agents.map((a) => a.name)]).map((part, i) =>
        part.mention ? (
          <span key={i} className="cmt-mention">
            {part.text}
          </span>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </p>
  );
}

// Textarea with @mention suggestions. Enter sends, Shift+Enter is a new line.
function Composer({
  placeholder,
  people,
  initial = "",
  autoFocus = true,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  people: string[];
  initial?: string;
  autoFocus?: boolean;
  submitLabel: string;
  onSubmit(text: string, mentions: string[]): boolean | void;
  onCancel?(): void;
}) {
  const agents = useContext(AgentFramesCtx);
  // Agent frames picked from the suggestions, by the name inserted.
  const picked = useRef(new Map<string, string>());
  const [text, setText] = useState(initial);
  const [caret, setCaret] = useState(initial.length);
  const [pick, setPick] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  // Caret after inserting a mention: placed before the next keystroke can land.
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const pos = pendingCaret.current;
    if (pos === null || !ref.current) return;
    pendingCaret.current = null;
    ref.current.focus();
    ref.current.setSelectionRange(pos, pos);
  }, [text]);
  const query = /(^|[\s(])@([^\s@]{0,24})$/.exec(text.slice(0, caret));
  type Suggestion = { name: string; agentFrame?: string };
  const q = query?.[2].toLowerCase() ?? "";
  const matches: Suggestion[] = query
    ? ([...agents.map((a) => ({ name: a.name, agentFrame: a.id })), ...people.map((p) => ({ name: p }))] as Suggestion[])
        .filter((p) => p.name.toLowerCase().startsWith(q) || (p.agentFrame && p.name.toLowerCase().includes(q)))
        .slice(0, 8)
    : [];
  const insert = ({ name, agentFrame }: Suggestion) => {
    if (agentFrame) picked.current.set(name, agentFrame);
    if (!query) return;
    const start = caret - query[2].length - 1;
    const next = `${text.slice(0, start)}@${name} ${text.slice(caret)}`;
    const pos = start + name.length + 2;
    pendingCaret.current = pos;
    setText(next);
    setCaret(pos);
  };
  const submit = () => {
    if (!text.trim()) return;
    const mentions = [...picked.current].filter(([name]) => text.includes(`@${name}`)).map(([, id]) => id);
    if (onSubmit(text, mentions) !== false) {
      setText("");
      setCaret(0);
      picked.current.clear();
    }
  };
  useEffect(() => {
    setPick(0);
  }, [query?.[2]]);
  // tldraw focuses its canvas container on pointer up, after the click that opened us.
  useEffect(() => {
    if (!autoFocus) return;
    const focus = () => {
      const el = ref.current;
      if (el && document.activeElement !== el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    };
    const timers = [0, 60, 200].map((ms) => setTimeout(focus, ms));
    return () => timers.forEach(clearTimeout);
  }, [autoFocus]);
  return (
    <div className="cmt-composer">
      <textarea
        ref={ref}
        rows={1}
        value={text}
        autoFocus={autoFocus}
        maxLength={COMMENT_MAX_LENGTH}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => {
          setText(e.target.value);
          setCaret(e.target.selectionStart);
        }}
        onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (matches.length) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setPick((p) => (p + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              insert(matches[pick]);
              return;
            }
          }
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel ? onCancel() : closeAll();
          }
        }}
      />
      {matches.length ? (
        <ul className="cmt-mentions" role="listbox">
          {matches.map((m, i) => (
            <li key={`${m.agentFrame ?? "p"}:${m.name}`} role="option" aria-selected={i === pick} className={i === pick ? "on" : ""} onPointerDown={(e) => { e.preventDefault(); insert(m); }}>
              {m.agentFrame ? <span className="cmt-agent-badge" aria-hidden="true">AI</span> : <Avatar id={m.name} name={m.name} size={18} />} {m.name}
              {m.agentFrame ? <span className="cmt-agent-kind">agent</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="cmt-composer-row">
        <span className="cmt-hint">@ to mention · Enter to send</span>
        {onCancel ? (
          <button type="button" className="cmt-btn ghost" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
        <button type="button" className="cmt-btn send" aria-label={submitLabel} title={submitLabel} disabled={!text.trim()} onClick={submit}>
          {submitLabel === "Save" ? "Save" : "↑"}
        </button>
      </div>
    </div>
  );
}

// ---------- one message in a thread ----------

function Message({ editor, thread, msg, first, people }: { editor: Editor; thread: CommentThread; msg: CommentMessage; first: boolean; people: string[] }) {
  const me = who();
  const mine = msg.authorId === me.userId;
  const [editing, setEditing] = useState(false);
  const [picking, setPicking] = useState(false);
  const reactions = Object.entries(msg.reactions ?? {});
  const readonly = useValue("comment-readonly", () => editor.getIsReadonly(), [editor]);
  return (
    <li className="cmt-msg" data-message-id={msg.id}>
      <div className="cmt-msg-head">
        <Avatar id={msg.authorId} name={msg.author} />
        <strong>{msg.author}</strong>
        <time title={new Date(msg.createdAt).toLocaleString()}>{ago(msg.createdAt)}</time>
        {readonly ? null : <span className="cmt-msg-actions">
          <button type="button" title="Add reaction" aria-label="Add reaction" onClick={() => setPicking((p) => !p)}>
            ☺
          </button>
          {mine ? (
            <>
              <button type="button" title="Edit" aria-label="Edit comment" onClick={() => setEditing(true)}>
                ✎
              </button>
              <button
                type="button"
                title={first ? "Delete thread" : "Delete"}
                aria-label={first ? "Delete thread" : "Delete comment"}
                onClick={() => {
                  if (first && !window.confirm("Delete this comment thread?")) return;
                  writeComments(editor, (meta) => deleteMessage(meta, thread.id, msg.id, me));
                  if (first) closeAll();
                }}
              >
                🗑
              </button>
            </>
          ) : null}
        </span>}
      </div>
      {editing ? (
        <Composer
          placeholder="Edit comment"
          people={people}
          initial={msg.text}
          submitLabel="Save"
          onCancel={() => setEditing(false)}
          onSubmit={(text) => {
            const ok = writeComments(editor, (meta) => editMessage(meta, thread.id, msg.id, text, me, nowIso()));
            if (ok) setEditing(false);
            return ok;
          }}
        />
      ) : (
        <>
          <MessageText text={msg.text} people={people} />
          {msg.editedAt ? <span className="cmt-edited">(edited)</span> : null}
        </>
      )}
      {picking ? (
        <div className="cmt-react-picker">
          {QUICK_REACTIONS.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => {
                writeComments(editor, (meta) => toggleReaction(meta, thread.id, msg.id, e, me));
                setPicking(false);
              }}
            >
              {e}
            </button>
          ))}
        </div>
      ) : null}
      {reactions.length ? (
        <div className="cmt-reactions">
          {reactions.map(([emoji, users]) => (
            <button
              key={emoji}
              type="button"
              className={users[me.userId] ? "mine" : ""}
              title={Object.values(users).join(", ")}
              onClick={() => writeComments(editor, (meta) => toggleReaction(meta, thread.id, msg.id, emoji, me))}
            >
              {emoji} {Object.keys(users).length}
            </button>
          ))}
        </div>
      ) : null}
    </li>
  );
}

// Agent frames still holding a message from this thread (queued in their frame meta), and why.
function usePendingDelivery(editor: Editor, threadId: string): { name: string; why: string }[] {
  return useValue(
    "comment-pending-delivery",
    () => {
      const tag = `(thread ${threadId})`;
      const paused = boardLocks(editor).get().agentsPaused;
      const out: { name: string; why: string }[] = [];
      for (const s of editor.getCurrentPageShapes()) {
        if (s.type !== "frame") continue;
        const p = (s.meta as { paseo?: { agentId?: string; queue?: unknown; error?: string; status?: string } })?.paseo;
        if (!p?.agentId || !Array.isArray(p.queue) || !p.queue.some((t) => typeof t === "string" && t.includes(tag))) continue;
        const why = paused ? "agents are paused" : p.error ? p.error : p.status === "running" ? "its agent is busy" : "waiting to send";
        out.push({ name: (s as TLFrameShape).props.name || "Untitled frame", why });
      }
      return out;
    },
    [editor, threadId],
  );
}

// ---------- the open thread ----------

function popoverPos(x: number, y: number, w = 340, h = 420) {
  // Keep clear of the comments panel when it is open.
  const right = window.innerWidth - (document.querySelector(".cmt-panel") ? 316 : 8);
  const left = x + 36 + w > right ? Math.max(8, x - w - 12) : x + 36;
  const top = Math.min(Math.max(8, y - 40), Math.max(8, window.innerHeight - h - 8));
  return { left, top };
}

function ThreadCard({ editor, thread, at, people }: { editor: Editor; thread: CommentThread; at: { x: number; y: number }; people: string[] }) {
  const me = who();
  const [menu, setMenu] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const agents = useContext(AgentFramesCtx);
  const ui = useContext(BoardUiCtx);
  const messages = orderedMessages(thread);
  const listRef = useRef<HTMLUListElement>(null);
  const sheet = useSheet();
  const pending = usePendingDelivery(editor, thread.id);
  const last = lastActivity(thread);
  useEffect(() => {
    markRead(editor, thread.id, last);
  }, [editor, thread.id, last]);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length]);
  return (
    <section className={`cmt-card cmt-thread ${sheet ? "sheet" : ""}`} style={sheet ?? popoverPos(at.x, at.y)} aria-label="Comment thread" data-thread-id={thread.id} {...stop}>
      <header>
        <span className="cmt-title">{thread.resolved ? `Resolved by ${thread.resolved.by}` : "Comment"}</span>
        <button
          type="button"
          className={`cmt-icon ${thread.resolved ? "on" : ""}`}
          title={thread.resolved ? "Unresolve" : "Resolve"}
          aria-label={thread.resolved ? "Unresolve" : "Resolve"}
          onClick={() => {
            writeComments(editor, (meta) => setResolved(meta, thread.id, !thread.resolved, me, nowIso()));
            if (!thread.resolved && !showResolved.get()) closeAll();
          }}
        >
          ✓
        </button>
        <span className="cmt-menu-wrap">
          <button type="button" className="cmt-icon" title="More" aria-label="More actions" onClick={() => setMenu((m) => !m)}>
            ⋯
          </button>
          {menu ? (
            <ul className="cmt-menu">
              <li>
                <button type="button" onClick={() => { markRead(editor, thread.id, null); setMenu(false); closeAll(); }}>
                  Mark as unread
                </button>
              </li>
              <li>
                <button type="button" onClick={() => { ui.toast(copyText(threadLink(thread.id)) ? "Link to comment copied" : threadLink(thread.id)); setMenu(false); }}>
                  Copy link
                </button>
              </li>
              <li>
                <button type="button" disabled={!agents.length} title={agents.length ? undefined : "No frame on this page has an agent"} onClick={() => setSendOpen((o) => !o)}>
                  Send to agent…
                </button>
              </li>
              {sendOpen
                ? agents.map((a) => {
                    const sent = thread.shares?.includes(a.id);
                    return (
                      <li key={a.id}>
                        <button type="button" className="cmt-menu-sub" disabled={sent} onClick={() => { if (writeComments(editor, (meta) => shareThread(meta, thread.id, a.id))) ui.toast(`Sent to ${a.name}`); setMenu(false); setSendOpen(false); }}>
                          {sent ? "✓ " : ""}{a.name}
                        </button>
                      </li>
                    );
                  })
                : null}
              {thread.authorId === me.userId ? (
                <li>
                  <button type="button" className="danger" onClick={() => { if (window.confirm("Delete this comment thread?")) { writeComments(editor, (meta) => deleteThread(meta, thread.id)); closeAll(); } }}>
                    Delete thread
                  </button>
                </li>
              ) : null}
            </ul>
          ) : null}
        </span>
        <button type="button" className="cmt-icon" title="Close (Esc)" aria-label="Close" onClick={closeAll}>
          ×
        </button>
      </header>
      {pending.length ? (
        <div className="cmt-pending" role="status">
          {pending.map((p) => (
            <div key={p.name}>
              Not delivered yet to {p.name}: {p.why}
            </div>
          ))}
        </div>
      ) : null}
      <ul className="cmt-msgs" ref={listRef}>
        {messages.map((m, i) => (
          <Message key={m.id} editor={editor} thread={thread} msg={m} first={i === 0} people={people} />
        ))}
      </ul>
      {editor.getIsReadonly() ? null : (
        <Composer
          placeholder="Reply"
          people={people}
          submitLabel="Reply"
          onSubmit={(text, mentions) => writeComments(editor, (meta) => addReply(meta, thread.id, { messageId: newId(), text, who: me, now: nowIso(), mentions }))}
        />
      )}
    </section>
  );
}

function DraftCard({ editor, at, people }: { editor: Editor; at: { x: number; y: number }; people: string[] }) {
  const me = who();
  const d = useValue("comment-draft", () => draft.get(), []);
  const sheet = useSheet();
  if (!d) return null;
  return (
    <>
      <div className="cmt-pin draft" style={{ left: at.x, top: at.y }}>
        <Avatar id={me.userId} name={me.userName} />
      </div>
      <section className={`cmt-card cmt-draft ${sheet ? "sheet" : ""}`} style={sheet ? { ...sheet, padding: 10 } : popoverPos(at.x, at.y, 320, 160)} aria-label="New comment" {...stop}>
        {d.anchor.w ? <div className="cmt-area-label">Comment on this area</div> : null}
        <Composer
          placeholder="Add a comment"
          people={people}
          submitLabel="Post comment"
          onCancel={() => draft.set(null)}
          onSubmit={(text, mentions) => {
            const id = newId();
            const ok = writeComments(editor, (meta) => createThread(meta, { id, messageId: newId(), anchor: d.anchor, text, who: me, now: nowIso(), mentions }));
            if (ok) {
              draft.set(null);
              openThread.set(id);
            }
            return ok;
          }}
        />
      </section>
    </>
  );
}

// ---------- pins ----------

function Pin({ editor, thread, at, unread, open }: { editor: Editor; thread: CommentThread; at: { x: number; y: number }; unread: boolean; open: boolean }) {
  const first = firstMessage(thread);
  const replies = Object.keys(thread.messages).length - 1;
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const start = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const pos = drag ? { left: at.x + drag.dx, top: at.y + drag.dy } : { left: at.x, top: at.y };
  return (
    <div
      className={`cmt-pin ${thread.resolved ? "resolved" : ""} ${unread ? "unread" : ""} ${open ? "open" : ""} ${drag ? "dragging" : ""}`}
      style={pos}
      data-thread-id={thread.id}
      role="button"
      aria-label={`Comment by ${first.author}: ${first.text.slice(0, 60)}`}
      onContextMenu={(e) => e.stopPropagation()}
      onPointerEnter={() => hoverThread.set(thread.id)}
      onPointerLeave={() => hoverThread.get() === thread.id && hoverThread.set(null)}
      onPointerDown={(e) => {
        e.stopPropagation();
        if (e.button !== 0) return;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, y: e.clientY, moved: false };
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (!s || editor.getIsReadonly()) return;
        const dx = e.clientX - s.x;
        const dy = e.clientY - s.y;
        if (!s.moved && Math.hypot(dx, dy) < 4) return;
        s.moved = true;
        setDrag({ dx, dy });
      }}
      onPointerUp={(e) => {
        e.stopPropagation();
        const s = start.current;
        start.current = null;
        if (s?.moved && drag) {
          const page = editor.screenToPage({ x: at.x + drag.dx, y: at.y + drag.dy });
          writeComments(editor, (meta) => moveThread(meta, thread.id, anchorAt(editor, page)));
          setDrag(null);
          return;
        }
        setDrag(null);
        draft.set(null);
        openThread.set(open ? null : thread.id);
        if (!open && window.innerWidth <= NARROW) revealPin(editor, editor.screenToPage(at), 200);
      }}
      onPointerCancel={() => {
        start.current = null;
        setDrag(null);
      }}
    >
      <Avatar id={first.authorId} name={first.author} />
      {thread.resolved ? <span className="cmt-pin-check">✓</span> : null}
      {!open && !drag ? (
        <div className="cmt-pin-preview">
          <div className="cmt-msg-head">
            <strong>{first.author}</strong>
            <time>{ago(first.createdAt)}</time>
          </div>
          <p>{first.text.length > 140 ? `${first.text.slice(0, 140)}…` : first.text}</p>
          {replies ? <span className="cmt-replies">{replies} {replies === 1 ? "reply" : "replies"}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------- the panel (comment mode) ----------

function Panel({ editor, threads, marks, onClose }: { editor: Editor; threads: CommentThread[]; marks: Record<string, string>; onClose(): void }) {
  const me = who();
  const [q, setQ] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [mineOnly, setMineOnly] = useState(false);
  const resolved = useValue("comment-show-resolved", () => showResolved.get(), []);
  const pins = useValue("comment-show-pins", () => showPins.get(), []);
  const open = useValue("comment-open", () => openThread.get(), []);
  const list = threads
    .filter((t) => resolved || !t.resolved)
    .filter((t) => !unreadOnly || isUnread(t, marks, me.userId))
    .filter((t) => !mineOnly || Object.values(t.messages).some((m) => m.authorId === me.userId || m.text.includes(`@${me.userName}`)))
    .filter((t) => !q.trim() || Object.values(t.messages).some((m) => `${m.author} ${m.text}`.toLowerCase().includes(q.trim().toLowerCase())))
    .sort((a, b) => lastActivity(b).localeCompare(lastActivity(a)));
  return (
    <aside className="cmt-panel" aria-label="Comments" {...stop}>
      <header>
        <strong>Comments</strong>
        <span className="cmt-count">{threads.filter((t) => !t.resolved).length} open</span>
        <button type="button" className="cmt-icon" title="Hide panel" aria-label="Hide comments panel" onClick={onClose}>
          ×
        </button>
      </header>
      <input className="cmt-search" type="search" placeholder="Search comments" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="cmt-filters">
        <label>
          <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} /> Unread
        </label>
        <label>
          <input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} /> Mine & mentions
        </label>
        <label>
          <input type="checkbox" checked={resolved} onChange={(e) => showResolved.set(e.target.checked)} /> Resolved
        </label>
        <label title="Show comment pins outside comment mode (Shift+C)">
          <input type="checkbox" checked={pins} onChange={(e) => setShowPins(e.target.checked)} /> Pins outside comment mode
        </label>
      </div>
      <ul className="cmt-list">
        {list.length === 0 ? <li className="cmt-empty">{threads.length ? "No comments match." : "Click anywhere on the board to leave a comment."}</li> : null}
        {list.map((t) => {
          const first = firstMessage(t);
          const replies = Object.keys(t.messages).length - 1;
          const unread = isUnread(t, marks, me.userId);
          return (
            <li key={t.id}>
              <button
                type="button"
                className={`cmt-list-item ${open === t.id ? "on" : ""} ${t.resolved ? "resolved" : ""}`}
                onClick={() => {
                  draft.set(null);
                  openThread.set(t.id);
                  // On a phone the panel covers the board: get out of the way of the thread.
                  if (window.innerWidth <= 700) onClose();
                  revealPin(editor, pinPagePoint(editor, t.anchor), 250);
                }}
              >
                <div className="cmt-msg-head">
                  <Avatar id={first.authorId} name={first.author} />
                  <strong>{first.author}</strong>
                  <time>{ago(lastActivity(t))}</time>
                  {unread ? <span className="cmt-dot" aria-label="Unread" /> : null}
                </div>
                <p>{first.text.length > 160 ? `${first.text.slice(0, 160)}…` : first.text}</p>
                <span className="cmt-replies">
                  {replies ? `${replies} ${replies === 1 ? "reply" : "replies"}` : ""}
                  {t.resolved ? `${replies ? " · " : ""}Resolved` : ""}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

// ---------- what a comment is attached to ----------

// Outline the shape a pin follows, or the commented area, while its thread is hovered, open
// or being written, and the area being dragged out in comment mode.
function Attachment({ editor }: { editor: Editor }) {
  const boxes = useValue(
    "comment-attachment",
    () => {
      const out: { key: string; kind: "shape" | "area"; x: number; y: number; w: number; h: number }[] = [];
      const drag = areaDrag.get();
      const screenBox = (pts: { x: number; y: number }[]) => {
        const s = pts.map((p) => editor.pageToScreen(p));
        const xs = s.map((p) => p.x);
        const ys = s.map((p) => p.y);
        return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
      };
      if (drag) out.push({ key: "drag", kind: "area", ...screenBox([{ x: drag.x, y: drag.y }, { x: drag.x + drag.w, y: drag.y + drag.h }]) });
      const d = draft.get();
      const ids = [openThread.get(), hoverThread.get()].filter((x): x is string => !!x);
      const threads = pageThreads(editor);
      const anchors = [...(d ? [{ key: "draft", a: d.anchor }] : []), ...ids.filter((id) => threads[id]).map((id) => ({ key: id, a: threads[id].anchor }))];
      for (const { key, a } of anchors) {
        const corners = areaCorners(editor, a);
        if (corners) out.push({ key: `${key}-area`, kind: "area", ...screenBox(corners) });
        const shape = a.shapeId ? editor.getShape(a.shapeId as TLShapeId) : undefined;
        const b = shape && editor.getAncestorPageId(shape) === editor.getCurrentPageId() ? editor.getShapePageBounds(shape) : null;
        if (b) out.push({ key: `${key}-shape`, kind: "shape", ...screenBox([{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.maxY }]) });
      }
      return out;
    },
    [editor],
  );
  return (
    <>
      {boxes.map((b) => (
        <div key={b.key} className={`cmt-attach ${b.kind}`} style={{ left: b.x, top: b.y, width: b.w, height: b.h }} />
      ))}
    </>
  );
}

// Bring a pin into view. On a phone it goes in the upper part, above the thread sheet.
function revealPin(editor: Editor, page: { x: number; y: number }, duration: number) {
  if (window.innerWidth > NARROW) {
    editor.centerOnPoint(page, { animation: { duration } });
    return;
  }
  const vv = window.visualViewport;
  const target = { x: (vv?.width ?? window.innerWidth) / 2, y: (vv?.offsetTop ?? 0) + (vv?.height ?? window.innerHeight) * 0.22 };
  const now = editor.pageToScreen(page);
  const cam = editor.getCamera();
  const z = editor.getZoomLevel();
  editor.setCamera({ x: cam.x + (target.x - now.x) / z, y: cam.y + (target.y - now.y) / z, z: cam.z }, { animation: { duration } });
}

// ---------- the layer ----------

export function Comments({ editor }: { editor: Editor }) {
  const mode = useIsCommentMode(editor);
  const pinsOn = useValue("comment-show-pins", () => showPins.get(), []);
  const resolved = useValue("comment-show-resolved", () => showResolved.get(), []);
  const open = useValue("comment-open", () => openThread.get(), []);
  const marks = useValue("comment-read", () => readMarks(editor), [editor]);
  const ui = useContext(BoardUiCtx);
  const [panel, setPanel] = useState(() => window.innerWidth > 700);
  const threadsById = useValue("comment-threads", () => pageThreads(editor), [editor]);
  const threads = useMemo(() => Object.values(threadsById), [threadsById]);
  const people = usePeople(editor, threads);
  const agentFrames = useAgentFrames(editor);
  const visible = mode || pinsOn || !!open;
  // Screen points for every pin, the open thread and the draft; recomputed on camera moves.
  const points = useValue(
    "comment-points",
    () => {
      const out: Record<string, { x: number; y: number }> = {};
      if (!visible) return out;
      for (const t of Object.values(pageThreads(editor))) out[t.id] = editor.pageToScreen(pinPagePoint(editor, t.anchor));
      const d = draft.get();
      if (d) out["__draft"] = editor.pageToScreen(pinPagePoint(editor, d.anchor));
      return out;
    },
    [editor, visible],
  );

  // Errors from comment writes (validation, a thread someone else deleted).
  useEffect(() => {
    const on = (e: Event) => ui.toast((e as CustomEvent<string>).detail);
    window.addEventListener("paseo-comment-error", on);
    return () => window.removeEventListener("paseo-comment-error", on);
  }, [ui]);

  // Esc closes the open thread outside comment mode too.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      // A text box handles its own Esc (cancel the edit, close the mention list).
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
      if (e.key === "Escape" && (openThread.get() || draft.get()) && editor.getCurrentToolId() !== COMMENT_TOOL) {
        e.stopPropagation();
        closeAll();
      }
    };
    window.addEventListener("keydown", on, { capture: true });
    return () => window.removeEventListener("keydown", on, { capture: true });
  }, [editor]);

  // Leaving comment mode closes the draft; a thread that disappears closes.
  useEffect(() => {
    if (!mode) draft.set(null);
  }, [mode]);
  useEffect(() => {
    if (open && !threadsById[open]) openThread.set(null);
  }, [open, threadsById]);

  // Deep link: ?comment=<id> opens comment mode on that thread once it has synced.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("comment");
    if (!id) return;
    let done = false;
    const go = () => {
      if (done) return;
      const t = pageThreads(editor)[id];
      if (!t) return;
      done = true;
      editor.setCurrentTool(COMMENT_TOOL);
      if (t.resolved) showResolved.set(true);
      openThread.set(id);
      revealPin(editor, pinPagePoint(editor, t.anchor), 300);
    };
    go();
    const stopListen = editor.store.listen(go, { scope: "document" });
    const timer = setTimeout(stopListen, 15000);
    return () => {
      stopListen();
      clearTimeout(timer);
    };
  }, [editor]);

  const me = who().userId;
  const openT = open ? threadsById[open] : null;
  const unreadCount = threads.filter((t) => !t.resolved && isUnread(t, marks, me)).length;
  return (
    <AgentFramesCtx.Provider value={agentFrames}>
      <Attachment editor={editor} />
      {visible
        ? threads
            .filter((t) => resolved || !t.resolved || t.id === open)
            .map((t) => (points[t.id] ? <Pin key={t.id} editor={editor} thread={t} at={points[t.id]} unread={isUnread(t, marks, me)} open={t.id === open} /> : null))
        : null}
      {/* Cards render above tldraw's own UI (its toolbars sit in a higher layer than
          anything in front of the canvas; on a phone they covered the thread sheet). */}
      {createPortal(
        <>
          {openT && points[openT.id] ? <ThreadCard key={openT.id} editor={editor} thread={openT} at={points[openT.id]} people={people} /> : null}
          {points.__draft ? <DraftCard editor={editor} at={points.__draft} people={people} /> : null}
          {mode && panel ? <Panel editor={editor} threads={threads} marks={marks} onClose={() => setPanel(false)} /> : null}
          {mode && !panel ? (
            <button type="button" className="cmt-panel-chip" onClick={() => setPanel(true)} {...stop}>
              Comments · {threads.filter((t) => !t.resolved).length}
              {unreadCount ? <span className="cmt-dot" /> : null}
            </button>
          ) : null}
        </>,
        document.body,
      )}
      {mode ? <div className="cmt-mode-hint">Comment mode · click to comment · Esc to exit</div> : null}
    </AgentFramesCtx.Provider>
  );
}

export function CommentToolIcon() {
  return (
    <div className="cmt-tool-icon">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 12a8 8 0 1 1 3.2 6.4L4 20l.9-3.6A8 8 0 0 1 4 12Z" />
      </svg>
    </div>
  );
}
