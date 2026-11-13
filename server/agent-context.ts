import { hasRemoteRuntimeFiles, requestRuntimeFiles } from "./runtime-files";
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BoardConfig } from './config';
import type { Rec } from './records';

// Changing the whiteboard itself (bunny code or canvas UI) never happens in the
// main checkout or on the live board; it happens in a board-env environment.
export const BOARD_CODE_RULE = "If a task changes this whiteboard's own code or UI (the bunny repo, including the canvas), that is repository work done only in a board-env environment: run `board-env up <task-name>`, work only in the worktree it prints, and hand back its tailnet preview link plus `board-env test <task-name>` evidence. Never edit the main bunny checkout or the live board (:8793) for it. See skills/board-env/SKILL.md in the repository.";

export const BOARD_BUILD_RULE = "When the user's request implies building or changing code, first state the spec and how the user will check the result, write a plan sticky in your frame, then wait 3 minutes for an objection before starting repository work. Keep the turn open while waiting, or arm and verify a same-agent continuation before ending the turn. If there is no objection, proceed without asking for explicit permission: you may inspect repositories and start a worker agent (Codex preferred) in the relevant repository context. Honor any stop or change of scope. Questions and discussion alone do not trigger a build.";

export const BOARD_SYSTEM_PROMPT = `You are an agent working inside a shared whiteboard frame. Read the frame, carry out its task, and put useful results inside your frame using the board tools. This is a whiteboard workspace. Do not run monorepo startup rituals, backlog commands, or a CLAUDE.md ceremony. ${BOARD_BUILD_RULE} Preserve other frames and human edits. Follow the user's task and permissions. ${BOARD_CODE_RULE}`;

// How a frame agent keeps its frame: the same parts in the same places, colours with fixed
// meanings, shapes edited rather than piled up, and a tidy pass at the end of each working
// turn. Without it the opener asked once for "a sticky or a few shapes" and frames froze at
// the first reply while the work moved on in chat. Part of every opener (MCP and HTTP).
export function frameUpkeep(humanName: string): string {
  return [
    `Keeping your frame: the frame is the status report ${humanName} reads at a glance; your chat replies are the working log. Lay it out the same way every time, top to bottom:`,
    `- Status line: one text shape at the top (beside any card there): "NOW <what is happening, or the outcome> · NEEDS YOU <the one thing you need from ${humanName}, or nothing>".`,
    "- Plan: one checklist of the steps (it is the plan sticky the build rule asks for; not a sticky per step). Tick items as they finish by updating the checklist's items by id.",
    "- Results: screenshots, link cards and one-headline stickies for what you found or made.",
    "- Needs you: one sticky per open question or decision.",
    "A quick question needs only the status line and the answer.",
    `Colours have fixed meanings: orange = needs ${humanName}, blue = plan or in progress, green = done or a result, red = blocked, grey = superseded. Set a colour on every sticky you write; plain yellow is left for ${humanName}'s own notes.`,
    "Edit in place: when something changes, update that shape or turn it grey; do not add a second shape that says the newer thing. Keep the frame to about a dozen shapes: delete what no longer matters and put longer detail behind a portal sticky.",
    "Tidy pass: before you end any turn in which you did work, update the status line, tick the checklist and delete or grey what is stale, so the frame always shows where the task stands. After a larger change to the frame, look at it with a snapshot and fix what reads badly. (A silent delta acknowledgement is not work: write nothing then.)",
  ].join("\n");
}

export function agentContext(cfg: BoardConfig, board: string, frame: Rec, requested?: 'board'|'repo', workspaceId?: string) {
  const context = requested ?? (workspaceId ? 'repo' : frame.meta?.videoRole ? 'board' : cfg.frameAgents?.repoWorkspaces === true ? 'repo' : cfg.frameAgents?.defaultContext ?? 'board');
  if (context === 'repo') return { context, cwd: cfg.defaultCwd };
  if (workspaceId) throw new Error('Board context cannot use an explicit repository workspace; select context repo.');
  return {context, cwd: boardDirectory(cfg, board), systemPrompt: BOARD_SYSTEM_PROMPT};
}

export function boardDirectory(cfg: BoardConfig, board: string): string {
  // A single encoded component prevents board ids from escaping the workspace root.
  if (!board || board === "." || board === "..") throw new Error("Invalid board workspace id");
  const cwd = path.join(cfg.frameAgents?.boardCwdRoot ?? path.join(cfg.stateDir, 'workspaces'), encodeURIComponent(board));
  if(hasRemoteRuntimeFiles())return cwd;
  mkdirSync(cwd, { recursive: true });
  try { writeFileSync(path.join(cwd, 'README.md'), '# Whiteboard scratch workspace\n\nThis is a whiteboard scratch workspace for board ' + board + '.\nDo not run monorepo startup rituals or backlog commands.\n\n' + BOARD_BUILD_RULE + '\n', {flag: 'wx'}); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  return cwd;
}


export async function ensureBoardDirectory(cfg: BoardConfig,board:string):Promise<string>{
 const cwd=boardDirectory(cfg,board);
 if(!hasRemoteRuntimeFiles())return cwd;
 const result=await requestRuntimeFiles({op:"workspace",board,readme:"# Whiteboard scratch workspace\n\n"+BOARD_BUILD_RULE+"\n"});
 if(result.path!==cwd)throw new Error("Runtime workspace root does not match board configuration");
 return cwd;
}
