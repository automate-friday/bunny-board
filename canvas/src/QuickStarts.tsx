// Starter prompt cards under an opening message (quickStartPrompts.ts): a labelled group of
// equal cards, each an icon, a title and one line of detail, with "Show others" to rotate
// them. A click fills the message; it never sends. `layout="row"` is the phone's single
// swipeable row; the default is a two-column grid.
import { type CSSProperties, type ReactNode, useMemo, useState } from "react";
import { B, UI_FONT } from "./bunnyTheme";
import { promptHistory, suggestStarters, type Starter, type StarterKind } from "./quickStartPrompts";

const TINT: Record<StarterKind, { bg: string; fg: string }> = {
  plan: { bg: "light-dark(#FEF3C7, #4a3f1d)", fg: "light-dark(#A16207, #fcd34d)" },
  build: { bg: "light-dark(#DCFCE7, #1f3f2b)", fg: "light-dark(#15803D, #86efac)" },
  research: { bg: "light-dark(#DBEAFE, #1e3150)", fg: "light-dark(#1D4ED8, #93c5fd)" },
  review: { bg: "light-dark(#FFE4E6, #4a2329)", fg: "light-dark(#BE123C, #fda4af)" },
  write: { bg: B.peachSoft, fg: "light-dark(#C2410C, #fdba74)" },
  design: { bg: B.lavenderSoft, fg: B.violetDeep },
};

// Line icons in the board's emoji style (Emoji.tsx): 24-unit grid, currentColor strokes.
const ICON: Record<StarterKind, ReactNode> = {
  plan: <><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M8 9h8M8 13h8M8 17h5" /></>,
  build: <path d="M14.5 5.5a4 4 0 0 0-5 5L4 16l4 4 5.5-5.5a4 4 0 0 0 5-5l-2.5 2.5-2.5-.5-.5-2.5z" />,
  research: <><circle cx="10.5" cy="10.5" r="5.5" /><path d="M15 15l5 5" /></>,
  review: <><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" /><path d="M9 12l2 2 4-4" /></>,
  write: <><path d="M5 19l1-4L16 5l3 3L9 18z" /><path d="M14 7l3 3" /></>,
  design: <><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="16" height="7" rx="1.5" /></>,
};
const RECENT_ICON = <><path d="M4 12a8 8 0 1 0 2.3-5.7" /><path d="M4 4v4h4" /><path d="M12 8v4l3 2" /></>;
const SPARK = <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />;

function Icon({ children, size = 14 }: { children: ReactNode; size?: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

const CSS = `
.bqs button.bqs-card{min-width:0;display:flex;gap:10px;align-items:center;text-align:left;border:1px solid ${B.line};background:light-dark(#fff,var(--bunny-surface));border-radius:12px;padding:9px 11px;box-sizing:border-box;cursor:pointer;color:${B.espresso};font:inherit;transition:border-color .12s,background .12s,box-shadow .12s}
.bqs button.bqs-card:hover:not(:disabled){border-color:${B.lavender};background:light-dark(#FBF9FF,var(--bunny-surface));box-shadow:0 1px 3px rgba(46,31,22,.06)}
.bqs button.bqs-card:focus-visible{outline:2px solid ${B.violet};outline-offset:1px}
.bqs button.bqs-more{border:0;background:none;padding:2px 4px;border-radius:6px;cursor:pointer;color:${B.violetDeep};font:500 12px ${UI_FONT};display:inline-flex;align-items:center;gap:4px}
.bqs button.bqs-more:hover:not(:disabled){background:${B.lavenderSoft}}
.bqs-row{scrollbar-width:none}.bqs-row::-webkit-scrollbar{display:none}
`;
const ellipsis: CSSProperties = { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };

export function QuickStarts({ onPick, layout = "grid", heading }: { onPick: (s: Starter) => void; layout?: "grid" | "row"; heading?: string }) {
  const history = useMemo(() => promptHistory(), []);
  const [page, setPage] = useState(0);
  const list = useMemo(() => suggestStarters(history, 4, page), [history, page]);
  const title = heading ?? (history.length ? "For you" : "Suggested");
  const row = layout === "row";
  return (
    <section className="bqs" data-testid="quick-starts" aria-label="Suggested prompts" style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0, font: `13px/1.35 ${UI_FONT}` }}>
      <style>{CSS}</style>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5, font: `600 11px ${UI_FONT}`, letterSpacing: ".04em", textTransform: "uppercase", color: B.muted }}>
          <Icon size={12}>{SPARK}</Icon>
          {title}
        </span>
        <button type="button" className="bqs-more" data-testid="quick-starts-more" onClick={() => setPage((p) => p + 1)} aria-label="Show other suggestions">
          <Icon size={12}><path d="M20 12a8 8 0 1 1-2.3-5.7" /><path d="M20 4v4h-4" /></Icon>
          {row ? null : "Show others"}
        </button>
      </div>
      <div className={row ? "bqs-row" : undefined} style={row ? { display: "flex", gap: 8, overflowX: "auto", margin: "0 -2px", padding: "0 2px 2px" } : { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
        {list.map((s) => {
          const tint = s.badge === "recent" ? { bg: B.lavenderSoft, fg: B.violetDeep } : TINT[s.kind];
          return (
            <button key={s.prompt} type="button" className="bqs-card" data-testid="quick-start" data-kind={s.kind} data-badge={s.badge} title={s.prompt} onClick={() => onPick(s)} style={row ? { flex: "0 0 248px" } : undefined}>
              <span style={{ width: 26, height: 26, borderRadius: 8, flex: "none", display: "grid", placeItems: "center", background: tint.bg, color: tint.fg }}>
                <Icon>{s.badge === "recent" ? RECENT_ICON : ICON[s.kind]}</Icon>
              </span>
              <span style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
                <span style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0 }}>
                  <b style={{ ...ellipsis, fontWeight: 600 }}>{s.title}</b>
                  {s.badge === "recent" ? <span style={{ flex: "none", font: `600 10px ${UI_FONT}`, color: B.violetDeep, background: B.lavenderSoft, borderRadius: 5, padding: "0 5px", lineHeight: "15px" }}>Recent</span> : null}
                </span>
                <span style={{ ...ellipsis, fontSize: 12, color: B.muted }}>{s.detail}</span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
