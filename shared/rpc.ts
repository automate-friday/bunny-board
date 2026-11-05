import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// Internal: the board server calls this on itself at startup to capture the
// plugin-session Paseo API (see server/paseo-bridge.ts).
export const bootstrapRpc = defineRpc({
  name: "board.bootstrap",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
});

// Used by the composer pill: where is the board for this agent?
export const agentLinkRpc = defineRpc({
  name: "board.agent-link",
  input: z.object({ agentId: z.string() }),
  output: z.object({ url: z.string().nullable(), boardId: z.string().nullable(), frameId: z.string().nullable() }),
});

export const infoRpc = defineRpc({
  name: "board.info",
  input: z.object({}),
  output: z.object({ publicBase: z.string(), port: z.number(), boards: z.array(z.string()) }),
});

// "Add to board…" in the Paseo app: the boards this plugin serves.
export const boardsRpc = defineRpc({
  name: "board.boards",
  input: z.object({}),
  output: z.object({
    boards: z.array(z.object({ id: z.string(), frames: z.number(), boundFrames: z.number(), lastActivityAt: z.string(), url: z.string() })),
  }),
});

// Put one agent onto a board (created if it does not exist): a frame named after it,
// bound to it, with a transcript card. Returns the frame's deep link.
export const addAgentRpc = defineRpc({
  name: "board.add-agent",
  input: z.object({ agentId: z.string().min(1), boardId: z.string().min(1).max(64), requestId: z.string().max(100).optional() }),
  output: z.object({
    url: z.string().nullable(),
    boardId: z.string(),
    frameId: z.string().nullable(),
    created: z.boolean(),
    reason: z.string().nullable(),
  }),
});

export { boardIdFromName } from "./board-id";
