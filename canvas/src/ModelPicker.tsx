// Harness-then-model picker for Start conversation, fed by /api/ui/start-options (Paseo's
// live provider catalogue, or the fixed fallback list), with the chosen model's reasoning
// effort underneath. The trigger keeps the old data-testid "provider"; its data-value is the
// `provider/model` string the request sends, data-effort the thinkingOptionId (or "").
// Picking a model keeps the menu open so its effort can be set; Done or Esc closes it.
import { useEffect, useRef, useState } from "react";
import { findChoice, type StartCatalogue, type StartModel } from "../../shared/start-catalogue";
import { cleanModelId } from "./startChoice";
import { B, UI_FONT, fieldLabel, primaryBtn } from "./bunnyTheme";

const STATUS_NOTE: Record<string, string> = { loading: "loading models…", unlisted: "default model only", error: "not available" };

// "Codex · GPT-6.1 Sol · High effort": the trigger's text, shared with the phone sheet.
export function modelSummary(catalogue: StartCatalogue | null, value: string | null, effort: string | null): string {
  if (!catalogue) return "Loading models…";
  const chosen = value ? findChoice(catalogue, value) : { harness: undefined, model: undefined };
  if (!chosen.harness) return value ?? "Pick a model";
  const e = effort ? chosen.model?.efforts?.find((x) => x.id === effort) : undefined;
  return `${chosen.harness.label} · ${chosen.model?.label ?? value?.split("/").slice(1).join("/") ?? ""}${e ? ` · ${e.label} effort` : ""}`;
}

// The model's effort as one compact dropdown ("Effort: High ▾") that never wraps. "Default"
// leaves it to Paseo; the level that resolves to is shown muted beside it.
const EFFORT_CSS = `
.beff{position:relative;min-width:0;flex:0 1 auto}
.beff button.beff-trigger{display:inline-flex;align-items:center;gap:6px;max-width:100%;white-space:nowrap;padding:5px 10px;border-radius:9px;border:1px solid ${B.line};background:light-dark(#fff, var(--bunny-surface));color:${B.espresso};font:500 13px ${UI_FONT};cursor:pointer}
.beff button.beff-trigger:hover:not(:disabled){background:light-dark(#fff, var(--bunny-surface));border-color:${B.lavender}}
.beff-menu{position:absolute;left:0;z-index:30;min-width:180px;max-height:260px;overflow-y:auto;display:flex;flex-direction:column;gap:1px;padding:4px;box-sizing:border-box;background:${B.cream};border:1px solid ${B.line};border-radius:12px;box-shadow:0 10px 30px rgba(46,31,22,.18)}
.beff-menu button.beff-opt{display:flex;align-items:center;gap:8px;width:100%;text-align:left;white-space:nowrap;border:0;border-radius:8px;padding:6px 10px;background:transparent;color:${B.espresso};font:500 13px ${UI_FONT};cursor:pointer}
.beff-menu button.beff-opt:hover,.beff-menu button.beff-opt:focus-visible{background:${B.hover};border:0;outline:none}
.beff-menu button.beff-opt[aria-selected=true]{background:${B.lavenderSoft}}
.beff-muted{color:light-dark(rgba(46,31,22,.6), var(--bunny-muted));font-weight:400}
`;
export function EffortChoice({ model, effort, onEffort, up = true }: { model: StartModel | undefined; effort: string | null; onEffort: (effort: string | null) => void; up?: boolean }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open]);
  const levels = model?.efforts ?? [];
  if (!levels.length) return <span data-testid="effort-none" style={{ fontSize: 12, color: B.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{model ? "No effort setting for this model" : "Pick a model first"}</span>;
  const def = model?.defaultEffort ? levels.find((l) => l.id === model.defaultEffort)?.label : undefined;
  const current = effort ? levels.find((l) => l.id === effort) : undefined;
  const pick = (v: string | null) => {
    onEffort(v);
    setOpen(false);
  };
  return (
    <div ref={root} className="beff" data-testid="effort" data-value={effort ?? ""}>
      <style>{EFFORT_CSS}</style>
      <button type="button" className="beff-trigger" data-testid="effort-trigger" aria-haspopup="listbox" aria-expanded={open} aria-label={`Reasoning effort: ${current?.label ?? `Default${def ? ` (${def})` : ""}`}`} onClick={() => setOpen((o) => !o)}>
        <span className="beff-muted">Effort:</span>
        <span>{current?.label ?? "Default"}</span>
        {!current && def ? <span className="beff-muted">· {def}</span> : null}
        <span aria-hidden className="beff-muted" style={{ fontSize: 10 }}>▾</span>
      </button>
      {open ? (
        <div role="listbox" aria-label="Reasoning effort" className="beff-menu" data-testid="effort-menu" style={up ? { bottom: "calc(100% + 4px)" } : { top: "calc(100% + 4px)" }}>
          <button type="button" role="option" className="beff-opt" aria-selected={!effort} data-effort="" onClick={() => pick(null)}>
            <span style={{ flex: 1 }}>Default{def ? <span className="beff-muted"> · {def}</span> : null}</span>
            {!effort ? <span aria-hidden style={{ color: B.violet, fontWeight: 700 }}>✓</span> : null}
          </button>
          {levels.map((l) => (
            <button key={l.id} type="button" role="option" className="beff-opt" aria-selected={effort === l.id} data-effort={l.id} title={l.description ?? undefined} onClick={() => pick(l.id)}>
              <span style={{ flex: 1 }}>{l.label}</span>
              {effort === l.id ? <span aria-hidden style={{ color: B.violet, fontWeight: 700 }}>✓</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// "Custom model ID…": any model id for the shown harness (a model released after this Paseo
// version), sent as `harness/id` and remembered on this device by the form (onCustom).
export function CustomModelEntry({ harnessId, harnessLabel, onCustom, className }: { harnessId: string; harnessLabel: string; onCustom: (value: string) => void; className?: string }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const id = cleanModelId(text);
  if (!editing)
    return (
      <button type="button" className={className ?? "bfp-item"} data-testid="custom-model" onClick={() => setEditing(true)} style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", textAlign: "left", border: 0, borderRadius: 9, padding: "6px 10px", background: "transparent", color: B.violetDeep, fontWeight: 500 }}>
        + Custom model ID…
      </button>
    );
  const submit = () => {
    if (!id) return;
    onCustom(`${harnessId}/${id}`);
    setText("");
    setEditing(false);
  };
  return (
    <form data-testid="custom-model-form" onSubmit={(e) => { e.preventDefault(); submit(); }} style={{ display: "flex", flexDirection: "column", gap: 6, padding: "6px 6px 2px" }}>
      <label style={{ fontSize: 12, color: B.muted }} htmlFor={`custom-model-${harnessId}`}>A {harnessLabel} model id, e.g. a model released after this list</label>
      <span style={{ display: "flex", gap: 6 }}>
        {/* biome-ignore lint/a11y/noAutofocus: opened by the person to type an id. */}
        <input id={`custom-model-${harnessId}`} data-testid="custom-model-input" autoFocus value={text} placeholder={harnessId.endsWith("claude") ? "claude-fable-5-2" : "model-id"} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") setEditing(false); }} style={{ flex: 1, minWidth: 0, font: `13px ${UI_FONT}`, padding: "5px 8px", borderRadius: 8, border: `1px solid ${B.line}` }} />
        <button type="submit" data-testid="custom-model-use" disabled={!id} style={{ ...primaryBtn, padding: "4px 12px" }}>Use</button>
      </span>
    </form>
  );
}

const pill = (bg: string) => ({ fontSize: 10, fontWeight: 600, color: B.espresso, background: bg, borderRadius: 999, padding: "1px 7px", flex: "none" as const });

export function ModelPicker({ catalogue, value, onChange, effort = null, onEffort, onCustom, up = false }: { catalogue: StartCatalogue | null; value: string | null; onChange: (value: string) => void; effort?: string | null; onEffort?: (effort: string | null) => void; onCustom?: (value: string) => void; up?: boolean }) {
  const [open, setOpen] = useState(false);
  const chosen = catalogue && value ? findChoice(catalogue, value) : { harness: undefined, model: undefined };
  const [harnessId, setHarnessId] = useState<string | undefined>(chosen.harness?.id);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setHarnessId(chosen.harness?.id ?? catalogue?.harnesses.find((h) => h.status !== "error")?.id);
    const close = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("keydown", esc, true);
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: reset the column only when opening.
  }, [open]);

  const harness = catalogue?.harnesses.find((h) => h.id === harnessId);
  const summary = modelSummary(catalogue, value, effort);

  return (
    <div ref={root} style={{ position: "relative", minWidth: 0 }}>
      <button
        type="button"
        data-testid="provider"
        data-value={value ?? ""}
        data-effort={effort ?? ""}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Harness and model: ${summary}`}
        disabled={!catalogue}
        onClick={() => setOpen((o) => !o)}
        style={{ display: "flex", alignItems: "center", gap: 8, maxWidth: "100%", padding: "6px 12px", borderRadius: 10, background: "light-dark(#fff, var(--bunny-surface))" }}
      >
        <span style={{ width: 8, height: 8, borderRadius: 4, background: B.violet, flex: "none" }} aria-hidden />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{summary}</span>
        <span aria-hidden style={{ color: B.muted, fontSize: 10 }}>▾</span>
      </button>
      {open && catalogue ? (
        <div
          role="dialog"
          aria-label="Choose harness and model"
          data-testid="provider-menu"
          className="bfp-pop"
          style={{ position: "absolute", ...(up ? { bottom: "calc(100% + 6px)" } : { top: "calc(100% + 6px)" }), left: 0, zIndex: 20, display: "grid", gridTemplateColumns: "minmax(130px, auto) minmax(220px, 320px)", maxWidth: "min(520px, calc(100vw - 32px))", background: B.cream, border: `1px solid ${B.line}`, borderRadius: 14, boxShadow: "0 14px 40px rgba(46,31,22,.18)", overflow: "hidden", font: `13px ${UI_FONT}` }}
        >
          <div style={{ padding: 8, borderRight: `1px solid ${B.line}`, display: "flex", flexDirection: "column", gap: 2 }}>
            <div style={{ ...fieldLabel, padding: "2px 8px 6px" }}>Harness</div>
            {catalogue.harnesses.map((h) => (
              <button
                key={h.id}
                type="button"
                className={`bfp-item${h.id === harnessId ? " bfp-on" : ""}`}
                data-harness={h.id}
                aria-pressed={h.id === harnessId}
                disabled={h.status === "error"}
                title={h.error ?? undefined}
                onClick={() => setHarnessId(h.id)}
                style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 0, width: "100%", textAlign: "left", border: 0, borderRadius: 9, padding: "6px 10px", background: h.id === harnessId ? B.lavenderSoft : "transparent" }}
              >
                <span style={{ fontWeight: 600 }}>{h.label}</span>
                <span style={{ fontSize: 11, color: B.muted }}>{STATUS_NOTE[h.status] ?? `${h.models.length} model${h.models.length === 1 ? "" : "s"}`}</span>
              </button>
            ))}
          </div>
          <div style={{ padding: 8, display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <div style={{ ...fieldLabel, padding: "2px 8px 6px" }}>{harness ? `${harness.label} models` : "Models"}</div>
            <div data-testid="provider-models" style={{ maxHeight: 280, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 }} role="listbox" aria-label={harness ? `${harness.label} models` : "Models"}>
            {(harness?.models ?? []).map((m) => (
              <button
                key={m.value}
                type="button"
                role="option"
                aria-selected={m.value === value}
                className={`bfp-item${m.value === value ? " bfp-on" : ""}`}
                data-value={m.value}
                title={m.description ?? m.value}
                onClick={() => {
                  onChange(m.value);
                  if (!onEffort) setOpen(false);
                }}
                style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", border: 0, borderRadius: 9, padding: "6px 10px", background: m.value === value ? B.lavenderSoft : "transparent" }}
              >
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontWeight: 500 }}>{m.label}</span>
                  {m.id && m.id !== m.label ? <span style={{ display: "block", fontSize: 11, color: B.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.id}</span> : null}
                </span>
                {m.isDefault ? <span style={pill(B.golden)}>default</span> : null}
                {m.live ? <span style={pill(B.lavenderSoft)} title="Reported by the installed CLI; not in Paseo's list yet">new</span> : null}
                {m.custom ? <span style={pill(B.peachSoft)} title="A model id you entered">custom</span> : null}
                {m.value === value ? <span aria-hidden style={{ color: B.violet, fontWeight: 700 }}>✓</span> : null}
              </button>
            ))}
            {harness?.status === "unlisted" ? <div data-testid="provider-unlisted-note" title={harness.error} style={{ fontSize: 11, color: B.espresso, background: B.peachSoft, borderRadius: 8, padding: "6px 10px", margin: "4px 2px 0" }}>This harness's model list didn't load, so only its default model is offered.</div> : null}
            {harness?.status === "loading" ? <div style={{ fontSize: 11, color: B.muted, padding: "4px 10px" }}>Paseo is still loading this harness's models.</div> : null}
            </div>
            {onCustom && harness && harness.status !== "error" ? <CustomModelEntry key={harness.id} harnessId={harness.id} harnessLabel={harness.label} onCustom={onCustom} /> : null}
          </div>
          {onEffort ? (
            <div data-testid="effort-row" style={{ gridColumn: "1 / -1", display: "flex", alignItems: "center", flexWrap: "nowrap", gap: 10, padding: "8px 10px 8px 12px", borderTop: `1px solid ${B.line}`, minWidth: 0 }}>
              <EffortChoice model={chosen.model} effort={effort} onEffort={onEffort} />
              <button type="button" data-testid="provider-done" className="bfp-primary" style={{ ...primaryBtn, padding: "5px 14px", marginLeft: "auto" }} onClick={() => setOpen(false)}>Done</button>
            </div>
          ) : null}
          {catalogue.source === "fallback" ? (
            <div data-testid="provider-fallback" style={{ gridColumn: "1 / -1", padding: "8px 12px", fontSize: 11, color: B.espresso, background: B.peachSoft, borderTop: `1px solid ${B.line}` }}>
              {catalogue.reason ?? "Paseo's model list is not available"}; showing the usual choices.
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
