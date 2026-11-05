import { bunnyEnv } from "./bunny-env";
// The board organizer the user talks to from the ⌘⇧P popover (or the bunny in the corner).
// Each request carries what his screen shows: the viewport, the selection, and the frames
// in view with their contents and agents. One model turn (server/organizer-brain.ts)
// returns a list of actions; the server applies them together, with prompts to frame
// agents sent in parallel. Requests sent while one is running wait in a per-board queue.
// Every board change a request makes is recorded, so one Undo puts the request back.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createShapeId, toRichText } from "@tldraw/tlschema";
import { getIndexAbove } from "@tldraw/utils";
import { isComponent } from "../shared/components";
import { TRANSCRIPT_SIZE, TRANSCRIPT_TYPE, transcriptDefaults } from "../shared/components/transcript";
import { boardDirectory, ensureBoardDirectory } from "./agent-context";
import type { BoardConfig } from "./config";
import type { FrameWatcher } from "./frame-watcher";
import { type Box, childBoxes, layoutPositions, overlaps } from "./layout";
import { BRAIN_MODEL, OrganizerBrain } from "./organizer-brain";
import { frameOutline } from "./outline";
import type { PaseoBridge } from "./paseo-bridge";
import { absPos, baseShape, buildShape, defaultSize, isShape, nextIndex, noteGrowY, quote, type Rec, type ShapeSpec, shapeSize, shapeText } from "./records";
import type { BoardHost, BoardRoom } from "./room-host";

const CREATABLE = ["note", "text", "box", "ellipse", "frame", "bookmark", "link", "checklist"];
const COLORS = ["black", "grey", "light-violet", "violet", "blue", "light-blue", "yellow", "orange", "green", "light-green", "light-red", "red", "white"];

const INSTRUCTIONS = `You are the board organizer for a shared tldraw whiteboard. The user types requests in a popover over the board. The board has several pages; you are told which page the user is on and what is on the other pages. A frame can be on any page: "my kanban board" means the frame that works as one (columns of cards), whatever it is named. Each request comes with the part of the board he pointed you at (the whole board, his view, his selection or an area he dragged), with the frames there, their contents and the agent bound to each frame, plus a one-line list of the rest of the board.
Answer with JSON only: a list of actions the board server will apply all at once, and a one-sentence summary for the user of what those actions do (past tense, as if done). Never mention actions you did not list, and never call something unavailable that you did with the listed actions.
Actions (unused fields are null):
- create: type note|text|box|ellipse|frame|link|bookmark|checklist. To add a card to a column, set parentId to the board frame and below to the column's header id (or a card in that column): the server stacks it under the last card there. Prefer below over x/y inside boards. parentId = a frame id (x,y frame-relative) or null (x,y page). Give it a ref ("a", "b"…) if a later action in this list uses it as parentId. Notes are 200 px wide: put them on a 240 px grid inside frames (x 20, 260, 500…; y 50, 290…). New frames go in empty space with 60 px around them. checklist: text = items, one per line. link: url.
- edit: id, text (a frame's name for frames) and/or color.
- delete: id (a frame takes its contents).
- duplicate: id of a shape or frame (a frame is copied with its contents). x,y = where the copy goes (page for top-level shapes, frame-relative inside a frame); null puts it beside the original.
- move: id of any shape. x,y are page coordinates for top-level shapes and frame-relative for shapes inside a frame. parentId moves it into another frame (or "page" to take it out). w,h resize a frame or box.
To rearrange shapes inside a frame (a row, reverse order, priority order), move each one; widen the frame with a move of the frame itself (w) if they no longer fit.
- tidy: id of a frame; re-flows its shapes.
- prompt: id of a frame with an agent, text = the message to that agent (e.g. ask it to make something). Only when the user asks for that agent to do something.
- look: id of a frame (on any page) whose contents you need to see before acting: its columns, cards and free space. Send only look actions in that answer; you get the contents and answer again. At most 2 looks.
Rule: when the request is about a frame you only have a one-line entry for (for example "my kanban board", "the roadmap", a frame on another page), your first answer MUST be look actions for the most likely frame(s). Never say you cannot find something before you have looked. If several frames could be meant (two boards with columns), look at them and choose the one whose cards are about the same kind of work as the request (a product feature request belongs on the board of feature/bug cards, not on a video review board); add to one frame only. To add a card to a board with columns, look first, then create it as a direct child of that board frame with below = a COLUMN HEADER id: a new task or idea goes under the IDEAS (or PLANNED) header unless the user names a column. Never put a new task inside another card, and never under a row that has no header. A card's text keeps every part of what the user asked for, in their terms: never drop a part, and "X or Y" in a feature request means the feature offers both.
- pin: id of a frame, agentId = an agent on this board: a live transcript card of that agent in that frame. "A link to the transcript" of a frame means pin with that frame's own agent.
Everything except prompt is undone with one click, so act; never ask for confirmation. "This", "that rectangle", "here" mean the selection or what is in view. Use shape ids exactly as given, including the "shape:" prefix. Never invent shape ids or agents. If you cannot do something, leave it out and say why in the summary. A question gets an answer in the summary and no actions.`;

const NUM = { type: ["number", "null"] };
const STR = { type: ["string", "null"] };
export const DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["actions", "summary"],
  properties: {
    summary: { type: "string" },
    actions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["op", "id", "ref", "type", "parentId", "below", "x", "y", "w", "h", "text", "color", "url", "agentId"],
        properties: {
          op: { type: "string", enum: ["create", "edit", "delete", "duplicate", "move", "tidy", "prompt", "pin", "look"] },
          id: STR,
          ref: STR,
          type: { type: ["string", "null"], enum: [...CREATABLE, null] },
          parentId: STR,
          below: STR,
          x: NUM,
          y: NUM,
          w: NUM,
          h: NUM,
          text: STR,
          color: { type: ["string", "null"], enum: [...COLORS, null] },
          url: STR,
          agentId: STR,
        },
      },
    },
  },
};

interface Action {
  op: "create" | "edit" | "delete" | "duplicate" | "move" | "tidy" | "prompt" | "pin" | "look";
  id: string | null;
  ref: string | null;
  type: string | null;
  parentId: string | null;
  // create/move: put it under this shape (a column header or card) and under everything
  // already stacked below it in that column. The server computes x/y.
  below?: string | null;
  x: number | null;
  y: number | null;
  w: number | null;
  h: number | null;
  text: string | null;
  color: string | null;
  url: string | null;
  agentId: string | null;
}

export interface OrganizerRun {
  id: string;
  text: string;
  at: number;
  startedAt?: number;
  finishedAt?: number;
  status: "queued" | "working" | "done" | "error";
  // What it is doing right now, for the live line in the bubble.
  phase?: string;
  phaseAt?: number;
  summary: string | null;
  // Each touched record as it was before the request (null: the request created it).
  before: Record<string, Rec | null>;
  // ...and as the request left it (null: it deleted it). Undo only puts back records that
  // still look like this, so later edits are never overwritten.
  after?: Record<string, Rec | null>;
  prompted: string[];
  undone: boolean;
  // Where the user was looking when they sent it; the board itself is read when the request starts.
  viewport?: Viewport;
  selected?: string[];
  scope?: ScopeKind;
  area?: Viewport;
  // The page the user was on; page-level actions happen there.
  pageId?: string;
  screen: string;
}
interface BoardState {
  runs: OrganizerRun[];
}
// What the user pointed the organizer at, like the macOS screenshot bar: the whole board,
// his view, his selection, or an area he dragged.
export type ScopeKind = "board" | "view" | "selection" | "area";

export interface Viewport {
  x: number;
  y: number;
  w: number;
  h: number;
}

// The model behind the organizer (server/organizer-brain.ts); tests pass a fake.
export interface Brain {
  decide(key: string, cwd: string, text: string, schema: object, followUp?: (answer: string) => string | null): Promise<string>;
  warm(key: string, cwd: string): void;
  state(key: string): "cold" | "starting" | "warming" | "warm";
  stop(): void;
}

export class OrganizerError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

const r0 = (n: number) => Math.round(n);
const SCREEN_BUDGET = 9000;
const PARALLEL = Number(bunnyEnv("ORGANIZER_PARALLEL") ?? 3);

export class Organizer {
  private readonly file: string;
  // A prototype-free map: board ids come from URLs (a board named "__proto__" must not reach
  // Object.prototype).
  private state: Record<string, BoardState> = Object.create(null);
  private readonly brain: Brain;

  constructor(
    private readonly cfg: BoardConfig,
    private readonly host: BoardHost,
    private readonly watcher: FrameWatcher,
    private readonly bridge: PaseoBridge,
    private readonly log: (m: string) => void,
    brain?: Brain,
  ) {
    this.file = path.join(cfg.stateDir, "organizer.json");
    try {
      if (existsSync(this.file)) {
        const saved = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, BoardState>;
        for (const k of Object.keys(saved)) if (k !== "__proto__" && k !== "constructor" && k !== "prototype") this.state[k] = saved[k];
      }
    } catch (e) {
      log(`organizer: could not read ${this.file}: ${(e as Error).message}`);
    }
    // Requests a restart interrupted will not finish.
    for (const b of Object.values(this.state))
      for (const r of b.runs ?? []) {
        // Older (v1/v2) entries lack these.
        r.before ??= {};
        r.prompted ??= [];
        r.screen ??= "";
        if (r.status === "queued" || r.status === "working") {
          r.status = "error";
          r.summary = "Interrupted by a board server restart; send it again.";
        }
      }
    this.brain = brain ?? new OrganizerBrain(INSTRUCTIONS, log);
  }

  stop(): void {
    this.brain.stop();
  }

  private save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    // Compact, and the screen text of finished runs is not kept (it is only for the prompt).
    writeFileSync(this.file, JSON.stringify(this.state));
  }

  private board(boardId: string): BoardState {
    const b = (this.state[boardId] ??= { runs: [] });
    b.runs ??= [];
    return b;
  }

  private room(boardId: string): BoardRoom {
    if (!this.host.exists(boardId)) throw new OrganizerError("unknown board", 404);
    return this.host.get(boardId);
  }

  // --- UI side ------------------------------------------------------------------------------

  status(boardId: string) {
    this.room(boardId);
    const runs = this.board(boardId).runs;
    return {
      model: BRAIN_MODEL,
      brain: this.brain.state(boardId),
      run: runs.length ? this.publicRun(runs.at(-1)!) : null,
      queued: runs.filter((r) => r.status === "queued").length,
      runs: runs.slice(-8).map((r) => this.publicRun(r)),
    };
  }

  private publicRun(r: OrganizerRun) {
    const secs = r.finishedAt && r.startedAt ? Math.round((r.finishedAt - r.startedAt) / 100) / 10 : null;
    // Shapes the request touched, so the canvas can highlight them when it finishes.
    const changedIds = Object.keys(r.before).filter((k) => k.startsWith("shape:")).slice(0, 60);
    return { id: r.id, text: r.text, at: r.at, status: r.status, phase: r.status === "working" ? (r.phase ?? null) : null, phaseAt: r.phaseAt ?? null, summary: r.summary, moved: Object.keys(r.before).length, prompted: r.prompted.length, undone: r.undone, seconds: secs, scope: r.scope ?? "view", changedIds, promptedIds: r.prompted, finishedAt: r.finishedAt ?? null };
  }

  warm(boardId: string) {
    this.room(boardId);
    void ensureBoardDirectory(this.cfg,boardId).then(cwd=>this.brain.warm(boardId,cwd)).catch(e=>this.log(`organizer workspace: ${e.message}`));
    return { ok: true };
  }

  ask(boardId: string, text: string, viewport: Viewport, selected: string[], scope: ScopeKind = "view", area?: Viewport, pageId?: string) {
    const room = this.room(boardId);
    if (!text.trim()) throw new OrganizerError("say what to do");
    if (text.length > 4000) throw new OrganizerError("keep the request under 4000 characters");
    const b = this.board(boardId);
    const run: OrganizerRun = { id: randomUUID(), text: text.trim(), at: Date.now(), status: "queued", summary: null, before: {}, prompted: [], undone: false, viewport, selected, scope, area, pageId: pageId && room.records.get(pageId)?.typeName === "page" ? pageId : undefined, screen: "" };
    b.runs.push(run);
    b.runs = b.runs.slice(-30);
    this.save();
    this.pump(boardId);
    return this.publicRun(run);
  }

  // Up to PARALLEL requests per board run at once, each in its own short-lived thread;
  // the rest wait in order.
  private pump(boardId: string): void {
    const runs = this.board(boardId).runs;
    let running = runs.filter((r) => r.status === "working").length;
    for (const r of runs) {
      if (running >= PARALLEL) break;
      if (r.status !== "queued") continue;
      r.status = "working";
      running++;
      void this.execute(boardId, r).finally(() => this.pump(boardId));
    }
  }

  private phase(run: OrganizerRun, text: string): void {
    run.phase = text;
    run.phaseAt = Date.now();
  }

  private async execute(boardId: string, run: OrganizerRun): Promise<void> {
    run.startedAt = Date.now();
    this.phase(run, "Reading the board");
    this.save();
    try {
      const room = this.room(boardId);
      // Read the board now, so a queued request sees what earlier ones changed.
      this.requestText = run.text;
      run.screen = this.screen(room, run.viewport ?? { x: 0, y: 0, w: 2000, h: 1200 }, run.selected ?? [], run.scope ?? "view", run.area, this.pageOf(room, run));
      this.requestText = null;
      // Threads are per board (no board's text reaches another's); recent requests give context.
      const recent = this.board(boardId).runs.filter((r) => r !== run && r.status === "done" && r.summary).slice(-4);
      const history = recent.length ? `Recent requests on this board:\n${recent.map((r) => `- "${r.text.slice(0, 160)}" → ${r.summary!.slice(0, 200)}${r.undone ? " (undone)" : ""}`).join("\n")}\n\n` : "";
      const prompt = `${history}Request: ${run.text}\n\n${run.screen}`;
      const brainState = this.brain.state(boardId);
      this.phase(run, brainState === "warm" ? "Thinking" : brainState === "cold" || brainState === "starting" ? "Waking up (cold start), then thinking" : "Finishing warm-up, then thinking");
      // A "look" answer gets the frame contents back in the same thread, then a second turn.
      let looks = 0;
      let nudged = false;
      let foundFrames = false;
      const raw = await this.brain.decide(boardId, await ensureBoardDirectory(this.cfg, boardId), prompt, DECISION_SCHEMA, (answer) => {
        const acts = (JSON.parse(answer) as { actions?: Action[] }).actions ?? [];
        const wanted = acts.filter((a) => a.op === "look" && a.id);
        // An instruction answered with nothing at all and no look: models give up instead of
        // looking (measured 2026-10-31). Ask once, in the same thread, to look and act.
        if (!acts.length && !looks && !nudged && !/\?\s*$/.test(run.text)) {
          nudged = true;
          this.log(`organizer: ${boardId} nudged to look`);
          return "You returned no actions. Do not give up: answer now with look actions for the frame(s) most likely meant (a board with columns of cards for a kanban), then you will get their contents.";
        }
        // Looked, then still nothing: once, ask it to act on what it saw.
        if (!acts.length && looks && foundFrames && !nudged && !/\?\s*$/.test(run.text)) {
          nudged = true;
          this.log(`organizer: ${boardId} nudged to act after looking`);
          return "You looked and returned no actions. The frame you looked at is the one the user means. Answer now with the actions their request asks for (for a new card: create with parentId = that frame and below = a COLUMN HEADER id).";
        }
        // Nudged and still nothing: look for it. Frames with column headers are the boards.
        if (!acts.length && !looks && nudged && !/\?\s*$/.test(run.text)) {
          const boards = [...room.records.values()]
            .filter((f) => f.type === "frame" && [...room.records.values()].filter((c) => c.parentId === f.id && c.type === "geo" && shapeText(c) && shapeText(c).length <= 40).length >= 2)
            .sort((a, b) => [...room.records.values()].filter((c) => c.parentId === b.id).length - [...room.records.values()].filter((c) => c.parentId === a.id).length)
            .slice(0, 2);
          if (!boards.length) return null;
          looks++;
          foundFrames = true;
          this.phase(run, `Looking inside ${boards.map((f) => f.props.name || "a frame").join(", ")}`);
          this.log(`organizer: ${boardId} server looked at ${boards.map((f) => f.id).join(", ")}`);
          return `These are the boards with columns:\n${boards.map((f) => this.look(room, f)).join("\n\n")}\n\nNow answer the original request with actions on the right one.`;
        }
        if (!wanted.length || looks >= 2) return null;
        looks++;
        const frames = wanted.map((a) => this.find(room, a.id!)).filter((r): r is Rec => !!r && r.type === "frame");
        if (frames.length) foundFrames = true;
        this.phase(run, `Looking inside ${frames.map((f) => f.props.name || "a frame").join(", ") || "the board"}`);
        this.log(`organizer: ${boardId} look ${looks}: asked ${wanted.map((a) => JSON.stringify(a.id)).join(", ")} -> ${frames.map((f) => f.id).join(", ") || "(no frames)"}`);
        const body = frames.length ? frames.map((f) => this.look(room, f)).join("\n\n") : this.candidates(room);
        return `Contents you asked for:\n${body}\n\nNow answer the original request with actions${looks >= 2 ? " (no more looks)" : ""}.`;
      });
      const decided = Date.now();
      const parsed = JSON.parse(raw) as { actions: Action[]; summary: string };
      const actions = (parsed.actions ?? []).filter((a) => a.op !== "look");
      this.phase(run, actions.some((a) => a.op === "prompt") ? `Applying ${actions.length} change(s) and messaging agents` : `Applying ${actions.length} change(s)`);
      const problems = await this.apply(room, run, actions);
      // The model's summary describes its plan; say plainly when the board did not follow.
      const said = parsed.summary?.trim() || "Done.";
      const lead = actions.length && problems.length >= actions.length ? "Nothing changed. Planned: " : problems.length ? "Partly done. Planned: " : "";
      // Say where new shapes landed, so a wrong pick is obvious (and one Undo away).
      const homes = [...new Set(Object.entries(run.before).filter(([, b]) => b === null).map(([id]) => room.records.get(id)).filter((r): r is Rec => !!r && isShape(r)).map((r) => room.records.get(r.parentId)).filter((p): p is Rec => !!p && p.type === "frame").map((p) => p.props.name || "a frame"))];
      const where = homes.length ? ` · in ${homes.map((n) => `“${n}”`).join(", ")}` : "";
      run.summary = [lead + said + where, ...problems.map((p) => `Failed: ${p}.`)].join(" ").slice(0, 800);
      run.status = "done";
      this.log(`organizer: ${boardId} "${run.text.slice(0, 60)}" decided in ${((decided - run.startedAt) / 1000).toFixed(1)}s, ${parsed.actions?.length ?? 0} action(s) applied in ${Date.now() - decided} ms`);
    } catch (e) {
      run.status = "error";
      run.summary = `The organizer failed: ${(e as Error).message}`;
      this.log(`organizer: ${boardId} request failed: ${(e as Error).message}`);
    }
    run.finishedAt = Date.now();
    run.screen = "";
    this.save();
  }

  undo(boardId: string, runId: string) {
    const room = this.room(boardId);
    const run = this.board(boardId).runs.find((r) => r.id === runId);
    if (!run) throw new OrganizerError("no such request", 404);
    if (run.status !== "done") throw new OrganizerError("only a finished request can be undone", 409);
    if (run.undone) return { ok: true, restored: 0, kept: 0 };
    // A record changed since the request (by anyone) is left as it is.
    const after = run.after ?? {};
    // What a person can change. The canvas writes measurements (text bounds in meta, a
    // note's growY) right after a shape appears; those are not edits and must not block Undo
    // (live board, 2026-11-01: Undo "kept" every sticky it had just created).
    const edits = (r: Rec | undefined | null) => {
      if (!r) return null;
      const { growY: _g, ...props } = (r.props ?? {}) as Record<string, unknown>;
      return JSON.stringify({ type: r.type, parentId: r.parentId, x: Math.round(r.x ?? 0), y: Math.round(r.y ?? 0), rotation: r.rotation, props, fromId: r.fromId, toId: r.toId });
    };
    const changed = (id: string, cur: Rec | undefined) => id in after && edits(cur) !== edits(after[id]);
    let restored = 0;
    let kept = 0;
    room.write({ kind: "server", reason: "organizer-undo" }, (ops) => {
      const entries = Object.entries(run.before);
      // Parents were recorded before their children: remove children first, restore parents first.
      for (const [id, rec] of [...entries].reverse())
        if (rec === null && ops.get(id)) {
          if (changed(id, ops.get(id))) kept++;
          else (ops.remove(id), restored++);
        }
      for (const [id, rec] of entries)
        if (rec) {
          if (changed(id, ops.get(id))) kept++;
          else (ops.put(rec), restored++);
        }
    });
    room.save();
    run.undone = true;
    if (kept) run.summary = `${run.summary ?? ""} (Undo kept ${kept} shape(s) changed afterwards.)`.trim();
    this.save();
    this.log(`organizer: undid ${runId} on ${boardId} (${restored} record(s), kept ${kept})`);
    return { ok: true, restored, kept };
  }

  // The request being prepared (screen() reads it to list the frames it names).
  private requestText: string | null = null;

  // Frames whose name appears in the text (whole name, case-insensitive, 4+ characters).
  private namedIn(room: BoardRoom, text: string): Rec[] {
    const t = text.toLowerCase();
    return [...room.records.values()]
      .filter((f) => f.type === "frame" && String(f.props?.name ?? "").trim().length >= 4 && t.includes(String(f.props.name).trim().toLowerCase()))
      .slice(0, 8);
  }

  private pageOf(room: BoardRoom, run: OrganizerRun): string {
    return run.pageId && room.records.get(run.pageId)?.typeName === "page" ? run.pageId : room.pageId();
  }

  // A frame by id, by "shape:"-less id, or by name (exact, then unique partial match).
  private find(room: BoardRoom, id: string): Rec | undefined {
    const r = room.records.get(id) ?? room.records.get(`shape:${id}`);
    if (isShape(r)) return r;
    const n = id.replace(/^shape:/, "").trim().toLowerCase();
    const frames = [...room.records.values()].filter((f) => f.type === "frame");
    const exact = frames.filter((f) => String(f.props?.name ?? "").trim().toLowerCase() === n);
    if (exact.length === 1) return exact[0];
    const partial = frames.filter((f) => n.length >= 4 && String(f.props?.name ?? "").toLowerCase().includes(n));
    return partial.length === 1 ? partial[0] : undefined;
  }

  // When a look names nothing that exists: every frame with a hint of what is inside, so
  // the next look can pick the right one.
  private candidates(room: BoardRoom): string {
    const pages = [...room.records.values()].filter((r) => r.typeName === "page");
    const lines = ["None of those is a frame on this board. Frames by page (look again with one of these ids):"];
    for (const p of pages) {
      lines.push(`Page "${p.name}":`);
      for (const f of [...room.records.values()].filter((r) => isShape(r) && r.parentId === p.id && r.type === "frame")) lines.push(`- ${this.oneLine(room, f)}`);
    }
    return lines.join("\n").slice(0, 12000);
  }

  // A frame's contents for a "look": direct children with frame-relative position and size;
  // nested frames summarised (name, size, what is inside), so a big board stays readable.
  private look(room: BoardRoom, frame: Rec): string {
    const kids = [...room.records.values()].filter((c) => c.parentId === frame.id && isShape(c) && c.type !== "arrow");
    const page = room.records.get(this.pageOfShape(room, frame) ?? "");
    const lines = [`frame ${quote(frame.props.name || "(unnamed)")} (${frame.id}) on page "${page?.name ?? "?"}", ${r0(frame.props.w)}x${r0(frame.props.h)}, ${kids.length} shapes inside. Positions are frame-relative (x right, y down).`];
    let used = lines[0].length;
    for (const c of kids.sort((a, b) => a.x - b.x || a.y - b.y)) {
      const size = shapeSize(c);
      const pos = `@(${r0(c.x)},${r0(c.y)}) ${r0(size.w)}x${r0(size.h)}`;
      let line: string;
      if (c.type === "frame") {
        const inner = [...room.records.values()].filter((g) => g.parentId === c.id && isShape(g));
        const labels = inner.map((g) => (g.type === "frame" ? g.props.name : shapeText(g))).filter((t) => t && String(t).trim()).slice(0, 3).map((t) => quote(String(t), 30));
        line = `- frame ${quote(c.props.name || "(unnamed)", 60)} (${c.id}) ${pos}${c.meta?.paseo?.agentId ? " · agent" : ""} · ${inner.length} inside${labels.length ? `: ${labels.join(", ")}` : ""}`;
      } else if (c.type === "geo" && shapeText(c) && shapeText(c).length <= 40) {
        // Short labelled boxes are how boards mark their columns.
        line = `- COLUMN HEADER ${quote(shapeText(c), 40)} (${c.id}) ${pos}`;
      } else line = `- ${c.type} ${quote(shapeText(c) || "", 60)} (${c.id}) ${pos}`;
      if (used + line.length > 12000) {
        lines.push(`- … ${kids.length - lines.length + 1} more not shown`);
        break;
      }
      lines.push(line);
      used += line.length;
    }
    return lines.join("\n");
  }

  private pageOfShape(room: BoardRoom, r: Rec): string | undefined {
    let cur: Rec | undefined = r;
    for (let i = 0; cur && i < 64; i++) {
      if (cur.typeName === "page") return cur.id;
      cur = room.records.get(cur.parentId);
    }
    return undefined;
  }

  // --- what the model sees --------------------------------------------------------------------

  private screen(room: BoardRoom, v: Viewport, selected: string[], scope: ScopeKind, area?: Viewport, page = room.pageId()): string {
    const top = [...room.records.values()].filter((r) => isShape(r) && r.parentId === page && r.type !== "arrow");
    const box = (r: Rec): Box => ({ ...absPos(room.records, r), ...shapeSize(r) });
    // The top-level shape a selected shape lives in.
    const topOf = (id: string) => {
      let r = room.records.get(id);
      for (let i = 0; r && r.parentId !== page && i < 64; i++) r = room.records.get(r.parentId);
      return r?.parentId === page ? r : undefined;
    };
    const rect = scope === "area" && area ? area : v;
    let focus: Rec[];
    const lines: string[] = [];
    if (scope === "board") {
      focus = top;
      lines.push(`Scope: the whole board (${top.length} top-level shapes). The user's view is page area x ${r0(v.x)}..${r0(v.x + v.w)}, y ${r0(v.y)}..${r0(v.y + v.h)}.`);
    } else if (scope === "selection" && selected.length) {
      focus = [...new Set(selected.map(topOf).filter((r): r is Rec => !!r))];
      lines.push(`Scope: the user's selection.`);
    } else {
      focus = top.filter((r) => overlaps(box(r), rect));
      lines.push(`Scope: ${scope === "area" ? "an area the user dragged" : "the user's view"}, page area x ${r0(rect.x)}..${r0(rect.x + rect.w)}, y ${r0(rect.y)}..${r0(rect.y + rect.h)}.`);
    }
    if (selected.length) lines.push(`Selected: ${selected.map((id) => this.oneLine(room, room.records.get(id))).join("; ")}.`);
    if (this.watcher.layoutLocked(room.id)) lines.push("The board layout is LOCKED: move, tidy and delete will be refused.");
    const pageName = room.records.get(page)?.name;
    lines.unshift(`The user is on page "${pageName ?? page}" (${page}).`);
    lines.push(focus.length ? `In scope (${focus.length}):` : "Nothing in scope.");
    let used = lines.join("\n").length;
    for (const r of focus) {
      const block = r.type === "frame" ? `${this.oneLine(room, r)}\n${frameOutline(room.records, r.id).split("\n").slice(3).join("\n")}` : this.oneLine(room, r);
      if (used + block.length > SCREEN_BUDGET) {
        lines.push(`- ${this.oneLine(room, r)} (contents omitted)`);
        continue;
      }
      lines.push(`- ${block}`);
      used += block.length;
    }
    const off = top.filter((r) => !focus.includes(r));
    if (off.length) {
      lines.push("Elsewhere on this page:");
      for (const r of off.slice(0, 40)) lines.push(`- ${this.oneLine(room, r)}`);
      if (off.length > 40) lines.push(`- … and ${off.length - 40} more`);
    }
    // Frames the request names, wherever they are (nested inside another frame, on another
    // page): the listings above only show top-level frames, and the model then makes up ids
    // (live, 2026-11-01: "<id of Organization agent frame in scope>").
    const asked = this.namedIn(room, this.requestText ?? "");
    if (asked.length) {
      lines.push("Frames named in the request (use these ids):");
      for (const f of asked) lines.push(`- ${this.oneLine(room, f)} on page "${room.records.get(this.pageOfShape(room, f) ?? "")?.name ?? "?"}"${f.parentId.startsWith("shape:") ? ` inside ${quote(room.records.get(f.parentId)?.props?.name || "a frame", 40)}` : ""}`);
    }
    // Other pages: their frames, so a request can reach a frame the user is not looking at.
    for (const p of [...room.records.values()].filter((r) => r.typeName === "page" && r.id !== page)) {
      const frames = [...room.records.values()].filter((r) => isShape(r) && r.parentId === p.id && r.type === "frame");
      lines.push(`Page "${p.name}" (${p.id}): ${frames.length ? "" : "no frames"}`);
      for (const r of frames.slice(0, 60)) lines.push(`- ${this.oneLine(room, r)}`);
      if (frames.length > 60) lines.push(`- … and ${frames.length - 60} more`);
    }
    return lines.join("\n");
  }

  private oneLine(room: BoardRoom, r: Rec | undefined): string {
    if (!isShape(r)) return "(gone)";
    const b = { ...absPos(room.records, r), ...shapeSize(r) };
    const pos = `@page(${r0(b.x)},${r0(b.y)}) ${r0(b.w)}x${r0(b.h)}`;
    if (r.type !== "frame") return `${r.type} ${quote(shapeText(r) || "", 40)} (${r.id}) ${pos}`;
    const p = r.meta?.paseo ?? {};
    const agent = p.agentId ? `agent ${p.agentId}${p.status ? ` (${p.status})` : ""}` : "no agent";
    const inside = [...room.records.values()].filter((c) => c.parentId === r.id && isShape(c));
    // Headers first (labels, text), then card names: that is what tells a Kanban from a list.
    const rank = (c: Rec) => (c.type === "geo" || c.type === "text" ? 0 : c.type === "frame" ? 1 : 2);
    const labels = inside
      .slice()
      .sort((a, b) => rank(a) - rank(b) || a.x - b.x)
      .map((c) => (c.type === "frame" ? c.props.name : shapeText(c)))
      .filter((t) => t && String(t).trim())
      .slice(0, 8)
      .map((t) => quote(String(t), 24));
    const hint = inside.length ? ` · ${inside.length} shapes inside${labels.length ? ` (${labels.join(", ")}…)` : ""}` : "";
    return `frame ${quote(r.props.name || "(unnamed)")} (${r.id}) ${pos} · ${agent}${hint}`;
  }

  // --- applying a decision -----------------------------------------------------------------

  // Board changes go into one write, in the order given; prompts go out in parallel after.
  // Returns the actions that could not be applied, in words.
  private async apply(room: BoardRoom, run: OrganizerRun, actions: Action[]): Promise<string[]> {
    const problems: string[] = [];
    const refs = new Map<string, string>();
    const page = this.pageOf(room, run);
    const isPage = (id: string) => room.records.get(id)?.typeName === "page";
    const locked = this.watcher.layoutLocked(room.id);
    const touch = (id: string, rec: Rec | null) => {
      if (!(id in run.before)) run.before[id] = rec;
    };
    const meta = { author: { kind: "agent", agentId: "board-organizer" } };
    const prompts: Array<{ frame: Rec; text: string }> = [];
    // Shapes added by this decision, so later placements avoid them too.
    const placed: Rec[] = [];
    // Several creates in one write: each needs an index above the previous one in its parent.
    const lastIndex = new Map<string, string>();
    const indexIn = (parentId: string) => {
      const prev = lastIndex.get(parentId);
      const idx = prev ? getIndexAbove(prev as never) : nextIndex(room.records, parentId);
      lastIndex.set(parentId, idx);
      return idx;
    };
    // New top-level shapes without a position go to the right of everything.
    let freeX = Math.max(0, ...[...room.records.values()].filter((r) => isShape(r) && r.parentId === page).map((r) => absPos(room.records, r).x + shapeSize(r).w + 60));
    const pins: string[] = [];
    room.write({ kind: "server", reason: "organizer" }, (ops) => {
      // Models sometimes drop the "shape:" prefix; accept the id either way.
      // Real ids win over the model's refs, so a ref can never shadow an existing shape. A
      // unique frame name also works ("Organize Bugs").
      const byName = (name: string) => {
        const n = name.replace(/^shape:/, "").trim().toLowerCase();
        const hits = [...room.records.values()].filter((r) => r.type === "frame" && String(r.props?.name ?? "").trim().toLowerCase() === n);
        return hits.length === 1 ? hits[0].id : undefined;
      };
      const resolve = (id: string) => (ops.get(id) ? id : (refs.get(id) ?? (ops.get(`shape:${id}`) ? `shape:${id}` : (byName(id) ?? id))));
      // Under `anchorId`, in its column: below the lowest sibling overlapping the anchor's x-range.
      const stackBelow = (parentId: string, anchorId: string, size: { w: number; h: number }) => {
        const anchor = ops.get(resolve(anchorId));
        if (!isShape(anchor) || anchor.parentId !== parentId) throw new Error(`${anchorId} is not inside that frame`);
        const a = { x: anchor.x, w: shapeSize(anchor).w };
        const column = [...room.records.values(), ...placed].filter((c) => isShape(c) && c.parentId === parentId && c.type !== "arrow" && c.x < a.x + a.w && c.x + shapeSize(c).w > a.x && c.y >= anchor.y);
        const bottom = Math.max(...column.map((c) => c.y + shapeSize(c).h));
        return { x: anchor.x, y: bottom + 40 };
      };
      // Inside a frame, slide a new shape down until it sits on nothing.
      const clear = (parentId: string, x: number, y: number, size: { w: number; h: number }) => {
        const others = [...room.records.values(), ...placed].filter((c) => isShape(c) && c.parentId === parentId && c.type !== "arrow");
        for (let i = 0; i < 200; i++) {
          const hit = others.find((o) => overlaps({ x, y, w: size.w, h: size.h }, { x: o.x, y: o.y, ...shapeSize(o) }, 20));
          if (!hit) break;
          y = hit.y + shapeSize(hit).h + 40;
        }
        return { x, y };
      };
      // Is `id` the same as, or inside, `ancestor`? (Bounded: a corrupt board cannot loop.)
      const within = (id: string, ancestor: string) => {
        let cur: string | undefined = id;
        for (let i = 0; cur && i < 64; i++) {
          if (cur === ancestor) return true;
          cur = ops.get(cur)?.parentId;
        }
        return false;
      };
      const descendants = (id: string) => {
        const out: Rec[] = [];
        const seen = new Set<string>();
        const stack = [id];
        while (stack.length) {
          const cur = stack.pop()!;
          if (seen.has(cur)) continue;
          seen.add(cur);
          const r = ops.get(cur);
          if (!r) continue;
          out.push(r);
          for (const c of room.records.values()) if (c.parentId === cur) stack.push(c.id);
        }
        return out;
      };
      const shape = (id: string | null) => {
        const r = id ? ops.get(resolve(id)) : undefined;
        return isShape(r) ? r : undefined;
      };
      for (const a of actions) {
        try {
          if (a.op === "create") {
            if (!a.type || !CREATABLE.includes(a.type)) throw new Error(`create needs a type (${CREATABLE.join(", ")})`);
            const parentId = a.parentId ? resolve(a.parentId) : page;
            if (!isPage(parentId) && ops.get(parentId)?.type !== "frame") throw new Error(`${a.parentId} is not a frame or page`);
            const spec: ShapeSpec = { type: a.type as ShapeSpec["type"], text: a.text ?? undefined, color: a.color ?? undefined, url: a.url ?? undefined };
            if (a.type === "checklist") {
              spec.title = "";
              spec.items = (a.text ?? "").split("\n").filter((l) => l.trim()).slice(0, 100).map((t, i) => ({ id: `i${i}`, text: t.replace(/^[-*\d.\s]+/, "").trim(), checked: false }));
            }
            const size = defaultSize(spec);
            let x = a.x ?? (isPage(parentId) ? freeX : 20);
            let y = a.y ?? (isPage(parentId) ? 0 : 50);
            if (a.below) ({ x, y } = stackBelow(parentId, a.below, size));
            const wanted = { w: a.type === "frame" ? (a.w ?? Math.max(size.w, 500)) : (a.w ?? size.w), h: a.type === "frame" ? (a.h ?? Math.max(size.h, 380)) : (a.h ?? size.h) };
            if (!isPage(parentId)) ({ x, y } = clear(parentId, x, y, wanted));
            const rec = buildShape(spec, parentId, indexIn(parentId), x, y, meta);
            if (a.type === "frame") rec.props = { ...rec.props, w: a.w ?? Math.max(size.w, 500), h: a.h ?? Math.max(size.h, 380) };
            else if (a.w && "w" in rec.props) rec.props = { ...rec.props, w: a.w, ...(a.h && "h" in rec.props ? { h: a.h } : {}) };
            touch(rec.id, null);
            ops.put(rec);
            placed.push(rec);
            if (a.ref) refs.set(a.ref, rec.id);
            if (parentId === page && a.x === null) freeX += (rec.props.w ?? size.w) + 60;
          } else if (a.op === "edit") {
            const cur = shape(a.id);
            if (!cur) throw new Error(`${a.id} does not exist`);
            const props = { ...cur.props };
            if (a.text !== null) {
              if (cur.type === "frame") props.name = a.text;
              else if ("richText" in props) props.richText = toRichText(a.text);
              else throw new Error(`${cur.id} (${cur.type}) has no text`);
              if (cur.type === "note") props.growY = Math.max(props.growY ?? 0, noteGrowY(a.text, props.size));
            }
            if (a.color && "color" in props) props.color = a.color;
            touch(cur.id, cur);
            ops.put({ ...cur, props });
          } else if (a.op === "delete") {
            if (locked) throw new Error("the layout is locked");
            const cur = shape(a.id);
            if (!cur) throw new Error(`${a.id} does not exist`);
            const tree = descendants(cur.id);
            // An agent's frame is not the organizer's to delete (the agent would be released and
            // Undo could not re-bind it).
            const bound = tree.find((r) => r.type === "frame" && r.meta?.paseo?.agentId);
            if (bound) throw new Error(`${bound.props?.name || bound.id} is bound to an agent; unbind it first`);
            const gone: string[] = [];
            for (const r of tree) {
              touch(r.id, r);
              gone.push(r.id);
            }
            for (const b of room.records.values())
              if (b.typeName === "binding" && (gone.includes(b.fromId) || gone.includes(b.toId)) && ops.get(b.id)) {
                touch(b.id, b);
                gone.push(b.id);
              }
            for (const id of [...gone].reverse()) ops.remove(id);
          } else if (a.op === "duplicate") {
            const src = shape(a.id);
            if (!src) throw new Error(`${a.id} does not exist`);
            const copies = new Map<string, string>();
            const tree: Rec[] = [];
            for (const r of descendants(src.id)) {
              if (!isShape(r)) continue;
              tree.push(r);
              copies.set(r.id, createShapeId());
            }
            const size = shapeSize(src);
            let x = a.x ?? src.x + 20;
            let y = a.y ?? src.y + 20;
            // A top-level copy without a position goes to the nearest free spot: to the right,
            // then below, never on top of another shape.
            if (src.parentId === page) {
              const taken = [...room.records.values(), ...placed].filter((r) => isShape(r) && r.parentId === page && r.type !== "arrow").map((r) => ({ ...absPos(room.records, r), ...shapeSize(r) }));
              const free = (bx: number, by: number) => !taken.some((t) => overlaps({ x: bx, y: by, w: size.w, h: size.h }, t, 40));
              const tries = [...Array(12).keys()].flatMap((i) => [{ x: src.x + (size.w + 60) * (i + 1), y: src.y }, { x: src.x, y: src.y + (size.h + 60) * (i + 1) }]);
              // The model's spot when it is clear, else the nearest clear one.
              const asked = a.x !== null && a.y !== null ? [{ x: a.x, y: a.y }] : [];
              const spot = [...asked, ...tries].find((t) => free(t.x, t.y)) ?? tries[0];
              x = spot.x;
              y = spot.y;
            }
            for (const r of tree) {
              const root = r === src;
              const copy: Rec = { ...structuredClone(r), id: copies.get(r.id)!, parentId: root ? r.parentId : copies.get(r.parentId)!, meta: { ...r.meta, ...meta } };
              if (copy.meta.paseo) delete copy.meta.paseo;
              if (root) Object.assign(copy, { x, y, index: indexIn(r.parentId) });
              touch(copy.id, null);
              ops.put(copy);
              if (root) placed.push(copy);
            }
            if (a.ref) refs.set(a.ref, copies.get(src.id)!);
          } else if (a.op === "move") {
            if (locked) throw new Error("the layout is locked");
            const cur = shape(a.id);
            if (!cur) throw new Error(`${a.id} does not exist`);
            const next: Rec = { ...cur, props: { ...cur.props } };
            if (a.parentId) {
              const to = a.parentId === "page" ? page : resolve(a.parentId);
              if (to !== page && ops.get(to)?.type !== "frame") throw new Error(`${a.parentId} is not a frame`);
              if (to !== page && within(to, cur.id)) throw new Error("a shape cannot go inside itself or its own contents");
              if (to !== cur.parentId) Object.assign(next, { parentId: to, index: indexIn(to) });
            }
            if (a.x !== null) next.x = a.x;
            if (a.y !== null) next.y = a.y;
            if ((cur.type === "frame" || cur.type === "geo") && a.w) next.props.w = Math.max(cur.type === "frame" ? 200 : 20, a.w);
            if ((cur.type === "frame" || cur.type === "geo") && a.h) next.props.h = Math.max(cur.type === "frame" ? 150 : 20, a.h);
            touch(cur.id, cur);
            ops.put(next);
          } else if (a.op === "tidy") {
            if (locked) throw new Error("the layout is locked");
            const frame = shape(a.id);
            if (!frame || frame.type !== "frame") throw new Error(`${a.id} is not a frame`);
            this.tidyInto(ops, room, frame, touch);
          } else if (a.op === "prompt") {
            const frame = shape(a.id);
            if (!frame?.meta?.paseo?.agentId) throw new Error(`${a.id} has no agent to prompt`);
            if (!a.text?.trim()) throw new Error("prompt needs text");
            if (this.watcher.paused(room.id)) throw new Error("agents are paused on this board");
            prompts.push({ frame, text: a.text.trim() });
          } else if (a.op === "pin") {
            const frame = shape(a.id);
            if (!frame || frame.type !== "frame") throw new Error(`${a.id} is not a frame`);
            const agentId = a.agentId ?? "";
            if (![...room.records.values()].some((r) => r.type === "frame" && r.meta?.paseo?.agentId === agentId)) throw new Error(`agent ${agentId} is not on this board`);
            const x = a.x ?? 20;
            const y = a.y ?? 50;
            const size = { w: Math.max(200, Math.min(TRANSCRIPT_SIZE.compact.w, frame.props.w - x - 20)), h: TRANSCRIPT_SIZE.compact.h };
            const card = baseShape(TRANSCRIPT_TYPE, frame.id, indexIn(frame.id), x, y, { ...transcriptDefaults(agentId, "compact"), ...size }, meta);
            touch(card.id, null);
            ops.put(card);
            pins.push(agentId);
          }
        } catch (e) {
          problems.push(`${a.op} ${a.id ?? a.type ?? ""}: ${(e as Error).message}`.replace(/\s+:/, ":"));
        }
      }
    });
    room.save();
    run.after = Object.fromEntries(Object.keys(run.before).map((id) => [id, room.records.get(id) ?? null]));
    if (pins.length && this.watcher.transcripts) void this.watcher.transcripts.prime(pins).catch(() => undefined);
    // Messages to frame agents: wait briefly for delivery, then let the request finish; a
    // slow delivery is reported in the summary instead of holding the bunny.
    const delivery = Promise.allSettled(
      prompts.map(async ({ frame, text }) => {
        const agentId = frame.meta.paseo.agentId as string;
        const msg = `Message from the board organizer. The user asked it: "${run.text.slice(0, 300)}". It passes on: ${text}`;
        if (frame.meta.paseo.host) await this.watcher.promptRemote(agentId, msg);
        else {
          if (!this.bridge.api) throw new Error("Paseo is not connected");
          await this.bridge.api.agents.ref(agentId).send(msg);
        }
        if (!run.prompted.includes(frame.id)) run.prompted.push(frame.id);
      }),
    );
    const sent = await Promise.race([delivery, new Promise<null>((r) => setTimeout(() => r(null), 2500))]);
    if (sent)
      sent.forEach((s, i) => {
        if (s.status === "rejected") problems.push(`prompt ${prompts[i].frame.props.name || prompts[i].frame.id}: ${(s.reason as Error).message}`);
      });
    else if (prompts.length) {
      run.prompted.push(...prompts.map((p) => p.frame.id).filter((id) => !run.prompted.includes(id)));
      void delivery.then((all) => all.forEach((s, i) => s.status === "rejected" && this.log(`organizer: prompt to ${prompts[i].frame.id} failed late: ${(s.reason as Error).message}`)));
    }
    return problems;
  }

  private tidyInto(ops: { get(id: string): Rec | undefined; put(r: Rec): void }, room: BoardRoom, frame: Rec, touch: (id: string, r: Rec | null) => void): void {
    const kids = childBoxes(room.records, frame.id);
    const items = kids.filter((k) => !isComponent(k.rec) && !(k.rec.type === "frame" && k.rec.meta?.paseo?.agentId));
    if (!items.length) return;
    const fixed = kids.filter((k) => !items.includes(k));
    const { positions, unplaced, height } = layoutPositions(items.sort((a, b) => Math.round(a.y / 80) - Math.round(b.y / 80) || a.x - b.x), fixed, frame.props.w, "grid", 40);
    if (unplaced.length) throw new Error(`could not place ${unplaced.length} shape(s); widen the frame first`);
    const byId = new Map(positions.map((p) => [p.id, p]));
    for (const it of items) {
      const p = byId.get(it.id);
      const cur = ops.get(it.id);
      if (!p || !cur) continue;
      touch(it.id, cur);
      const next: Rec = { ...cur, x: cur.x + (p.x - it.x), y: cur.y + (p.y - it.y), props: { ...cur.props } };
      if (cur.type === "note") next.props.growY = Math.max(cur.props.growY ?? 0, noteGrowY(shapeText(cur), cur.props.size));
      ops.put(next);
    }
    if (height > frame.props.h) {
      const f = ops.get(frame.id)!;
      touch(frame.id, f);
      ops.put({ ...f, props: { ...f.props, h: Math.ceil(height) } });
    }
  }
}
