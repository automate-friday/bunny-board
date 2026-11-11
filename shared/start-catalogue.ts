// Harnesses and models for "Start conversation" (FramePanel's model picker), built from
// Paseo's provider catalogue (getProvidersSnapshot) so the board offers what the daemon
// offers. The chosen `value` is the `provider/model` string agents.create takes (or just
// `provider` for the harness's own default). When Paseo cannot answer, FALLBACK_PROVIDERS
// keeps the picker usable.

// `efforts`: the model's reasoning-effort levels (Paseo's thinkingOptions), sent as
// thinkingOptionId when one is chosen; none means the model has no effort setting.
export type StartEffort = { id: string; label: string; description?: string };
// `live`: reported by the CLI, not (yet) by Paseo; `custom`: an id the person typed.
export type StartModel = { id: string; label: string; value: string; description?: string; isDefault?: boolean; efforts?: StartEffort[]; defaultEffort?: string; live?: boolean; custom?: boolean };
// "unlisted": the harness is installed but its model list did not load (a refresh timed
// out, say); it can still start on its own default model.
export type StartHarness = { id: string; label: string; status: "ready" | "loading" | "unlisted" | "error"; error?: string; models: StartModel[] };
export type StartCatalogue = { source: "paseo" | "fallback"; defaultProvider: string; harnesses: StartHarness[]; reason?: string };

export const FALLBACK_PROVIDERS = ["claude/claude-opus-5-5", "claude/claude-sonnet-5", "codex/gpt-5.5", "pi", "omp"];
// Levels Claude and Codex models take when Paseo's own list is not available.
export const FALLBACK_EFFORTS: StartEffort[] = [{ id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "high", label: "High" }];
const FALLBACK_EFFORT_HARNESS = /^(upstash-)?(claude|codex)$/;

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
      const efforts = startEfforts(m.thinkingOptions);
      const defaultEffort = text(m.defaultThinkingOptionId, 80) ?? (Array.isArray(m.thinkingOptions) ? text(m.thinkingOptions.find((o: { isDefault?: boolean }) => o?.isDefault)?.id, 80) : undefined);
      models.push({ id: mid, label: text(m.label) ?? mid, value: `${id}/${mid}`, ...(m.live === true ? { live: true } : {}), ...(text(m.description, 300) ? { description: text(m.description, 300) } : {}), ...(m.isDefault === true ? { isDefault: true } : {}), ...(efforts.length ? { efforts, ...(defaultEffort && efforts.some((e) => e.id === defaultEffort) ? { defaultEffort } : {}) } : {}) });
    }
    sortNewestFirst(models);
    if (!models.length && status !== "error") models.push(harnessDefault(id));
    harnesses.push({ id, label: text(e.label, 80) ?? id, status, ...(error ? { error } : {}), models });
  }
  return { source: "paseo", defaultProvider, harnesses };
}

// The version a model id carries ("claude-fable-5-2" → [5, 2], "gpt-6.1-sol" → [6, 1]); null
// when it has none. Dates ("…-20250514") are not versions.
export function modelVersion(id: string): [number, number] | null {
  const m = id.match(/(?:^|[^\d])(\d{1,2})(?:[.-](\d{1,2}))?(?!\d)/);
  return m ? [Number(m[1]), m[2] === undefined ? 0 : Number(m[2])] : null;
}

// Newest first within a harness: higher versions lead; models without a version (and ties)
// keep the order the catalogue gave them. In place.
export function sortNewestFirst(models: StartModel[]): StartModel[] {
  const order = new Map(models.map((m, i) => [m.value, i]));
  return models.sort((a, b) => {
    const va = modelVersion(a.id);
    const vb = modelVersion(b.id);
    if (va && vb && (va[0] !== vb[0] || va[1] !== vb[1])) return vb[0] - va[0] || vb[1] - va[1];
    if (!!va !== !!vb) return va ? -1 : 1;
    return (order.get(a.value) ?? 0) - (order.get(b.value) ?? 0);
  });
}

// Models a live source reports (server/cli-models.ts: the installed Claude CLI) added to the
// matching Paseo entries (`provider` and its upstash- twin) when Paseo does not list them yet,
// so a model released after this Paseo version can still be picked. Entries Paseo could not
// load (error) are left alone.
export function withLiveModels(entries: unknown, provider: string, live: Array<{ id: string; label: string; description?: string; thinkingOptions?: Array<{ id: string; label: string }> }> | null | undefined): unknown[] {
  const list = Array.isArray(entries) ? entries : [];
  if (!live?.length) return list;
  // biome-ignore lint/suspicious/noExplicitAny: ProviderSnapshotEntry payload.
  return list.map((e: any) => {
    if ((e?.provider !== provider && e?.provider !== `upstash-${provider}`) || e.status === "error" || e.enabled === false) return e;
    const own = Array.isArray(e.models) ? e.models : [];
    // biome-ignore lint/suspicious/noExplicitAny: model rows.
    const known = (id: string) => own.some((m: any) => m?.id === id || (Array.isArray(m?.aliases) && m.aliases.includes(id)));
    const missing = live.filter((m) => !known(m.id));
    return missing.length ? { ...e, models: [...own, ...missing.map((m) => ({ ...m, provider: e.provider, live: true }))] } : e;
  });
}

// Model ids the person typed in the picker ("Custom model ID…", remembered on this device) as
// rows of their harness, so a model neither Paseo nor the CLI lists yet can still be started.
export function withCustomModels(c: StartCatalogue, custom: string[]): StartCatalogue {
  if (!custom.length) return c;
  const harnesses = c.harnesses.map((h) => {
    const extra = custom
      .filter((v) => v.startsWith(`${h.id}/`) && v.length > h.id.length + 1 && !h.models.some((m) => m.value === v))
      .map((v): StartModel => {
        const id = v.slice(h.id.length + 1);
        const like = nearestKnownModel(h.models, id);
        const efforts = like?.efforts ?? (FALLBACK_EFFORT_HARNESS.test(h.id) ? FALLBACK_EFFORTS : undefined);
        return { id, label: typedModelLabel(id), value: v, custom: true, ...(efforts ? { efforts, ...(like?.defaultEffort ? { defaultEffort: like.defaultEffort } : {}) } : {}) };
      });
    if (!extra.length || h.status === "error") return h;
    const models = sortNewestFirst([...h.models.filter((m) => m.id), ...extra]);
    return { ...h, models: models.length ? models : h.models };
  });
  return { ...c, harnesses };
}

// A model id's family: the id with its version taken out ("claude-fable-5-2" → "claude-fable-#").
export function modelFamily(id: string): string {
  return id.replace(/\[1m\]$/i, "").replace(/(^|[^\d])\d{1,2}(?:[.-]\d{1,2})?(?!\d)/, "$1#");
}

// The known model a typed id borrows its effort levels from: the newest model of the same
// family with effort levels ("claude-fable-5-2" → claude-fable-5-1), else the harness's newest
// model with effort levels. Paseo knows a model's levels; a typed id has none of its own.
export function nearestKnownModel(models: StartModel[], id: string): StartModel | undefined {
  const known = sortNewestFirst(models.filter((m) => m.id && !m.custom && m.efforts?.length).slice());
  const family = modelFamily(id);
  return known.find((m) => modelFamily(m.id) === family) ?? known.find((m) => modelVersion(m.id)) ?? known[0];
}

// "claude-fable-5-2" → "Fable 5.2" (Claude's naming); other ids are shown as typed.
export function typedModelLabel(id: string): string {
  const m = id.match(/^claude-([a-z]+)-(\d{1,2})(?:-(\d{1,2}))?(\[1m\])?$/i);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}${m[4] ? " 1M" : ""}` : id;
}

// A model's thinkingOptions as effort levels (ids deduped, labels default to the id).
function startEfforts(raw: unknown): StartEffort[] {
  const out: StartEffort[] = [];
  for (const o of Array.isArray(raw) ? raw : []) {
    const id = text(o?.id, 80);
    if (!id || out.some((e) => e.id === id)) continue;
    out.push({ id, label: text(o.label, 80) ?? id, ...(text(o.description, 200) ? { description: text(o.description, 200) } : {}) });
  }
  return out;
}

// Upstash harnesses (upstash-codex, upstash-claude) run the same CLIs as the plain ones; when
// an Upstash entry lists fewer models than its plain twin, the twin's models fill it in, so the
// picker offers every model and not just the worker's default.
export function withBaseModels(entries: unknown): unknown[] {
  const list = Array.isArray(entries) ? entries : [];
  // biome-ignore lint/suspicious/noExplicitAny: ProviderSnapshotEntry payload.
  const byId = new Map(list.map((e: any) => [e?.provider, e]));
  // biome-ignore lint/suspicious/noExplicitAny: ProviderSnapshotEntry payload.
  return list.map((e: any) => {
    const base = typeof e?.provider === "string" && e.provider.startsWith("upstash-") ? byId.get(e.provider.slice(8)) : null;
    const own = Array.isArray(e?.models) ? e.models : [];
    const more = Array.isArray(base?.models) ? base.models : [];
    // biome-ignore lint/suspicious/noExplicitAny: model rows.
    const missing = more.filter((m: any) => m?.id && !own.some((o: any) => o?.id === m.id));
    if (!missing.length) return e;
    // biome-ignore lint/suspicious/noExplicitAny: model rows.
    const merged = [...own, ...missing.map((m: any) => ({ ...m, provider: e.provider, isDefault: own.length ? false : m.isDefault }))];
    return { ...e, models: merged, ...(e.status === "loading" || e.status === "error" ? {} : { status: e.status ?? base.status }) };
  });
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
    h.models.push(model ? { id: model, label: model, value: p, ...(FALLBACK_EFFORT_HARNESS.test(id) ? { efforts: FALLBACK_EFFORTS } : {}) } : harnessDefault(id));
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

// The effort to send for a model: `wanted` when the model offers it, else none (Paseo's
// default for that model).
export function effortFor(c: StartCatalogue | null, value: string | null, wanted: string | null | undefined): string | null {
  if (!c || !value || !wanted) return null;
  const model = findChoice(c, value).model;
  return model?.efforts?.some((e) => e.id === wanted) ? wanted : null;
}

// The model and effort to preselect: the last ones chosen (`saved`) when the catalogue still
// offers that model (a remembered harness whose model is gone gets that harness's default),
// else initialChoice.
export function rememberedChoice(c: StartCatalogue, saved: { provider?: string | null; effort?: string | null } | null | undefined): { provider: string | null; effort: string | null } {
  const want = saved?.provider;
  const like = want ? findChoice(c, want) : null;
  const usable = like?.harness && like.harness.status !== "error" ? like : null;
  const provider = usable?.model?.value ?? (usable?.harness ? (usable.harness.models.find((m) => m.isDefault) ?? usable.harness.models[0])?.value : undefined) ?? initialChoice(c);
  return { provider, effort: effortFor(c, provider, saved?.effort) };
}

// A start request's effort as Paseo's thinkingOptionId: a short plain id, else none (the
// request comes from frame meta any board client can write).
export function startEffort(v: unknown): string | undefined {
  return typeof v === "string" && /^[A-Za-z0-9._-]{1,40}$/.test(v) ? v : undefined;
}
