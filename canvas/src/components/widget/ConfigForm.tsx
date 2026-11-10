// A widget's config form, built from its manifest fields. "select" fields ask the data
// source for choices (GET /api/ui/widgets/options), given the fields filled in above, so
// the Slack widget goes account → channel → (optional) thread.

import { useEffect, useState } from "react";
import { type AnyConfig, type WidgetField, type WidgetManifest, widgetConfig, widgetKey } from "../../../../shared/widgets";
import { api } from "../../api";

interface Option {
  value: string;
  label: string;
}

function SelectField({ manifest, field, draft, value, onChange, disabled }: { manifest: WidgetManifest; field: WidgetField; draft: AnyConfig; value: string; onChange(v: string): void; disabled: boolean }) {
  const deps = (field.dependsOn ?? []).map((k) => draft[k] ?? "");
  const ready = deps.every(Boolean);
  const [opts, setOpts] = useState<Option[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const depKey = JSON.stringify(deps);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch only when the fields it depends on change.
  useEffect(() => {
    if (!ready) {
      setOpts(null);
      return;
    }
    let cancelled = false;
    setOpts(null);
    setError(null);
    const partial: AnyConfig = {};
    for (const k of field.dependsOn ?? []) partial[k] = draft[k];
    let key: string;
    try {
      key = widgetKey(manifest.id, widgetConfig(manifest.id, partial));
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    api<{ options: Option[] }>(`/api/ui/widgets/options?key=${encodeURIComponent(key)}&field=${encodeURIComponent(field.key)}`)
      .then((r) => !cancelled && setOpts(r.options))
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [depKey, ready, manifest.id, field.key]);
  if (!ready) return <select disabled style={inputStyle}><option>Pick {field.dependsOn?.join(" and ")} first</option></select>;
  if (error)
    return (
      <>
        <input value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder} style={inputStyle} />
        <small style={{ color: "light-dark(#b3261e, hsl(3 71% 74%))" }}>{error}</small>
      </>
    );
  return (
    <select data-testid={`widget-field-${field.key}`} value={value} disabled={disabled || !opts} onChange={(e) => onChange(e.target.value)} style={inputStyle}>
      <option value="">{!opts ? "loading…" : field.required ? "Choose…" : "(none)"}</option>
      {opts?.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
      {value && opts && !opts.some((o) => o.value === value) ? <option value={value}>{value}</option> : null}
    </select>
  );
}

const inputStyle: React.CSSProperties = { width: "100%", boxSizing: "border-box", padding: "4px 6px", border: "1px solid light-dark(#c9ced6, var(--bunny-line))", borderRadius: 6, font: "12px system-ui", background: "light-dark(#fff, var(--bunny-surface))" };

export function WidgetConfigForm({ manifest, config, readOnly, onSave, onCancel }: { manifest: WidgetManifest; config: AnyConfig; readOnly: boolean; onSave(c: AnyConfig): void; onCancel?: () => void }) {
  const [draft, setDraft] = useState<AnyConfig>(config);
  const [error, setError] = useState<string | null>(null);
  const set = (field: WidgetField, v: string) => {
    setDraft((d) => {
      const next = { ...d, [field.key]: v };
      // Clear fields whose choices depended on this one.
      for (const f of manifest.fields) if (f.dependsOn?.includes(field.key)) next[f.key] = "";
      return next;
    });
    setError(null);
  };
  const submit = () => {
    try {
      const c = widgetConfig(manifest.id, Object.fromEntries(Object.entries(draft).filter(([, v]) => v !== "" && v !== undefined)));
      if (!manifest.configured(c)) throw new Error(`Fill in ${manifest.fields.filter((f) => f.required).map((f) => f.label.toLowerCase()).join(", ")}`);
      onSave(c);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <form
      data-testid="widget-config-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      style={{ padding: "8px 12px", display: "flex", flexDirection: "column", gap: 6 }}
    >
      <div style={{ color: "light-dark(#556, var(--bunny-muted))" }}>{manifest.description}</div>
      {manifest.fields.map((f) => (
        <label key={f.key} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontWeight: 600 }}>
            {f.label}
            {f.required ? "" : <span style={{ color: "light-dark(#889, var(--bunny-muted))", fontWeight: 400 }}> (optional)</span>}
          </span>
          {f.kind === "select" && f.choices ? (
            <select data-testid={`widget-field-${f.key}`} value={String(draft[f.key] ?? "")} disabled={readOnly} onChange={(e) => set(f, e.target.value)} style={inputStyle}>
              {f.required ? null : <option value="">(none)</option>}
              {f.choices.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : f.kind === "select" ? (
            <SelectField manifest={manifest} field={f} draft={draft} value={String(draft[f.key] ?? "")} onChange={(v) => set(f, v)} disabled={readOnly} />
          ) : (
            <>
              <input data-testid={`widget-field-${f.key}`} value={String(draft[f.key] ?? "")} disabled={readOnly} placeholder={f.placeholder} onChange={(e) => set(f, e.target.value)} style={inputStyle} />
              {f.suggestions?.length ? (
                // Presets as one-tap chips (a datalist hides them once the field has text).
                <span style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {f.suggestions.map((v) => (
                    <button key={v} type="button" data-testid={`widget-preset-${f.key}`} disabled={readOnly} onClick={() => set(f, v)} style={{ border: `1px solid ${draft[f.key] === v ? "light-dark(#2f80ed, hsl(214 35% 39%))" : "light-dark(#d5d9e0, var(--bunny-line))"}`, background: draft[f.key] === v ? "light-dark(#eaf2fe, hsl(216 45% 21%))" : "light-dark(#fff, var(--bunny-surface))", borderRadius: 10, padding: "1px 8px", cursor: "pointer", font: "11px system-ui" }}>
                      {v}
                    </button>
                  ))}
                </span>
              ) : null}
            </>
          )}
        </label>
      ))}
      {error ? <small style={{ color: "light-dark(#b3261e, hsl(3 71% 74%))" }}>{error}</small> : null}
      <div style={{ display: "flex", gap: 6 }}>
        <button type="submit" data-testid="widget-save" disabled={readOnly} style={{ border: "1px solid light-dark(#2f80ed, hsl(214 35% 39%))", background: "#2f80ed", color: "#fff", borderRadius: 6, padding: "3px 12px", cursor: "pointer" }}>
          Save
        </button>
        {onCancel ? (
          <button type="button" onClick={onCancel} style={{ border: "1px solid light-dark(#c9ced6, var(--bunny-line))", background: "light-dark(#fff, var(--bunny-surface))", borderRadius: 6, padding: "3px 10px", cursor: "pointer" }}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}
