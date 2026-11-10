// Compact Paseo-like agent pickers (model, thinking, mode, features) under the sidebar
// title, and the header's context meter and running-turn timer. Behaviour follows
// Paseo v0.11.4 composer/agent-controls and ContextWindowMeter, rewritten as plain DOM
// selects. Pickers hide when the host cannot set them (`can.*` false) or has no options.

import type { AgentControls, ControlOption } from "../../shared/agent-controls";
import type { AgentView } from "./agents";
import { formatAgentModeLabel, formatThinkingOptionLabel } from "./paseo/agent-control-labels";
import { resolveAgentModelSelection } from "./paseo/agent-model-selection";
import { formatDuration } from "./paseo/time";
import { contextMeter, timeMs } from "./timelineItems";
import { stop, useNow } from "./TimelineItemView";
import type { ControlsState } from "./useAgentControls";
import "./timelineItems.css";

export function Picker({ testId, title, value, options, onChange, disabled }: { testId: string; title: string; value: string | null; options: { id: string; label: string; description?: string }[]; onChange: (id: string) => void; disabled?: boolean }) {
  const known = value !== null && options.some((o) => o.id === value);
  return (
    <select className="tl-select" data-testid={testId} aria-label={title} title={title} value={value ?? ""} disabled={disabled} onPointerDown={stop} onKeyDown={stop} onChange={(e) => onChange(e.target.value)}>
      {value === null ? <option value="">{title}…</option> : null}
      {value !== null && !known ? <option value={value}>{value}</option> : null}
      {options.map((o) => (
        <option key={o.id} value={o.id} title={o.description}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function AgentControlsBar({ state }: { state: ControlsState }) {
  const c: AgentControls | null = state.controls;
  if (!c || state.unsupported) return null;
  const selection = resolveAgentModelSelection({ models: c.models, runtimeModelId: c.modelId, configuredModelId: c.modelId, runtimeThinkingOptionId: c.thinkingOptionId, explicitThinkingOptionId: c.thinkingOptionId });
  const thinking: ControlOption[] = (selection.thinkingOptions ?? []).map((o) => ({ id: o.id, label: formatThinkingOptionLabel(o) }));
  const busy = !!state.busy;
  const showModel = c.can.model && c.models.length > 0;
  const showThinking = c.can.thinking && thinking.length > 0;
  const showMode = c.can.mode && c.modes.length > 0;
  const features = c.can.features ? c.features : [];
  if (!showModel && !showThinking && !showMode && !features.length && !state.notice) return null;
  return (
    <div data-testid="agent-controls" onPointerDown={stop} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4, marginTop: 4, minWidth: 0 }}>
      {showModel ? (
        <Picker testId="control-model" title="Model" value={selection.activeModelId} disabled={busy} options={c.models.map((m) => ({ id: m.id, label: m.label, description: m.description }))} onChange={(id) => void state.post("model", { modelId: id || null }, "Model")} />
      ) : null}
      {showThinking ? <Picker testId="control-thinking" title="Thinking" value={selection.selectedThinkingId} disabled={busy} options={thinking} onChange={(id) => void state.post("thinking", { optionId: id || null }, "Thinking")} /> : null}
      {showMode ? (
        <Picker testId="control-mode" title="Mode" value={c.modeId} disabled={busy} options={c.modes.map((m) => ({ id: m.id, label: formatAgentModeLabel(m), description: m.description }))} onChange={(id) => id && void state.post("mode", { modeId: id }, "Mode")} />
      ) : null}
      {features.map((f) =>
        f.type === "toggle" ? (
          <button key={f.id} type="button" className="tl-toggle" data-testid={`control-feature-${f.id}`} aria-pressed={f.value} title={f.description ?? f.label} disabled={busy} onPointerDown={stop} onClick={() => void state.post("feature", { featureId: f.id, value: !f.value }, f.label)}>
            {f.label}
          </button>
        ) : (
          <Picker key={f.id} testId={`control-feature-${f.id}`} title={f.label} value={f.value} disabled={busy} options={f.options} onChange={(id) => void state.post("feature", { featureId: f.id, value: id || null }, f.label)} />
        ),
      )}
      {state.notice ? (
        <span role="status" data-testid="controls-notice" style={{ fontSize: 11, color: state.notice.tone === "error" ? "light-dark(#b91c1c, hsl(0 74% 74%))" : "light-dark(#16a34a, hsl(142 76% 74%))", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={state.notice.text}>
          {state.notice.text}
        </span>
      ) : null}
    </div>
  );
}

// "· 45k/200k ▮▮▯ · 1m 12s" for the header subline.
export function AgentLiveStats({ view, status }: { view: AgentView | null; status: string }) {
  const meter = contextMeter(view?.usage);
  const started = view?.activeTurn ? timeMs(view.activeTurn.startedAt) : null;
  const running = status === "running" && started !== null;
  const now = useNow(running);
  if (!meter && !running) return null;
  const tone = meter ? (meter.fraction >= 0.9 ? "#dc2626" : meter.fraction >= 0.7 ? "#d97706" : "#2f80ed") : "#2f80ed";
  return (
    <>
      {meter ? (
        <span data-testid="context-meter" title={meter.title} style={{ display: "inline-flex", alignItems: "center", gap: 4, marginLeft: 6 }}>
          <span aria-hidden style={{ display: "inline-block", width: 28, height: 4, borderRadius: 2, background: "light-dark(#e2e8f0, var(--bunny-raised))", overflow: "hidden", verticalAlign: "middle" }}>
            <span style={{ display: "block", height: "100%", width: `${Math.round(meter.fraction * 100)}%`, background: tone }} />
          </span>
          {meter.label}
        </span>
      ) : null}
      {running && started !== null ? (
        <span data-testid="turn-timer" title="Time in the current turn" style={{ marginLeft: 6, fontVariantNumeric: "tabular-nums" }}>
          · {formatDuration(now - started)}
        </span>
      ) : null}
    </>
  );
}
