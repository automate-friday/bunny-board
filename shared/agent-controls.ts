// The board's proxy for Paseo's agent controls (model, mode, thinking, features,
// permissions). Shared by server/http.ts (/api/ui/agents/:id/controls and friends) and
// the canvas. Shapes follow @getpaseo/protocol 0.11.4; see docs/changelog/contracts.md
// "Paseo parity: agent controls".

export interface ControlOption {
  id: string;
  label: string;
  description?: string;
}

export interface ModelOption extends ControlOption {
  thinkingOptions?: ControlOption[];
  defaultThinkingOptionId?: string | null;
}

// Paseo AgentFeatureToggle | AgentFeatureSelect.
export type FeatureControl =
  | { type: "toggle"; id: string; label: string; value: boolean; description?: string }
  | { type: "select"; id: string; label: string; value: string | null; options: ControlOption[]; description?: string };

// One pending permission request (agent snapshot pendingPermissions), bounded.
export interface PermissionRequestView {
  id: string;
  kind?: string; // "tool" | "plan" | "question" | ...
  title?: string;
  description?: string;
  toolName?: string;
  // The tool call detail it is about, same bounded shape as TranscriptItem.detail.
  detail?: { type: string; [field: string]: unknown };
  // Provider actions; when empty the UI offers Deny / Allow.
  actions?: { id: string; label: string; behavior: "allow" | "deny" }[];
  // Plan text for kind "plan"; questions for kind "question" (raw provider input).
  planText?: string;
  input?: unknown;
}

export interface AgentControls {
  agentId: string;
  provider: string;
  // null when the host does not report it.
  modelId: string | null;
  models: ModelOption[];
  modeId: string | null;
  modes: ControlOption[];
  thinkingOptionId: string | null;
  features: FeatureControl[];
  pendingPermissions: PermissionRequestView[];
  // Which setters this host supports (false: hide the control).
  can: { model: boolean; mode: boolean; thinking: boolean; features: boolean; permissions: boolean };
}

// POST bodies (all answer { ok: true, notice?: string } or { error }).
export type SetModelBody = { modelId: string | null };
export type SetModeBody = { modeId: string };
export type SetThinkingBody = { optionId: string | null };
export type SetFeatureBody = { featureId: string; value: boolean | string | null };
// Paseo AgentPermissionResponse.
export type PermissionResponseBody =
  | { behavior: "allow"; selectedActionId?: string; updatedInput?: unknown }
  | { behavior: "deny"; selectedActionId?: string; message?: string };
