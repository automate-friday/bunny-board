// Paseo parity, server side: the agent controls (model, mode, thinking, features,
// permissions) built from an agent snapshot plus the provider catalogue, request-body
// validation for the setters, and path checks for the image file route.
// Types: shared/agent-controls.ts. Routes: server/http.ts. Contract:
// docs/changelog/contracts.md "Paseo parity: timeline items and agent controls".

import { realpathSync } from "node:fs";
import path from "node:path";
import type {
  AgentControls,
  ControlOption,
  FeatureControl,
  ModelOption,
  PermissionRequestView,
  PermissionResponseBody,
  SetFeatureBody,
  SetModeBody,
  SetModelBody,
  SetThinkingBody,
} from "../shared/agent-controls";
import { boundDetail, makeBounder, redactBoardTokens } from "./timeline";

function bad(message: string, status = 400): Error {
  return Object.assign(new Error(message), { status });
}

const str = (v: unknown, max = 500) => redactBoardTokens(String(v ?? "")).slice(0, max);

// biome-ignore lint/suspicious/noExplicitAny: provider option payloads.
function option(o: any): ControlOption | null {
  if (!o || typeof o.id !== "string" || !o.id) return null;
  return { id: o.id, label: typeof o.label === "string" && o.label ? str(o.label, 200) : o.id, ...(typeof o.description === "string" && o.description ? { description: str(o.description, 500) } : {}) };
}

function options(list: unknown): ControlOption[] {
  return Array.isArray(list) ? list.map(option).filter((o): o is ControlOption => !!o) : [];
}

// biome-ignore lint/suspicious/noExplicitAny: Paseo AgentFeature union.
function feature(f: any): FeatureControl | null {
  if (!f || typeof f.id !== "string" || !f.id) return null;
  const label = typeof f.label === "string" && f.label ? str(f.label, 200) : f.id;
  const description = typeof f.description === "string" && f.description ? { description: str(f.description, 500) } : {};
  if (f.type === "toggle") return { type: "toggle", id: f.id, label, value: f.value === true, ...description };
  if (f.type === "select") return { type: "select", id: f.id, label, value: typeof f.value === "string" ? f.value : null, options: options(f.options), ...description };
  return null;
}

// One pending permission request, bounded and redacted (Paseo PermissionRequestCard).
// biome-ignore lint/suspicious/noExplicitAny: AgentPermissionRequest payload.
export function permissionView(r: any): PermissionRequestView | null {
  if (!r || typeof r.id !== "string" || !r.id) return null;
  const b = makeBounder();
  const detail = boundDetail(r.detail, b);
  const planText = typeof r.metadata?.planText === "string" ? r.metadata.planText : typeof r.input?.plan === "string" ? r.input.plan : undefined;
  const actions = Array.isArray(r.actions)
    ? r.actions
        // biome-ignore lint/suspicious/noExplicitAny: AgentPermissionAction.
        .filter((a: any) => a && typeof a.id === "string" && (a.behavior === "allow" || a.behavior === "deny"))
        // biome-ignore lint/suspicious/noExplicitAny: AgentPermissionAction.
        .map((a: any) => ({ id: a.id, label: typeof a.label === "string" && a.label ? str(a.label, 200) : a.id, behavior: a.behavior as "allow" | "deny" }))
    : [];
  return {
    id: r.id,
    ...(typeof r.kind === "string" ? { kind: r.kind } : {}),
    ...(typeof r.title === "string" && r.title ? { title: str(r.title, 500) } : {}),
    ...(typeof r.description === "string" && r.description ? { description: b.str(r.description, "description") } : {}),
    ...(typeof r.name === "string" && r.name ? { toolName: str(r.name, 200) } : {}),
    ...(detail ? { detail } : {}),
    ...(actions.length ? { actions } : {}),
    ...(planText ? { planText: b.str(planText, "planText", false, 16_000) } : {}),
    ...(r.input !== undefined && r.input !== null ? { input: b.json(r.input, "input") } : {}),
  };
}

// The selectable models of one provider catalogue entry (getProvidersSnapshot), deduped by
// id, each with its thinking options.
export function catalogueModels(providerEntry: unknown): ModelOption[] {
  const models: ModelOption[] = [];
  const entry = providerEntry as { models?: unknown } | null | undefined;
  const catalogue = Array.isArray(entry?.models) ? entry.models : [];
  for (const m of catalogue) {
    if (!m || typeof m.id !== "string" || !m.id || m.isSelectable === false) continue;
    if (models.some((x) => x.id === m.id)) continue;
    const base = option(m);
    if (!base) continue;
    const thinkingOptions = options(m.thinkingOptions);
    const defaultThinking = typeof m.defaultThinkingOptionId === "string" ? m.defaultThinkingOptionId : (m.thinkingOptions ?? []).find?.((o: { isDefault?: boolean }) => o?.isDefault)?.id;
    models.push({ ...base, ...(thinkingOptions.length ? { thinkingOptions, defaultThinkingOptionId: defaultThinking ?? null } : {}) });
  }
  return models;
}

// AgentControls from the agent snapshot (fetchAgent / ref.refresh) and the provider
// catalogue entry for its provider (getProvidersSnapshot). `bound`: setters are only for
// agents bound to a frame (same rule as prompt and cancel); a card grants reading only.
// biome-ignore lint/suspicious/noExplicitAny: agent snapshot and provider payloads.
export function buildControls(agent: any, providerEntry: any | null, opts: { bound: boolean; connected: boolean }): AgentControls {
  const rt = agent?.runtimeInfo ?? {};
  const modelId: string | null = typeof agent?.model === "string" && agent.model ? agent.model : typeof rt.model === "string" && rt.model ? rt.model : null;
  const models = catalogueModels(providerEntry);
  const selectable = models.length > 0;
  // The current model stays listed even when the catalogue does not offer it.
  if (modelId && !models.some((m) => m.id === modelId)) models.unshift({ id: modelId, label: modelId });
  const modes = options(Array.isArray(agent?.availableModes) && agent.availableModes.length ? agent.availableModes : providerEntry?.modes);
  const modeId: string | null = typeof agent?.currentModeId === "string" && agent.currentModeId ? agent.currentModeId : typeof rt.modeId === "string" && rt.modeId ? rt.modeId : null;
  const thinkingOptionId: string | null = typeof agent?.thinkingOptionId === "string" && agent.thinkingOptionId ? agent.thinkingOptionId : typeof rt.thinkingOptionId === "string" && rt.thinkingOptionId ? rt.thinkingOptionId : null;
  const features = (Array.isArray(agent?.features) ? agent.features : []).map(feature).filter((f: FeatureControl | null): f is FeatureControl => !!f);
  const pendingPermissions = (Array.isArray(agent?.pendingPermissions) ? agent.pendingPermissions : []).map(permissionView).filter((p: PermissionRequestView | null): p is PermissionRequestView => !!p);
  const live = opts.bound && opts.connected && !!agent && !agent.archivedAt;
  const current = models.find((m) => m.id === modelId);
  return {
    agentId: String(agent?.id ?? ""),
    provider: String(agent?.provider ?? ""),
    modelId,
    models,
    modeId,
    modes,
    thinkingOptionId,
    features,
    pendingPermissions,
    can: {
      model: live && selectable,
      mode: live && modes.length > 0,
      thinking: live && !!current?.thinkingOptions?.length,
      features: live && features.length > 0,
      permissions: live,
    },
  };
}

// --- setter bodies ---------------------------------------------------------------------

const id = (v: unknown, what: string, max = 200): string => {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw bad(`${what} must be a non-empty string of at most ${max} characters`);
  return v;
};
const idOrNull = (v: unknown, what: string): string | null => (v === null ? null : id(v, what));

export function parseModelBody(b: Record<string, unknown>): SetModelBody {
  if (!("modelId" in b)) throw bad("modelId is required (a model id or null for the default)");
  return { modelId: idOrNull(b.modelId, "modelId") };
}
export function parseModeBody(b: Record<string, unknown>): SetModeBody {
  return { modeId: id(b.modeId, "modeId") };
}
export function parseThinkingBody(b: Record<string, unknown>): SetThinkingBody {
  if (!("optionId" in b)) throw bad("optionId is required (an option id or null for the default)");
  return { optionId: idOrNull(b.optionId, "optionId") };
}
export function parseFeatureBody(b: Record<string, unknown>): SetFeatureBody {
  const value = b.value;
  if (!(typeof value === "boolean" || value === null || (typeof value === "string" && value.length <= 200))) throw bad("value must be a boolean, a string or null");
  return { featureId: id(b.featureId, "featureId"), value };
}
export function parsePermissionBody(b: Record<string, unknown>): PermissionResponseBody {
  const selectedActionId = b.selectedActionId === undefined ? undefined : id(b.selectedActionId, "selectedActionId");
  const sel = selectedActionId ? { selectedActionId } : {};
  if (b.behavior === "allow") {
    if (b.updatedInput !== undefined && (b.updatedInput === null || typeof b.updatedInput !== "object" || Array.isArray(b.updatedInput))) throw bad("updatedInput must be an object");
    return { behavior: "allow", ...sel, ...(b.updatedInput !== undefined ? { updatedInput: b.updatedInput } : {}) };
  }
  if (b.behavior === "deny") {
    if (b.message !== undefined && (typeof b.message !== "string" || b.message.length > 4000)) throw bad("message must be a string of at most 4000 characters");
    return { behavior: "deny", ...sel, ...(typeof b.message === "string" ? { message: b.message } : {}) };
  }
  throw bad('behavior must be "allow" or "deny"');
}

// --- image file route ----------------------------------------------------------------------

// Raster images only: SVG can carry script, so it is not served here.
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
};
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
const ATTACHMENTS_DIR = /^paseo-attachments-[A-Za-z0-9._-]+$/;

function within(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function realOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

// Which file the board may read for an image: under the agent cwd, or inside a Paseo
// provider-image temp dir (paseo-attachments-*). Rejects `..`, non-images, and (when the
// file exists on this machine) symlinks that leave the allowed root. Returns the root to
// pass as the daemon readFile cwd and the resolved path.
export function resolveImagePath(agentCwd: string | null | undefined, requested: string | null, real: (p: string) => string | null = realOrNull): { cwd: string; path: string; mime: string } {
  if (!requested || requested.length > 4096 || requested.includes("\0")) throw bad("path is required");
  if (requested.split(/[\\/]+/).includes("..")) throw bad("path may not contain ..");
  if (!agentCwd || !path.isAbsolute(agentCwd)) throw bad("agent has no working directory", 404);
  const abs = path.resolve(path.isAbsolute(requested) ? requested : path.join(agentCwd, requested));
  const mime = IMAGE_MIME[path.extname(abs).toLowerCase()];
  if (!mime) throw bad("only image files (png, jpg, gif, webp, bmp, avif) are served", 415);
  let root: string | null = null;
  if (within(abs, path.resolve(agentCwd))) root = path.resolve(agentCwd);
  else {
    for (let d = path.dirname(abs); d !== path.dirname(d); d = path.dirname(d))
      if (ATTACHMENTS_DIR.test(path.basename(d))) {
        root = d;
        break;
      }
  }
  if (!root) throw bad("path is outside the agent's working directory", 403);
  // Symlink escape: compare real paths when the file is on this machine.
  const realFile = real(abs);
  if (realFile === null) throw bad("file not found", 404);
  const realRoot = real(root) ?? root;
  if (!within(realFile, realRoot)) throw bad("path resolves outside the agent's working directory", 403);
  if (!IMAGE_MIME[path.extname(realFile).toLowerCase()]) throw bad("only image files are served", 415);
  return { cwd: realRoot, path: realFile, mime };
}
