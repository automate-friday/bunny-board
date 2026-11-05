import type { PluginButton, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { openExternalUrl } from "@getpaseo/plugin/client";
import { agentLinkRpc } from "../shared/rpc";
import { AddToBoardPanel, AddToBoardPopover } from "./add-to-board";

type AgentLike = { id: string; workspaceId?: string | null; labels?: Record<string, string> | null; archivedAt?: string | null };

// One pill per agent composer. Agents on a board (labels board + frame) get "Board",
// which asks the daemon for the frame deep link at press time, so a re-bound frame
// still opens. Every other agent gets "Add to board…", a popover listing the boards.
export function contributePills(client: PluginClientContext): () => void {
  const pills = new Map<string, { reg: PluginButtonRegistration; kind: "open" | "add"; board: string }>();
  const lifetime = new AbortController();

  const openButton = (agentId: string, board: string): PluginButton => ({
    title: `Open board ${board}`,
    icon: "Frame",
    label: "Board",
    behavior: {
      kind: "action",
      async onPress() {
        const { url } = await client.rpc(agentLinkRpc, { agentId });
        if (!url) throw new Error("This agent is no longer bound to a board frame.");
        await openExternalUrl(url);
      },
    },
  });
  const addButton: PluginButton = { title: "Add this conversation to a board", icon: "Plus", label: "Add to board…", behavior: { kind: "popover", Content: AddToBoardPopover } };

  const register = (agent: AgentLike) => {
    if (lifetime.signal.aborted || !agent.workspaceId) return;
    const agentId = agent.id;
    const labels = agent.labels ?? {};
    const prev = pills.get(agentId);
    if (agent.archivedAt) {
      prev?.reg.remove();
      pills.delete(agentId);
      return;
    }
    const kind = labels.board && labels.frame ? "open" : "add";
    const button = kind === "open" ? openButton(agentId, labels.board) : addButton;
    const board = labels.board ?? "";
    if (prev?.kind === kind) {
      if (kind === "open" && prev.board !== board) {
        prev.reg.update(button);
        prev.board = board;
      }
      return;
    }
    prev?.reg.remove();
    pills.set(agentId, { kind, board, reg: client.addComposerPill({ id: "board", workspaceId: agent.workspaceId, agentId, button }) });
  };

  const removeAll = () => {
    for (const p of pills.values()) p.reg.remove();
    pills.clear();
  };

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal } as never)
    .then(({ subscription }) => {
      subscription?.subscribe({
        snapshot: ({ entries }) => {
          removeAll();
          for (const { agent } of entries) register(agent);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") return register(update.agent);
          pills.get(update.agentId)?.reg.remove();
          pills.delete(update.agentId);
        },
      });
      return undefined;
    })
    .catch((error: unknown) => {
      if (!lifetime.signal.aborted) console.error("[board] agent observation failed", error);
    });

  // Command Center (⌘K) on an agent tab: "Add this agent to a board" opens the panel.
  const stopPanel = client.addWorkspacePanel({ id: "add-to-board", title: "Add to board", icon: "Plus", context: "agent", Component: AddToBoardPanel });
  const stopCommand = client.addCommandCenterItem({
    id: "add-to-board",
    title: "Add this agent to a board",
    icon: "Plus",
    keywords: ["whiteboard", "board", "frame", "import"],
    context: "agent",
    onSelect({ openPanel }) {
      openPanel("add-to-board");
    },
  });

  return () => {
    lifetime.abort();
    removeAll();
    stopPanel();
    stopCommand();
  };
}
