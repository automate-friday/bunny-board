// Figma-style comment threads, stored in the page record's meta. tldraw sync diffs a
// record's meta one level deep (diff.ts: meta keys are patched, their values are Put
// whole), so every thread and every message has its own meta key:
//   paseoCommentThread:<threadId>          -> thread header (anchor, root, resolved)
//   paseoCommentMsg:<threadId>:<messageId> -> one message
// Two people posting, replying or resolving at once touch different keys and merge.
// Writes to the same key (two reactions on one message at the same instant, a move racing
// a resolve) are still last-writer-wins.
// Comments are not shapes: they never move with layout tools, never enter undo history, and
// tldraw's selection and frame membership ignore them.

export const COMMENT_MAX_LENGTH = 4000;
export const THREAD_PREFIX = "paseoCommentThread:";
export const MESSAGE_PREFIX = "paseoCommentMsg:";
export const READ_PREFIX = "paseoCommentRead:";
// What an agent receives: delivered even to frames that only take deltas on demand.
export const COMMENT_DELTA_PREFIX = "Board comment";
export const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "👀", "✅"] as const;

export interface CommentMessage {
  id: string;
  authorId: string;
  author: string;
  text: string;
  createdAt: string;
  editedAt?: string;
  // Agent frames picked from the @ suggestions (frame ids), so a mention survives renames
  // and two frames with one name.
  mentions?: string[];
  // emoji -> userId -> display name
  reactions?: Record<string, Record<string, string>>;
}

export interface CommentAnchor {
  // The shape the pin follows (moves, resizes and nests with it), or null for bare canvas.
  shapeId: string | null;
  // Point in the shape's own space when shapeId is set, else in page space.
  x: number;
  y: number;
  // Last known page point, used when the shape has been deleted.
  pageX: number;
  pageY: number;
  // Area comments: the area's size, in the same space as x/y (x/y is its top-left).
  w?: number;
  h?: number;
}

export interface CommentThread {
  id: string;
  anchor: CommentAnchor;
  createdAt: string;
  authorId: string;
  // The opening message: it decides the pin's author, and deleting it deletes the thread.
  rootId: string;
  resolved: { by: string; at: string } | null;
  // Agent frames the thread was sent to ("Send to agent…").
  shares?: string[];
  messages: Record<string, CommentMessage>;
}

type ThreadHeader = Omit<CommentThread, "messages">;
type Meta = Record<string, unknown>;

export type Threads = Record<string, CommentThread>;
export interface Who { userId: string; userName: string }

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown) => typeof v === "string";

const strList = (v: unknown) => v === undefined || (Array.isArray(v) && v.every(str));

function validMessage(m: unknown): m is CommentMessage {
  return isObj(m) && str(m.id) && str(m.authorId) && str(m.author) && str(m.text) && str(m.createdAt) && strList(m.mentions);
}

function validHeader(t: unknown): t is ThreadHeader {
  if (!isObj(t) || !str(t.id) || !str(t.createdAt) || !str(t.authorId) || !str(t.rootId) || !strList(t.shares)) return false;
  const a = t.anchor;
  const size = (v: unknown) => v === undefined || (num(v) && (v as number) > 0);
  return isObj(a) && (a.shapeId === null || str(a.shapeId)) && num(a.x) && num(a.y) && num(a.pageX) && num(a.pageY) && size(a.w) && size(a.h);
}

const threadKey = (id: string) => `${THREAD_PREFIX}${id}`;
const messageKey = (threadId: string, id: string) => `${MESSAGE_PREFIX}${threadId}:${id}`;

// Every valid thread in a page's meta. Invalid entries are skipped (never rewritten, so a
// newer client's data survives older ones). A thread whose opening message has not
// arrived (or was deleted) is not shown.
export function readThreads(meta: unknown): Threads {
  if (!isObj(meta)) return {};
  const out: Threads = {};
  for (const [k, v] of Object.entries(meta)) {
    if (k.startsWith(THREAD_PREFIX) && validHeader(v) && k === threadKey(v.id)) out[v.id] = { ...v, messages: {} };
  }
  for (const [k, v] of Object.entries(meta)) {
    if (!k.startsWith(MESSAGE_PREFIX) || !validMessage(v)) continue;
    const rest = k.slice(MESSAGE_PREFIX.length);
    const threadId = rest.slice(0, rest.length - v.id.length - 1);
    if (rest !== `${threadId}:${v.id}` || !out[threadId]) continue;
    out[threadId].messages[v.id] = v;
  }
  for (const [id, t] of Object.entries(out)) if (!t.messages[t.rootId]) delete out[id];
  return out;
}

export function orderedMessages(t: CommentThread): CommentMessage[] {
  const root = t.messages[t.rootId];
  const rest = Object.values(t.messages).filter((m) => m.id !== t.rootId).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return root ? [root, ...rest] : rest;
}

export function firstMessage(t: CommentThread): CommentMessage {
  return t.messages[t.rootId] ?? orderedMessages(t)[0];
}

export function lastActivity(t: CommentThread): string {
  const times = orderedMessages(t).map((m) => m.editedAt && m.editedAt > m.createdAt ? m.editedAt : m.createdAt);
  return [t.resolved?.at ?? "", ...times].sort().at(-1) ?? t.createdAt;
}

function cleanText(text: string): string {
  const t = text.trim();
  if (!t || t.length > COMMENT_MAX_LENGTH) throw new Error(`Comments must contain 1–${COMMENT_MAX_LENGTH} characters.`);
  return t;
}

function base(meta: unknown): Meta {
  return isObj(meta) ? { ...meta } : {};
}

function header(t: CommentThread): ThreadHeader {
  const { messages: _m, ...h } = t;
  return h;
}

function live(meta: unknown, threadId: string): CommentThread {
  const t = readThreads(meta)[threadId];
  if (!t) throw new Error("That comment thread no longer exists.");
  return t;
}

const withMentions = (m: CommentMessage, mentions?: string[]): CommentMessage => (mentions?.length ? { ...m, mentions: [...new Set(mentions)] } : m);

export function createThread(meta: unknown, a: { id: string; messageId: string; anchor: CommentAnchor; text: string; who: Who; now: string; mentions?: string[] }): Meta {
  const msg = withMentions({ id: a.messageId, authorId: a.who.userId, author: a.who.userName, text: cleanText(a.text), createdAt: a.now }, a.mentions);
  const head: ThreadHeader = { id: a.id, anchor: a.anchor, createdAt: a.now, authorId: a.who.userId, rootId: msg.id, resolved: null };
  return { ...base(meta), [threadKey(a.id)]: head, [messageKey(a.id, msg.id)]: msg };
}

export function addReply(meta: unknown, threadId: string, a: { messageId: string; text: string; who: Who; now: string; mentions?: string[] }): Meta {
  const text = cleanText(a.text);
  live(meta, threadId);
  // A reply leaves a resolved thread resolved until someone unresolves it.
  return { ...base(meta), [messageKey(threadId, a.messageId)]: withMentions({ id: a.messageId, authorId: a.who.userId, author: a.who.userName, text, createdAt: a.now }, a.mentions) };
}

function message(meta: unknown, threadId: string, messageId: string): CommentMessage {
  const m = live(meta, threadId).messages[messageId];
  if (!m) throw new Error("That comment no longer exists.");
  return m;
}

export function editMessage(meta: unknown, threadId: string, messageId: string, text: string, who: Who, now: string): Meta {
  const clean = cleanText(text);
  const m = message(meta, threadId, messageId);
  if (m.authorId !== who.userId) throw new Error("Only the author can edit a comment.");
  return { ...base(meta), [messageKey(threadId, messageId)]: { ...m, text: clean, editedAt: now } };
}

export function deleteThread(meta: unknown, threadId: string): Meta {
  const out = base(meta);
  delete out[threadKey(threadId)];
  for (const k of Object.keys(out)) if (k.startsWith(`${MESSAGE_PREFIX}${threadId}:`)) delete out[k];
  return out;
}

// Deleting the opening message deletes the thread (as in Figma).
export function deleteMessage(meta: unknown, threadId: string, messageId: string, who: Who): Meta {
  const t = live(meta, threadId);
  const m = t.messages[messageId];
  if (!m) return base(meta);
  if (m.authorId !== who.userId) throw new Error("Only the author can delete a comment.");
  if (messageId === t.rootId) return deleteThread(meta, threadId);
  const out = base(meta);
  delete out[messageKey(threadId, messageId)];
  return out;
}

export function setResolved(meta: unknown, threadId: string, resolved: boolean, who: Who, now: string): Meta {
  const t = live(meta, threadId);
  return { ...base(meta), [threadKey(threadId)]: { ...header(t), resolved: resolved ? { by: who.userName, at: now } : null } };
}

export function toggleReaction(meta: unknown, threadId: string, messageId: string, emoji: string, who: Who): Meta {
  const m = message(meta, threadId, messageId);
  const reactions = { ...(m.reactions ?? {}) };
  const users = { ...(reactions[emoji] ?? {}) };
  if (users[who.userId]) delete users[who.userId];
  else users[who.userId] = who.userName;
  if (Object.keys(users).length) reactions[emoji] = users;
  else delete reactions[emoji];
  return { ...base(meta), [messageKey(threadId, messageId)]: { ...m, reactions } };
}

// "Send to agent…": the frame's agent gets the thread and may reply in it.
export function shareThread(meta: unknown, threadId: string, frameId: string): Meta {
  const t = live(meta, threadId);
  if (t.shares?.includes(frameId)) return base(meta);
  return { ...base(meta), [threadKey(threadId)]: { ...header(t), shares: [...(t.shares ?? []), frameId] } };
}

// Frames a push newly shared threads with.
export function addedShares(before: unknown, after: unknown): { thread: CommentThread; frameId: string }[] {
  const was = readThreads(before);
  const out: { thread: CommentThread; frameId: string }[] = [];
  for (const t of Object.values(readThreads(after))) {
    const old = new Set(was[t.id]?.shares ?? []);
    for (const f of t.shares ?? []) if (!old.has(f)) out.push({ thread: t, frameId: f });
  }
  return out;
}

export function moveThread(meta: unknown, threadId: string, anchor: CommentAnchor): Meta {
  const t = live(meta, threadId);
  return { ...base(meta), [threadKey(threadId)]: { ...header(t), anchor } };
}

// @mentions: "@Name" where Name is a known person (longest match wins), for highlighting.
export function splitMentions(text: string, names: string[]): { text: string; mention: boolean }[] {
  const sorted = [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length);
  const out: { text: string; mention: boolean }[] = [];
  let buf = "";
  for (let i = 0; i < text.length; ) {
    if (text[i] === "@" && (i === 0 || /\s|\(/.test(text[i - 1]))) {
      const hit = sorted.find((n) => text.slice(i + 1, i + 1 + n.length).toLowerCase() === n.toLowerCase());
      if (hit) {
        if (buf) out.push({ text: buf, mention: false });
        buf = "";
        out.push({ text: text.slice(i, i + 1 + hit.length), mention: true });
        i += 1 + hit.length;
        continue;
      }
    }
    buf += text[i++];
  }
  if (buf) out.push({ text: buf, mention: false });
  return out;
}

// ---------- people (cross-device) ----------

// A person is their board name, so the same name on a phone and a laptop is one author with
// one read state. (The board has no accounts: the name is who you say you are.)
export function personId(name: string): string {
  return `person:${name.trim().toLowerCase().replace(/\s+/g, " ")}`;
}

export function agentPersonId(agentId: string): string {
  return `agent:${agentId}`;
}

const readKey = (person: string, threadId: string) => `${READ_PREFIX}${person}:${threadId}`;

// Read marks live in the page meta too, so they follow the person across devices.
export function readMarksFor(meta: unknown, person: string): Record<string, string> {
  if (!isObj(meta)) return {};
  const prefix = `${READ_PREFIX}${person}:`;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta)) if (k.startsWith(prefix) && str(v)) out[k.slice(prefix.length)] = v as string;
  return out;
}

export function setReadMark(meta: unknown, person: string, threadId: string, at: string | null): Meta {
  const out = base(meta);
  if (at) out[readKey(person, threadId)] = at;
  else delete out[readKey(person, threadId)];
  return out;
}

export function isUnreadFor(t: CommentThread, marks: Record<string, string>, person: string): boolean {
  const seen = marks[t.id] ?? "";
  return orderedMessages(t).some((m) => m.authorId !== person && m.createdAt > seen);
}

// Messages present in `after` and not in `before` (what a push added), oldest first.
export function addedMessages(before: unknown, after: unknown): { thread: CommentThread; message: CommentMessage; isNew: boolean }[] {
  const was = isObj(before) ? before : {};
  const threads = readThreads(after);
  const out: { thread: CommentThread; message: CommentMessage; isNew: boolean }[] = [];
  for (const t of Object.values(threads)) {
    for (const m of Object.values(t.messages)) {
      if (was[messageKey(t.id, m.id)] !== undefined) continue;
      out.push({ thread: t, message: m, isNew: m.id === t.rootId });
    }
  }
  return out.sort((a, b) => a.message.createdAt.localeCompare(b.message.createdAt));
}
