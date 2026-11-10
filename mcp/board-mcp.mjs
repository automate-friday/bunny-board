#!/usr/bin/env node
// stdio MCP server for one board frame. Scope comes from env, never from tool
// input: BOARD_URL, BOARD_TOKEN (authorises exactly BOARD_ID/FRAME_ID), BOARD_ID,
// FRAME_ID. Every tool is a thin call to the board server's agent API, which
// enforces confinement and stamps authorship.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

const { BOARD_TOKEN, BOARD_ID, FRAME_ID, PASEO_AGENT_ID, BOARD_ENV } = process.env;
const LIVE_STATE = join(homedir(), ".paseo", "plugins", "board");
const LIVE_PORT = "8793";
const fail = (msg) => {
  console.error(`board-mcp: ${msg}`);
  process.exit(1);
};

const isLiveState = (dir) => {
  const real = (p) => (existsSync(p) ? realpathSync(p) : resolve(p));
  const a = real(dir);
  const b = real(LIVE_STATE);
  return a === b || a.startsWith(b + sep);
};
const isLiveUrl = (u) => {
  try {
    return new URL(u).port === LIVE_PORT;
  } catch {
    return true;
  }
};

function readServerJson(dir) {
  try {
    const s = JSON.parse(readFileSync(join(dir, "server.json"), "utf8"));
    return typeof s.url === "string" ? s.url : null;
  } catch {
    return null;
  }
}

// A board-env environment fails closed. It is recognised by BOARD_ENV, or by an env.json
// in BOARD_STATE (older board code does not pass BOARD_ENV on). board-env's registry names
// the only origins this MCP may call; BOARD_URL, server.json and every later discovery must
// be one of them, or nothing is sent (the token included). It never falls back to the live
// board. (Anything that can rewrite files in the user's home can rewrite the registry too;
// this guards against mistakes and stale config, not against a hostile local process.)
const ENV_STATE = process.env.BOARD_STATE;
const envFile = ENV_STATE ? join(ENV_STATE, "env.json") : null;
const IN_ENV = !!BOARD_ENV || !!(envFile && existsSync(envFile));
let ALLOWED = null; // Set of origins, in an environment
const origin = (u) => {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
};
const allowed = (u) => !IN_ENV || (ALLOWED.has(origin(u)) && !isLiveUrl(u));
let BOARD_URL = process.env.BOARD_URL;
if (IN_ENV) {
  const label = BOARD_ENV ?? "(from env.json)";
  if (!ENV_STATE) fail(`BOARD_ENV=${label}: BOARD_STATE must name the environment's state dir`);
  if (isLiveState(ENV_STATE)) fail(`BOARD_ENV=${label} but BOARD_STATE is the live board state; refusing`);
  let identity;
  try {
    identity = JSON.parse(readFileSync(envFile, "utf8"));
  } catch {
    fail(`BOARD_ENV=${label}: ${envFile} is missing or unreadable; refusing`);
  }
  if (BOARD_ENV && identity.name !== BOARD_ENV) fail(`BOARD_ENV=${BOARD_ENV} but ${envFile} is for ${identity.name}; refusing`);
  // The allowed origins come from board-env's registry, not from env.json: env.json sits in
  // the state dir the board hands to agents, the registry does not. The registry entry must
  // own this state dir and carry the same instance id as env.json.
  // board-env lays an environment out as <root>/<name>/state, with <root>/registry.json, so
  // the registry is found from the state dir itself (whatever root it was created under).
  const registryFile = join(resolve(ENV_STATE, "..", ".."), "registry.json");
  let entry;
  try {
    entry = JSON.parse(readFileSync(registryFile, "utf8")).envs?.[identity.name];
  } catch {
    fail(`BOARD_ENV=${label}: cannot read ${registryFile}; refusing`);
  }
  const same = (a, b) => {
    try {
      return realpathSync(a) === realpathSync(b);
    } catch {
      return false;
    }
  };
  if (!entry || !same(entry.stateDir, ENV_STATE)) fail(`BOARD_ENV=${label}: ${registryFile} has no environment ${identity.name} with state ${ENV_STATE}; refusing`);
  if (!identity.instance || entry.instance !== identity.instance) fail(`BOARD_ENV=${label}: ${envFile} instance does not match the registry; refusing`);
  ALLOWED = new Set((Array.isArray(entry.origins) ? entry.origins : []).map(origin).filter(Boolean));
  if (!ALLOWED.size) fail(`${registryFile}: ${identity.name} lists no origins; refusing`);
  if (BOARD_URL && !allowed(BOARD_URL)) fail(`BOARD_URL ${BOARD_URL} is not one of this environment's origins (${[...ALLOWED].join(", ")}); refusing`);
  if (!BOARD_URL) BOARD_URL = readServerJson(ENV_STATE);
  if (!BOARD_URL) fail(`BOARD_ENV=${label}: set BOARD_URL, or start the environment so ${ENV_STATE}/server.json exists`);
  if (!allowed(BOARD_URL)) fail(`${ENV_STATE}/server.json names ${BOARD_URL}, not one of this environment's origins; refusing`);
}
if (!BOARD_URL) fail("BOARD_URL must be set");
const FRAME_SCOPED = !!(BOARD_TOKEN && BOARD_ID && FRAME_ID);
if (!FRAME_SCOPED && (BOARD_TOKEN || BOARD_ID || FRAME_ID)) fail("set all BOARD_TOKEN, BOARD_ID and FRAME_ID for frame tools, or omit all three for board_start_frame only");
const UI_USER = process.env.BUNNYBOARD_AUTH_USERNAME;
const UI_PASSWORD = process.env.BUNNYBOARD_AUTH_PASSWORD;
if ((UI_USER !== undefined || UI_PASSWORD !== undefined) && (!UI_USER || !UI_PASSWORD || UI_USER.includes(":"))) fail("set both valid BUNNYBOARD_AUTH_USERNAME and BUNNYBOARD_AUTH_PASSWORD, or neither");

const path = (url) => `${url.replace(/\/$/, "")}/api/agent/boards/${encodeURIComponent(BOARD_ID)}/frames/${encodeURIComponent(FRAME_ID)}`;
let boardUrl = BOARD_URL;

// The board server writes where it listens to <state>/server.json. Agents created before
// the port moved (8791 -> 8793, 2026-10-27) still have the old BOARD_URL; when it does not
// answer, or something else answers there, follow server.json. In an environment only the
// environment's own state dir is consulted, and a live address found there is ignored.
function discovered() {
  if (IN_ENV) {
    const url = readServerJson(ENV_STATE);
    return url && allowed(url) ? url : null;
  }
  return readServerJson(process.env.BOARD_STATE || LIVE_STATE);
}

async function callAt(url, op, body) {
  const starting = op === "start-frame";
  const headers = { "content-type": "application/json" };
  if (starting) {
    if (UI_USER) headers.authorization = `Basic ${Buffer.from(`${UI_USER}:${UI_PASSWORD}`).toString("base64")}`;
  } else headers.authorization = `Bearer ${BOARD_TOKEN}`;
  if (PASEO_AGENT_ID) headers["x-paseo-agent-id"] = PASEO_AGENT_ID;
  // In an environment the token goes only to an allowed origin, and redirects are refused
  // (a 307 would otherwise carry the POST and the token somewhere else).
  if (!allowed(url)) throw new Error(`refusing to call ${url}: not one of this environment's origins`);
  // board_read waits for transcript cards (a few seconds at most); nothing takes a minute.
  const endpoint = starting ? `${url.replace(/\/$/, "")}/api/ui/frames/start` : `${path(url)}/${op}`;
  const res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body ?? {}), redirect: IN_ENV || starting ? "manual" : "follow", signal: AbortSignal.timeout(60_000) });
  if ((IN_ENV || starting) && res.status >= 300 && res.status < 400) throw new Error(`refusing a ${res.status} redirect from ${url}`);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { error: text };
  }
  return { res, json, board: (res.headers.get("x-bunny") ?? res.headers.get("x-paseo-board")) === "1" };
}

// Try server.json's address; keep it only if the board server answered there.
async function viaDiscovered(op, body, fallback) {
  const alt = discovered();
  if (!alt || alt === boardUrl) {
    if (fallback instanceof Error) throw fallback;
    return fallback;
  }
  const out = await callAt(alt, op, body).catch((e) => {
    if (fallback instanceof Error) throw fallback;
    return null;
  });
  if (out?.board) {
    boardUrl = alt;
    return out;
  }
  if (fallback instanceof Error) throw fallback;
  return fallback;
}

async function call(op, body) {
  let out;
  // A start goes only to the configured board: following server.json could start the same
  // conversation on another installation and send it this board's UI credentials.
  if (op === "start-frame") out = await callAt(BOARD_URL, op, body);
  else try {
    out = await callAt(boardUrl, op, body);
  } catch (e) {
    out = await viaDiscovered(op, body, e);
  }
  // Something answered, but not the board server (another service took the old port).
  if (!out.board) out = await viaDiscovered(op, body, out);
  const { res, json } = out;
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

const point = {
  type: "object",
  description: "Either {id} of a shape in your frame, or a frame-relative point {x,y}",
  properties: { id: { type: "string" }, x: { type: "number" }, y: { type: "number" } },
};

const portal = {
  type: "object",
  description:
    "note only: make the sticky a portal to another place on this board, so the person can jump there (and back) or expand the sticky into a live window onto it. Either {id} of any shape (a frame, a sticky, a card; in your frame or another frame) or a PAGE-space area {x,y,w,h} (page coordinates, as board_read scope:'board' prints @page(x,y); frame-relative is NOT used here). Use it when related content lives elsewhere, e.g. a sticky that says 'details →' pointing at the area where you wrote them.",
  properties: { id: { type: "string" }, x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" } },
};

const shapeSpec = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["note", "text", "box", "ellipse", "arrow", "frame", "bookmark", "link", "checklist"] },
    x: { type: "number", description: "frame-relative x (0 = left edge of your frame). Use the 240 px grid: 20, 260, 500, 740, … Omit x and y to auto-place." },
    y: { type: "number", description: "frame-relative y (0 = top edge of your frame). Grid rows: 50, 290, 530, …" },
    w: { type: "number", description: "not for notes (always 200 wide; they grow with their text)" },
    h: { type: "number", description: "not for notes" },
    text: { type: "string", description: "label text (frame name for type frame)" },
    color: { type: "string", enum: ["black", "grey", "light-violet", "violet", "blue", "light-blue", "yellow", "orange", "green", "light-green", "light-red", "red", "white"] },
    fill: { type: "string", enum: ["none", "semi", "solid", "pattern"] },
    url: { type: "string", description: "bookmark url (http/https; for local files use board_add_artifact kind:'file')" },
    title: { type: "string", maxLength: 200, description: "checklist title" },
    items: {
      type: "array", maxItems: 100,
      items: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1, maxLength: 200 },
          text: { type: "string", maxLength: 1000 },
          checked: { type: "boolean" },
        },
        required: ["id", "text", "checked"],
      },
    },
    board: { type: "string", description: "type link: the board id to link to" },
    frameId: { type: "string", description: "type link: optional frame on that board (shape:…)" },
    from: point,
    to: point,
    parentId: { type: "string", description: "optional: an unbound frame inside your frame. Anything else is rejected." },
    portal,
  },
  required: ["type"],
};

const TOOLS = [
  {
    name: "board_start_frame", op: "start-frame",
    description: "Create a named frame in free space and queue its conversation immediately, without a browser or waiting for Paseo. Retry with the same key and identical input to return the same frame; changed input with that key is refused. Uses board UI auth (BUNNYBOARD_AUTH_USERNAME/PASSWORD when enabled).",
    inputSchema: { type: "object", properties: {
      board: {type:"string", description:"Board id", maxLength:64},
      name: {type:"string", minLength:1, maxLength:200},
      opener: {type:"string", minLength:1, maxLength:100000},
      key: {type:"string", minLength:1, maxLength:256, description:"Stable client key; reuse on retries"},
      provider: {type:"string", maxLength:200},
      cwd: {type:"string", description:"Absolute directory on the Paseo host", maxLength:4096},
      near: {type:"string", description:"Shape id on this board; place nearby without overlap", maxLength:256}
    }, required:["board","name","opener","key"] }
  },
  {name:'board_channel',description:'List explicit active arrow-channel memberships for this frame, or send one deliberate message with stable messageId. No automatic forwarding. Retrying a message returns the saved receipt, including unknown.',inputSchema:{type:'object',properties:{action:{type:'string',enum:['list','send']},channelId:{type:'string'},messageId:{type:'string'},text:{type:'string'}},required:['action']},op:'channel'},
  {name:'board_video', description:'Video processing frame only: create its two child frames idempotently; prepare review URL; record feedback route receipts. Approval decisions belong to the user. No publishing or automatic sends.', inputSchema:{type:'object',properties:{action:{type:'string',enum:['read','children','review','route']},url:{type:'string'},route:{type:'object',properties:{id:{type:'string'},owner:{type:'string'},sourceClip:{type:'string'},acceptance:{type:'string'},receipt:{type:'string'}},required:['id','owner','sourceClip','acceptance','receipt']}},required:['action']},op:'video'},
  {
    name: "board_comment",
    description: "Comment threads people leave on the board (Figma-style). You get a message with the threadId when a comment lands in your frame, covers it, @mentions your frame, is sent to you, or replies in a thread you answered. action 'reply' (default) answers such a thread. action 'read' opens any thread on this board by threadId or by its link (?comment=...), e.g. one the user pasted to you. Agents reply only: resolving, editing and deleting are the people's. A retry with the same messageId is not posted twice.",
    inputSchema: { type: "object", properties: { action: { type: "string", enum: ["reply", "read"] }, threadId: { type: "string" }, link: { type: "string", description: "a board comment link, instead of threadId" }, text: { type: "string", maxLength: 4000, description: "reply text" }, messageId: { type: "string", description: "optional stable id for retries" } } },
    op: "comment",
  },
  {
    name: "board_read",
    description:
      "Read your frame on the whiteboard as a compact outline (default) or JSON. scope:'board' lists every frame on the board in one line each plus unframed shapes.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["frame", "board"] },
        format: { type: "string", enum: ["outline", "json"] },
        ids: { type: "array", items: { type: "string" } },
      },
    },
    op: "read",
  },
  {
    name: "board_read_image",
    description: "View an attached image or screenshot in YOUR frame. Pass the image shape id from board_read (not the asset id). Returns actual image content for vision, without needing access to the board hostname or host filesystem.",
    inputSchema: {type:"object",properties:{id:{type:"string",description:"Image shape ID inside your frame"}},required:["id"]},
    annotations: {readOnlyHint:true},
    op: "read-image",
  },
  {
    name: "board_write",
    description:
      "Provide shapes (or summary only for a requested compression). Create shapes inside YOUR frame, including portal stickies: a note with portal:{id} (or a page area {x,y,w,h}) links content elsewhere, the way to add more than fits here. Coordinates are frame-relative. A sticky (note) is 200 px wide and holds about 12 words; longer text grows it about 30 px per line, so keep each one to a short headline. Place on the 240 px grid (x 20/260/500/…, y 50/290/530/…) or omit x/y to auto-place. The server rejects writes outside your frame and writes that would overlap another shape (the error names the next free slot), and clamps shapes that overhang the frame edge. type 'link' {board, frameId?, text} is a card that opens another board or frame. A note with portal {id} or page-space {x,y,w,h} links to another place on this board (the person jumps there and back, or expands it in place); board_read shows it as '⤳ portal → …'. Checklist uses title and items [{id,text,checked}] with unique nonempty IDs. Returns the new ids.",
    inputSchema: { type: "object", properties: { shapes: { type: "array", items: shapeSpec, minItems: 1, maxItems: 50 }, summary: { type: "object", description: "For a requested frame compression only: {requestId,title,decisions:string[],results:string[],openItems:string[],artifacts:[{title,url}]}. The board fits the layout inside the target frame.", additionalProperties: true } } },
    op: "write",
  },
  {
    name: "board_update",
    description: "Change a shape inside your frame, or make a sticky a portal: patch.portal {id} links it to another shape or frame, or page-space {x,y,w,h} to an area (see board_write); portal:null removes it. Also text, colour, position (frame-relative) or size.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        patch: {
          type: "object",
          properties: { text: { type: "string" }, color: { type: "string" }, x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" }, portal: { anyOf: [portal, { type: "null" }] } },
        },
      },
      required: ["id", "patch"],
    },
    op: "update",
  },
  {
    name: "board_layout",
    description:
      "Re-flow the shapes in your frame so nothing overlaps, using their real (text-grown) sizes. strategy 'grid' fills rows left to right (row height = tallest shape in the row); 'columns' drops each shape into the shortest column (packs mixed heights tighter). Only shapes you wrote move, in reading order; the person's shapes, transcript and link cards and drawings stay put and are laid out around (includeHuman:true moves a person's shapes too; ask first; cards move only when listed in ids). ids limits it to some shapes. Grows your frame downwards if the result needs more height.",
    inputSchema: {
      type: "object",
      properties: {
        strategy: { type: "string", enum: ["grid", "columns"] },
        ids: { type: "array", items: { type: "string" } },
        gap: { type: "number", description: "space between shapes, default 40" },
        includeHuman: { type: "boolean" },
        parentId: { type: "string", description: "optional: lay out an unbound frame inside your frame instead" },
      },
    },
    op: "layout",
  },
  {
    name: "board_delete",
    description: "Delete shapes inside your frame. Only shapes you wrote, unless force:true (ask the user first).",
    inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } }, force: { type: "boolean" } }, required: ["ids"] },
    op: "delete",
  },
  {
    name: "board_frame",
    description:
      "Resize, move or rename your own frame (it cannot grow over another frame or a person's shapes). resize.anchor picks the corner that stays put: 'top-right' grows left, 'bottom-left' grows up. move:'auto' moves the frame and its contents to the nearest free spot that fits (with resize: at the new size); refused if a person placed the frame. A blocked resize says what is in the way, how far each anchor can grow, a free spot, and whether pushing neighbours, an annex frame or asking the person would work.",
    inputSchema: {
      type: "object",
      properties: {
        resize: {
          type: "object",
          properties: { w: { type: "number" }, h: { type: "number" }, anchor: { type: "string", enum: ["top-left", "top-right", "bottom-left", "bottom-right"], description: "corner that stays in place (default top-left)" } },
          required: ["w", "h"],
        },
        move: { type: "string", enum: ["auto"], description: "move the frame to the nearest free spot that fits it" },
        name: { type: "string" },
      },
    },
    op: "frame",
  },
  {
    name: "board_add_artifact",
    description:
      "Put an artifact in your frame: a local PNG/JPEG (absolute path) as an image; a URL as a link card; or, with kind:'file', any other local file (HTML report, transcript, PDF, video…), which is copied into the board's file store and linked from a card that opens it. file:// links are not allowed on the board; use kind:'file'.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["image", "file", "url"] },
        bundle: { type: "boolean", description: "For an HTML file, explicitly copy its report-only sibling directory (max100 files/20MB); symlinks, hidden paths and secrets are refused." },
        path: { type: "string", description: "absolute path" },
        url: { type: "string" },
        title: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        w: { type: "number" },
      },
    },
    op: "artifact",
  },
  {
    name: "board_pin_transcript",
    description:
      "Pin a live transcript card of another Paseo agent into YOUR frame, so you and the user can watch it work. Allowed: your own subagents (agents in your workspace) and agents bound to frames on this board. The card updates itself; afterwards board_read shows that agent's status and latest messages. mode 'compact' shows the last 3 rows, 'full' a scrollable log. x/y are frame-relative; omit them to auto-place.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "Paseo agent id to show" },
        mode: { type: "string", enum: ["compact", "full"] },
        x: { type: "number" },
        y: { type: "number" },
      },
      required: ["agentId"],
    },
    op: "pin",
  },
  {
    name: "board_widget",
    description:
      "Plugin widgets: small live windows (like Android widgets) that you deploy and configure for the job you are doing, e.g. a cloud-session activity widget for a Claude Code session you started; they sync themselves and show a status dot (grey connecting, green live, amber stale, red error with a reason). action 'list' shows the widgets (and preconfigured app windows) installed in the person's plugin registry with their config fields, and lists the rest as 'available' with the /plugins page where the person can install them. 'add' {widgetId, config, x?, y?} places one in YOUR frame (auto-placed when x/y are omitted); a widget added without config shows the person a small setup form. 'configure' {id, config} changes fields of a widget in your frame (\"\" clears a field). Fill config from what you already know (repo, PR, session id, deadline) rather than asking the person. Only released plugins are offered; others answer 'not available'. Remove a widget when its job ends. 'read' {id} returns its status and a short summary of its live data. board_read lists widgets as `widget <id> <summary> (<status>)`.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "add", "configure", "read"] },
        widgetId: { type: "string", description: "add: which widget (from list), e.g. claude-activity" },
        config: { type: "object", description: "add/configure: the widget's config fields (see list)" },
        id: { type: "string", description: "configure/read: the widget shape id (shape:…)" },
        x: { type: "number" },
        y: { type: "number" },
      },
      required: ["action"],
    },
    op: "widget",
  },
  {
    name: "board_stamp",
    description:
      "Stamps: standard reactions a person attaches to a shape in your frame. Each one reaches you at once as its own message starting \"Stamp <kind> on …\" with a JSON event {kind:'stamp', id, stamp, target:{id,type,text}, by, at, note?}, even mid-turn. Fixed meanings: stop = halt your current work now (and say where you stopped); approve = proceed with that item as it is; needs-change = revise that item; question = answer a question about that item (see its note); do-next = prioritise that item, do it next; love-it = keep this direction. The person sees each stamp go sent → seen → acting → done. action 'list' shows the open stamps in your frame (all:true includes done ones); 'ack' {id} marks one acting when you start on it; 'resolve' {id} marks it done when it is handled; 'add' {target, stamp, note?} attaches your own stamp to a shape in your frame (or your frame itself), e.g. question on a sticky you need an answer about. board_read lists stamps under their shape as `↳ stamp needs-change by Sam 13:42 [seen] note \"…\"`.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "ack", "resolve", "add"] },
        id: { type: "string", description: "ack/resolve: the stamp id (shape:…)" },
        target: { type: "string", description: "add: the shape id to stamp (shape:…), in your frame" },
        stamp: { type: "string", enum: ["approve", "needs-change", "question", "do-next", "stop", "love-it"], description: "add: which stamp" },
        note: { type: "string", description: "add: optional one-line note" },
        all: { type: "boolean", description: "list: include done stamps" },
      },
      required: ["action"],
    },
    op: "stamp",
  },
  {
    name: "board_archive_candidates",
    description:
      "Board clean-up, only when the user asks for it: list the board's top-level frames that look finished, each with reasons (empty frame, last edited N days ago, agent idle/archived/error, no edits recorded, conversation unlinked). Frames with an agent at work and your own frame are never listed. idleDays (default 7) is how long without edits counts as stale.",
    inputSchema: { type: "object", properties: { idleDays: { type: "number", minimum: 0, maximum: 365 }, limit: { type: "number", minimum: 1, maximum: 500 } } },
    op: "archive-candidates",
  },
  {
    name: "board_archive",
    description:
      "Propose archiving frames (ids from board_archive_candidates or board_read scope:'board'), with one short reason. This archives nothing: it files a clean-up proposal that the user reviews on the board and approves (all or some) in one click. Approved frames move to the board's Archive and can be restored; only the user can delete them forever. A new call replaces your pending proposal. Frames with an agent at work are skipped.",
    inputSchema: {
      type: "object",
      properties: { frameIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 500 }, reason: { type: "string", maxLength: 500 } },
      required: ["frameIds", "reason"],
    },
    op: "archive",
  },
];

const server = new Server({ name: "board", version: "0.2.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.filter(t => FRAME_SCOPED || t.name === "board_start_frame").map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, ...(annotations ? {annotations} : {}) })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = TOOLS.find((t) => t.name === req.params.name);
  if (!tool || (!FRAME_SCOPED && tool.name !== "board_start_frame")) return { isError: true, content: [{ type: "text", text: `unknown tool ${req.params.name}` }] };
  try {
    const out = await call(tool.op, req.params.arguments ?? {});
    if (tool.op === "read-image") return {content:[{type:"text",text:JSON.stringify({id:out.id,name:out.name})},{type:"image",data:out.data,mimeType:out.mimeType}]};
    const text = typeof out.outline === "string" ? out.outline : JSON.stringify(out, null, 2);
    return { content: [{ type: "text", text }] };
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: `board error: ${e.message}` }] };
  }
});

await server.connect(new StdioServerTransport());
