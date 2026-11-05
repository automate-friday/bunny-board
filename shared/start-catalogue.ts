// Harnesses and models for "Start conversation" (FramePanel's model picker), built from
// Paseo's provider catalogue (getProvidersSnapshot) so the board offers what the daemon
// offers. The chosen `value` is the `provider/model` string agents.create takes (or just
// `provider` for the harness's own default). When Paseo cannot answer, FALLBACK_PROVIDERS
// keeps the picker usable.

export type StartModel = { id: string; label: string; value: string; description?: string; isDefault?: boolean };
// "unlisted": the harness is installed but its model list did not load (a refresh timed
// out, say); it can still start on its own default model.
export type StartHarness = { id: string; label: string; status: "ready" | "loading" | "unlisted" | "error"; error?: string; models: StartModel[] };
export type StartCatalogue = { source: "paseo" | "fallback"; defaultProvider: string; harnesses: StartHarness[]; reason?: string };

export const FALLBACK_PROVIDERS = ["claude/claude-opus-5-5", "claude/claude-sonnet-5", "codex/gpt-5.5", "pi", "omp"];

// Errors that mean the harness's CLI is not on this Mac; anything else (timeouts, refresh
// failures) leaves it startable on its default model, as the bare provider id always was.
const MISSING_CLI = /not found on PATH|command not found|ENOENT|not installed/i;

const text = (v: unknown, max = 200): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

// One harness's default model, as a picker row: the bare provider id lets Paseo choose.
const harnessDefault = (provider: string): StartModel => ({ id: "", label: "Default model", value: provider });

// Catalogue entries → harnesses. Disabled and unavailable harnesses are left out; a
// harness whose CLI is missing stays listed (greyed, with the reason) so it is clear why it is
// missing; one that errored otherwise is "unlisted" and keeps its default model.
export function startCatalogue(entries: unknown, defaultProvider: string): StartCatalogue {
  const harnesses: StartHarness[] = [];
  for (const raw of Array.isArray(entries) ? entries : []) {
    // biome-ignore lint/suspicious/noExplicitAny: ProviderSnapshotEntry payload.
    const e = raw as any;
    const id = text(e?.provider, 80);
    if (!id || id.includes("/") || harnesses.some((h) => h.id === id)) continue;
    if (e.enabled === false || e.status === "unavailable") continue;
    const error = e.status === "error" ? text(e.error, 300) ?? "not available on this Mac" : undefined;
    const status: StartHarness["status"] = error ? (MISSING_CLI.test(error) ? "error" : "unlisted") : e.status === "ready" ? "ready" : "loading";
    const models: StartModel[] = [];
    for (const m of Array.isArray(e.models) ? e.models : []) {
      const mid = text(m?.id, 200);
      if (!mid || m.isSelectable === false || models.some((x) => x.id === mid)) continue;
      models.push({ id: mid, label: text(m.label) ?? mid, value: `${id}/${mid}`, ...(text(m.description, 300) ? { description: text(m.description, 300) } : {}), ...(m.isDefault === true ? { isDefault: true } : {}) });
    }
    // Default model first, so "pick a harness" lands on what Paseo would use anyway.
    models.sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault));
    if (!models.length && status !== "error") models.push(harnessDefault(id));
    harnesses.push({ id, label: text(e.label, 80) ?? id, status, ...(error ? { error } : {}), models });
  }
  return { source: "paseo", defaultProvider, harnesses };
}

// The fixed list the board used before it read Paseo's catalogue, grouped the same way.
export function fallbackCatalogue(defaultProvider: string, reason: string, providers = FALLBACK_PROVIDERS): StartCatalogue {
  const harnesses: StartHarness[] = [];
  for (const p of providers.includes(defaultProvider) ? providers : [defaultProvider, ...providers]) {
    const [id, ...rest] = p.split("/");
    const model = rest.join("/");
    let h = harnesses.find((x) => x.id === id);
    if (!h) harnesses.push((h = { id, label: id, status: "ready", models: [] }));
    if (h.models.some((m) => m.value === p)) continue;
    h.models.push(model ? { id: model, label: model, value: p } : harnessDefault(id));
  }
  return { source: "fallback", defaultProvider, harnesses, reason };
}

// The provider string for agents.create. Paseo's client (0.11.4) throws "Expected
// config.provider in "provider/model" format" for a bare harness id, which the picker
// sends as "Default model" whenever that harness's model list did not load (on a fresh
// install: Claude is not signed in yet). A bare id becomes the board's default model when
// it is the same harness, else the first known model of that harness; other bare ids are
// left as they are.
export function resolveStartProvider(chosen: string, defaultProvider: string, known = FALLBACK_PROVIDERS): string {
  if (chosen.includes("/")) return chosen;
  return [defaultProvider, ...known].find((p) => p.startsWith(`${chosen}/`)) ?? chosen;
}

// The value to preselect: the board's default when the catalogue has it, else the default
// model of the default harness, else the first ready harness's first model.
export function initialChoice(c: StartCatalogue): string | null {
  const all = c.harnesses.filter((h) => h.status !== "error").flatMap((h) => h.models);
  if (all.some((m) => m.value === c.defaultProvider)) return c.defaultProvider;
  const harness = c.harnesses.find((h) => h.id === c.defaultProvider.split("/")[0] && h.status !== "error" && h.models.length);
  if (harness) return harness.models[0].value;
  return all[0]?.value ?? null;
}

// Harness and model rows for a chosen value (unknown values keep their harness prefix).
export function findChoice(c: StartCatalogue, value: string): { harness: StartHarness | undefined; model: StartModel | undefined } {
  for (const h of c.harnesses) {
    const model = h.models.find((m) => m.value === value);
    if (model) return { harness: h, model };
  }
  return { harness: c.harnesses.find((h) => h.id === value.split("/")[0]), model: undefined };
}
