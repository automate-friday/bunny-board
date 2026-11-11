// Phone start sheet: the model picker. A full-width trigger (never shown disabled: while
// Paseo's catalogue loads it says so) opens a bottom sheet over the start sheet with the
// harnesses as tabs and each model as a 48 px row. Same catalogue and values as the desktop
// ModelPicker (shared/start-catalogue.ts), with the chosen model's effort and "Custom model
// ID…" under the list; the trigger keeps data-testid "provider".

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useModalHold } from "./modalHold";
import { findChoice, type StartCatalogue } from "../../../shared/start-catalogue";
import { CustomModelEntry, EffortChoice, modelSummary } from "../ModelPicker";

const STATUS_NOTE: Record<string, string> = { loading: "loading models…", unlisted: "default model only", error: "not available" };

export function ModelSheet({ catalogue, value, onChange, effort = null, onEffort, onCustom }: { catalogue: StartCatalogue | null; value: string | null; onChange: (value: string) => void; effort?: string | null; onEffort?: (effort: string | null) => void; onCustom?: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  useModalHold(open);
  const chosen = catalogue && value ? findChoice(catalogue, value) : { harness: undefined, model: undefined };
  const [harnessId, setHarnessId] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (open) setHarnessId(chosen.harness?.id ?? catalogue?.harnesses.find((h) => h.status !== "error")?.id);
    // biome-ignore lint/correctness/useExhaustiveDependencies: pick the tab only when opening.
  }, [open]);
  const harness = catalogue?.harnesses.find((h) => h.id === harnessId);
  const summary = modelSummary(catalogue, value, effort);
  return (
    <>
      <button type="button" className="bm-model-trigger" onPointerDown={() => (document.activeElement as HTMLElement | null)?.blur?.()} data-testid="provider" data-value={value ?? ""} aria-haspopup="dialog" aria-expanded={open} aria-busy={!catalogue} aria-label={`Model: ${summary}. Change`} onClick={() => catalogue && setOpen(true)}>
        <i aria-hidden="true" />
        <span>{summary}</span>
        <b aria-hidden="true">Change</b>
      </button>
      {open && catalogue ? createPortal(
        <div className="bm-model-layer" data-mobile-ui data-testid="provider-layer">
          <div className="bm-start-scrim" onPointerDown={() => setOpen(false)} />
          <div className="bm-model-sheet" role="dialog" aria-modal="true" aria-label="Choose a model" data-testid="provider-menu" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") setOpen(false); }}>
            <div className="bm-start-head">
              <span className="bm-grip-bar" aria-hidden="true" />
              <b>Model</b>
            </div>
            <div className="bm-model-tabs" role="tablist" aria-label="Harness">
              {catalogue.harnesses.map((h) => (
                <button key={h.id} type="button" role="tab" data-harness={h.id} aria-selected={h.id === harnessId} disabled={h.status === "error"} title={h.error ?? undefined} onClick={() => setHarnessId(h.id)}>
                  {h.label}
                  <small>{STATUS_NOTE[h.status] ?? `${h.models.length} model${h.models.length === 1 ? "" : "s"}`}</small>
                </button>
              ))}
            </div>
            <div className="bm-model-list" role="listbox" aria-label={harness ? `${harness.label} models` : "Models"}>
              {(harness?.models ?? []).map((m) => (
                <button key={m.value} type="button" role="option" aria-selected={m.value === value} data-value={m.value} onClick={() => { onChange(m.value); if (!onEffort) setOpen(false); }}>
                  <span>
                    {m.label}
                    {m.id && m.id !== m.label ? <small>{m.id}</small> : null}
                  </span>
                  {m.isDefault ? <em>default</em> : m.live ? <em>new</em> : m.custom ? <em>custom</em> : null}
                  {m.value === value ? <b aria-hidden="true">✓</b> : null}
                </button>
              ))}
              {harness?.status === "unlisted" ? <p>This harness's model list didn't load, so only its default model is offered.</p> : null}
              {harness?.status === "loading" ? <p>Paseo is still loading this harness's models.</p> : null}
              {onCustom && harness && harness.status !== "error" ? <CustomModelEntry key={harness.id} harnessId={harness.id} harnessLabel={harness.label} onCustom={onCustom} className="bm-model-custom" /> : null}
              {catalogue.source === "fallback" ? <p data-testid="provider-fallback">{catalogue.reason ?? "Paseo's model list is not available"}; showing the usual choices.</p> : null}
            </div>
            {onEffort ? (
              <div className="bm-model-effort" data-testid="effort-row">
                <EffortChoice model={chosen.model} effort={effort} onEffort={onEffort} />
              </div>
            ) : null}
            <div className="bm-start-foot">
              <button type="button" className="bm-start-cancel" data-testid="provider-close" onClick={() => setOpen(false)}>
                Done
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
