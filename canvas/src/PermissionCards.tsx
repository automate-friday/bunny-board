import { PaseoLink } from "./PaseoLink";
import type { PaseoLinkState } from "../../shared/conversation-links";
// Inline permission requests above the reply box (Paseo v0.11.4 agent-stream/view.tsx
// PermissionRequestCard and components/question-form-card.tsx, rewritten as DOM). Each
// card shows what the agent wants to do through the same tool detail view as the
// timeline, then the provider's actions (else Deny / Allow). Plans offer "Implement";
// simple questions get a small form, anything else links to Paseo.

import { Emoji } from "./Emoji";
import { useState } from "react";
import type { PermissionRequestView, PermissionResponseBody } from "../../shared/agent-controls";
import { MessageBody } from "./MessageBody";
import {
  areQuestionsAnswered,
  buildQuestionFormAnswers,
  parseQuestionFormQuestions,
  type QuestionFormQuestion,
  questionShowsTextInput,
  resolveDismissLabel,
  shouldSubmitEmptyOnDismiss,
} from "./paseo/question-form-card-core";
import { toToolCallDetail } from "./timelineItems";
import { stop, ToolDetailView } from "./TimelineItemView";
import { Glyph } from "./toolIcons";
import type { ControlsState } from "./useAgentControls";
import "./timelineItems.css";

export function PermissionCards({ state, paseoLink, compact = false }: { state: ControlsState; paseoLink?: PaseoLinkState; compact?: boolean }) {
  const c = state.controls;
  if (!c || state.unsupported || !c.can.permissions || !c.pendingPermissions.length) return null;
  return (
    <div data-testid="permission-cards" className={compact ? "tl-compact" : undefined} onPointerDown={stop} onWheel={stop} style={{ flexShrink: 0, display: "flex", flexDirection: "column", gap: 6, padding: compact ? "4px 6px" : "8px 10px 0", maxHeight: compact ? 160 : "45%", overflowY: "auto", background: "#fff" }}>
      {c.pendingPermissions.map((p) => (
        <PermissionCard key={p.id} request={p} state={state} paseoLink={paseoLink} compact={compact} />
      ))}
    </div>
  );
}

function PermissionCard({ request, state, paseoLink, compact }: { request: PermissionRequestView; state: ControlsState; paseoLink?: PaseoLinkState; compact: boolean }) {
  const [open, setOpen] = useState(!compact);
  const [sent, setSent] = useState<string | null>(null);
  const isPlan = request.kind === "plan";
  const isQuestion = request.kind === "question";
  const title = isPlan ? "Plan ready for review" : (request.title ?? request.toolName ?? "Permission required");
  const respond = async (actionId: string, body: PermissionResponseBody) => {
    setSent(actionId);
    const ok = await state.post(`permissions/${encodeURIComponent(request.id)}`, body, body.behavior === "allow" ? "Allowed" : "Denied");
    if (!ok) setSent(null);
  };
  const busy = sent !== null || !!state.busy;
  const planText = request.planText ?? (request.detail?.type === "plan" && typeof request.detail.text === "string" ? request.detail.text : undefined);
  const detail = isPlan ? undefined : toToolCallDetail(request.detail ?? (request.input !== undefined ? { type: "unknown", input: request.input, output: null } : undefined));
  const actions = request.actions?.length
    ? request.actions
    : [
        { id: "reject", label: "Deny", behavior: "deny" as const },
        { id: "accept", label: isPlan ? "Implement" : "Allow", behavior: "allow" as const },
      ];
  const questions = isQuestion ? parseQuestionFormQuestions(request.input) : null;
  const hasBody = !!request.description || !!planText || (!!detail && !isQuestion);

  return (
    <div data-testid="permission-card" data-kind={request.kind ?? "tool"} role="group" aria-label={title} style={{ border: "1px solid #fde4c4", background: "#fffbf5", borderRadius: 10, padding: compact ? "5px 7px" : "8px 10px", display: "flex", flexDirection: "column", gap: 6, fontSize: compact ? 11.5 : 12.5, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        <Glyph name={isPlan ? "brain" : isQuestion ? "info" : "alert"} color="#b45309" />
        <span style={{ fontWeight: 600, color: "#7c2d12", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }} title={title}>
          {title}
        </span>
        {hasBody ? (
          <button type="button" className="tl-link" onPointerDown={stop} onClick={() => setOpen((o) => !o)}>
            {open ? "Hide" : "Details"}
          </button>
        ) : null}
      </div>
      {open && request.description ? <div style={{ color: "#475569", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{request.description}</div> : null}
      {open && planText ? (
        <div className="tl-pre" style={{ fontFamily: "inherit", fontSize: compact ? 11.5 : 12.5, maxHeight: compact ? 140 : 260 }}>
          <MessageBody text={planText} compact={compact} />
        </div>
      ) : null}
      {open && detail && !isQuestion ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
          <ToolDetailView detail={detail} />
        </div>
      ) : null}
      {isQuestion ? (
        questions && !compact ? (
          <QuestionForm questions={questions} busy={busy} onSubmit={(answers) => void respond("submit", { behavior: "allow", updatedInput: { ...(request.input as object), answers } })} onDismiss={(label) => void respond("dismiss", shouldSubmitEmptyOnDismiss(questions) ? { behavior: "allow", updatedInput: { ...(request.input as object), answers: buildQuestionFormAnswers(questions, {}, {}) } } : { behavior: "deny", message: `${label} (dismissed by user)` })} dismissLabel={resolveDismissLabel(questions)} />
        ) : (
          <div style={{ color: "#475569" }}>
            <PaseoLink link={paseoLink ?? { url: null, hidden: false, reason: "No Paseo server id configured." }} testId="permission-answer-in-paseo" onPointerDown={stop} style={{ color: "#2f80ed" }}>Answer in Paseo</PaseoLink>
          </div>
        )
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "flex-end" }}>
          {actions.map((a) => (
            <button
              key={a.id}
              type="button"
              className="tl-btn"
              data-testid={`permission-${a.behavior}`}
              data-variant={a.behavior === "allow" ? "primary" : "danger"}
              disabled={busy}
              onPointerDown={stop}
              onClick={() => void respond(a.id, a.behavior === "allow" ? { behavior: "allow", selectedActionId: a.id } : { behavior: "deny", selectedActionId: a.id, message: "Denied by user" })}
            >
              {sent === a.id ? "Sending…" : a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function QuestionForm({ questions, busy, onSubmit, onDismiss, dismissLabel }: { questions: QuestionFormQuestion[]; busy: boolean; onSubmit: (answers: Record<string, string>) => void; onDismiss: (label: string) => void; dismissLabel: string }) {
  const [selections, setSelections] = useState<Record<number, Set<number>>>({});
  const [otherTexts, setOtherTexts] = useState<Record<number, string>>({});
  const ready = areQuestionsAnswered(questions, selections, otherTexts);
  const toggle = (q: number, o: number, multi: boolean) =>
    setSelections((prev) => {
      const next = new Set(multi ? prev[q] ?? [] : []);
      if (multi && next.has(o)) next.delete(o);
      else next.add(o);
      return { ...prev, [q]: next };
    });
  return (
    <form
      data-testid="permission-question-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !busy) onSubmit(buildQuestionFormAnswers(questions, selections, otherTexts));
      }}
      onKeyDown={stop}
      style={{ display: "flex", flexDirection: "column", gap: 8 }}
    >
      {questions.map((q, qi) => (
        <fieldset key={q.header} style={{ border: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
          <legend style={{ padding: 0, fontWeight: 600, color: "#334155" }}>{q.question}</legend>
          {q.options.map((opt, oi) => (
            <label key={opt.label} style={{ display: "flex", gap: 6, alignItems: "flex-start", cursor: "pointer" }}>
              <input type={q.multiSelect ? "checkbox" : "radio"} name={`q-${qi}`} checked={selections[qi]?.has(oi) ?? false} onChange={() => toggle(qi, oi, q.multiSelect)} disabled={busy} />
              <span>
                {opt.label}
                {opt.description ? <span style={{ color: "#64748b" }}> · {opt.description}</span> : null}
              </span>
            </label>
          ))}
          {questionShowsTextInput(q) ? (
            <input
              type="text"
              value={otherTexts[qi] ?? ""}
              placeholder={q.placeholder ?? (q.options.length ? "Other…" : "Your answer…")}
              disabled={busy}
              onChange={(e) => {
                const value = e.target.value;
                setOtherTexts((prev) => ({ ...prev, [qi]: value }));
                if (!q.multiSelect && value) setSelections((prev) => ({ ...prev, [qi]: new Set() }));
              }}
              style={{ font: "inherit", fontSize: 12, border: "1px solid #cbd5e1", borderRadius: 8, padding: "4px 8px" }}
            />
          ) : null}
        </fieldset>
      ))}
      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
        <button type="button" className="tl-btn" data-variant="danger" disabled={busy} onPointerDown={stop} onClick={() => onDismiss(dismissLabel)}>
          {dismissLabel}
        </button>
        <button type="submit" className="tl-btn" data-variant="primary" data-testid="permission-question-submit" disabled={busy || !ready} onPointerDown={stop}>
          Submit
        </button>
      </div>
    </form>
  );
}
