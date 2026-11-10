// Shared pieces for the image tools popup and the two upload cards: a progress bar, a
// status chip, and an action row (button plus a one-line hint saying what it does).
// They sit inside a `bunny-fp` root so buttons, details and focus rings use Bunny's
// shared control styles (BUNNY_CONTROLS_CSS) plus the few extras below.
import type { CSSProperties, ReactNode } from "react";
import { B, BUNNY_CONTROLS_CSS, UI_FONT, chip, primaryBtn } from "./bunnyTheme";

export const UPLOAD_UI_CSS = `${BUNNY_CONTROLS_CSS}
.bunny-fp input.bup-input { font: 13px ${UI_FONT}; color: ${B.espresso}; background: light-dark(#fff, var(--bunny-surface)); border: 1px solid ${B.line}; border-radius: 10px; padding: 7px 10px; width: 100%; box-sizing: border-box; }
.bunny-fp input.bup-input::placeholder { color: ${B.muted}; }
.bunny-fp input.bup-input:focus-visible { outline: 2px solid ${B.violet}; outline-offset: 1px; border-color: ${B.violet}; }
.bunny-fp input.bup-input:disabled { background: ${B.hover}; }
@keyframes bup-slide { from { transform: translateX(-100%); } to { transform: translateX(250%); } }
.bunny-fp .bup-indeterminate { animation: bup-slide 1.2s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .bunny-fp .bup-indeterminate { animation: none; } }
`;

export type Tone = "violet" | "green" | "golden" | "danger" | "muted";
const TONE: Record<Tone, { fg: string; bg: string; bar: string }> = {
  violet: { fg: B.violetDeep, bg: B.lavenderSoft, bar: B.violet },
  green: { fg: "light-dark(#23704A, hsl(150 52% 74%))", bg: "light-dark(#E3F4EA, var(--bunny-raised))", bar: "#3FA66A" },
  golden: { fg: "light-dark(#8A5A00, hsl(39 88% 74%))", bg: "light-dark(#FFF1CF, hsl(43 45% 21%))", bar: B.golden },
  danger: { fg: B.danger, bg: B.peachSoft, bar: B.orange },
  muted: { fg: B.muted, bg: B.hover, bar: "#B9AEA6" },
};

export const hintText: CSSProperties = { font: `12px/1.35 ${UI_FONT}`, color: B.muted, margin: 0 };
export const nameText: CSSProperties = { font: `600 13px/1.3 ${UI_FONT}`, color: B.espresso, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 };

export function StatusChip({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span data-tone={tone} style={{ ...chip, color: TONE[tone].fg, background: TONE[tone].bg, fontWeight: 600, flex: "none" }}>{children}</span>;
}

// value null = still working with no measurable progress (an animated sliver).
export function ProgressBar({ value, tone = "violet", label }: { value: number | null; tone?: Tone; label: string }) {
  const color = TONE[tone].bar;
  return <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value ?? undefined} style={{ position: "relative", height: 6, borderRadius: 999, background: B.hover, overflow: "hidden" }}>
    {value === null
      ? <div className="bup-indeterminate" style={{ position: "absolute", inset: 0, width: "40%", borderRadius: 999, background: color }} />
      : <div style={{ width: `${Math.max(3, Math.min(100, value))}%`, height: "100%", borderRadius: 999, background: color, transition: "width .2s ease-out" }} />}
  </div>;
}

// One action: a clearly named button and, beside it, a short line saying what it does.
// The hint is also the button's tooltip and its accessible description.
export function Action({ id, label, hint, primary, danger, disabled, onClick, testId }: { id: string; label: string; hint: string; primary?: boolean; danger?: boolean; disabled?: boolean; onClick: () => void; testId?: string }) {
  return <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", alignItems: "center", columnGap: 10 }}>
    <button type="button" data-testid={testId} className={primary ? "bfp-primary" : danger ? "bfp-danger" : undefined} style={primary ? { ...primaryBtn, fontSize: 12, padding: "5px 12px" } : undefined} disabled={disabled} onClick={onClick} title={hint} aria-describedby={`${id}-hint`}>{label}</button>
    <p id={`${id}-hint`} style={hintText}>{hint}</p>
  </div>;
}
