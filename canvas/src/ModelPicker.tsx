// Harness-then-model picker for Start conversation, fed by /api/ui/start-options (Paseo's
// live provider catalogue, or the fixed fallback list). The trigger keeps the old
// data-testid "provider"; its data-value is the `provider/model` string the request sends.
import { useEffect, useRef, useState } from "react";
import { findChoice, type StartCatalogue } from "../../shared/start-catalogue";
import { B, UI_FONT, fieldLabel } from "./bunnyTheme";

const STATUS_NOTE: Record<string, string> = { loading: "loading models…", unlisted: "default model only", error: "not available" };

export function ModelPicker({ catalogue, value, onChange, up = false }: { catalogue: StartCatalogue | null; value: string | null; onChange: (value: string) => void; up?: boolean }) {
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
  const summary = !catalogue ? "Loading models…" : chosen.harness ? `${chosen.harness.label} · ${chosen.model?.label ?? value?.split("/").slice(1).join("/") ?? ""}` : value ?? "Pick a model";

  return (
    <div ref={root} style={{ position: "relative", minWidth: 0 }}>
      <button
        type="button"
        data-testid="provider"
        data-value={value ?? ""}
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
          style={{ position: "absolute", ...(up ? { bottom: "calc(100% + 6px)" } : { top: "calc(100% + 6px)" }), left: 0, zIndex: 20, display: "grid", gridTemplateColumns: "minmax(130px, auto) minmax(200px, 280px)", maxWidth: "min(480px, calc(100vw - 32px))", background: B.cream, border: `1px solid ${B.line}`, borderRadius: 14, boxShadow: "0 14px 40px rgba(46,31,22,.18)", overflow: "hidden", font: `13px ${UI_FONT}` }}
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
          <div style={{ padding: 8, maxHeight: 300, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 }} role="listbox" aria-label={harness ? `${harness.label} models` : "Models"}>
            <div style={{ ...fieldLabel, padding: "2px 8px 6px" }}>{harness ? `${harness.label} models` : "Models"}</div>
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
                  setOpen(false);
                }}
                style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", border: 0, borderRadius: 9, padding: "6px 10px", background: m.value === value ? B.lavenderSoft : "transparent" }}
              >
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontWeight: 500 }}>{m.label}</span>
                  {m.id && m.id !== m.label ? <span style={{ display: "block", fontSize: 11, color: B.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.id}</span> : null}
                </span>
                {m.isDefault ? <span style={{ fontSize: 10, fontWeight: 600, color: B.espresso, background: B.golden, borderRadius: 999, padding: "1px 7px" }}>default</span> : null}
                {m.value === value ? <span aria-hidden style={{ color: B.violet, fontWeight: 700 }}>✓</span> : null}
              </button>
            ))}
            {harness?.status === "unlisted" ? <div data-testid="provider-unlisted-note" title={harness.error} style={{ fontSize: 11, color: B.espresso, background: B.peachSoft, borderRadius: 8, padding: "6px 10px", margin: "4px 2px 0" }}>This harness's model list didn't load, so only its default model is offered.</div> : null}
            {harness?.status === "loading" ? <div style={{ fontSize: 11, color: B.muted, padding: "4px 10px" }}>Paseo is still loading this harness's models.</div> : null}
          </div>
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
