// Bunny brand tokens (Bunny guide v0.2) and the small set of control styles the frame
// panel and its pickers share: cream surfaces, espresso text, soft violet for the one
// primary action, warm accents for state. No grey browser-default controls.
import type { CSSProperties } from "react";

export const B = {
  cream: "light-dark(#FFF8EB, var(--bunny-surface))",
  espresso: "light-dark(#2E1F16, var(--bunny-ink))",
  violet: "#8875F6",
  violetDeep: "#6F5CE6",
  lavender: "#C8B4F8",
  lavenderSoft: "light-dark(#EFE8FE, #393253)",
  golden: "#FFC65A",
  orange: "#FF682E",
  peach: "#FF9F7A",
  peachSoft: "light-dark(#FFE7DC, #4b3029)",
  line: "light-dark(rgba(46,31,22,.12), rgba(185,197,216,.22))",
  muted: "light-dark(rgba(46,31,22,.6), var(--bunny-muted))",
  hover: "light-dark(rgba(46,31,22,.06), rgba(185,197,216,.10))",
  danger: "light-dark(#C2410C, #ff9f7a)",
};

export const UI_FONT = "Inter, system-ui, -apple-system, sans-serif";

export const surface: CSSProperties = {
  background: B.cream,
  color: B.espresso,
  border: `1px solid ${B.line}`,
  borderRadius: 14,
  boxShadow: "0 10px 30px rgba(46,31,22,.14), 0 1px 2px rgba(46,31,22,.06)",
  font: `13px/1.35 ${UI_FONT}`,
};

const control: CSSProperties = { font: `500 13px ${UI_FONT}`, borderRadius: 999, cursor: "pointer", whiteSpace: "nowrap", lineHeight: "18px" };
export const primaryBtn: CSSProperties = { ...control, padding: "6px 14px", border: `1px solid ${B.violet}`, background: B.violet, color: "#fff", fontWeight: 600 };
export const softBtn: CSSProperties = { ...control, padding: "6px 12px", border: `1px solid ${B.line}`, background: "light-dark(#fff, var(--bunny-surface))", color: B.espresso };
export const iconBtn: CSSProperties = { ...control, width: 30, height: 30, padding: 0, border: "1px solid transparent", background: "transparent", color: B.espresso, display: "inline-grid", placeItems: "center", fontSize: 16, flex: "none" };
export const menuItem: CSSProperties = { ...control, display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", padding: "7px 10px", border: 0, borderRadius: 9, background: "transparent", color: B.espresso, fontWeight: 500 };
export const chip: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 999, font: `500 11px ${UI_FONT}`, lineHeight: "16px", whiteSpace: "nowrap", cursor: "default" };
export const fieldLabel: CSSProperties = { font: `600 11px ${UI_FONT}`, letterSpacing: ".02em", textTransform: "uppercase", color: B.muted };

// Status dot colours for a frame's conversation, in brand-friendly tones.
export const DOT: Record<string, string> = {
  idle: "#3FA66A",
  running: B.violet,
  subagents: B.violet,
  requested: B.lavender,
  starting: B.lavender,
  loading: "#E5DCD3",
  missing: "#B9AEA6",
  "needs-permission": B.orange,
  error: "#E2463B",
  archived: "#B9AEA6",
  paused: B.golden,
  // The frame's agent is paused while its cloud session works (drawn as a blue cloud, Dot.tsx).
  cloud: "#2F80ED",
  unbound: "#D9CFC6",
};

// Scoped defaults for native controls rendered inside Bunny surfaces (buttons and selects
// from shared pieces such as Frame tools, LGTM tagging and Re-link).
export const BUNNY_CONTROLS_CSS = `
.bunny-fp button { font: 500 12px ${UI_FONT}; color: ${B.espresso}; background: light-dark(#fff, var(--bunny-surface)); border: 1px solid ${B.line}; border-radius: 999px; padding: 5px 11px; cursor: pointer; }
.bunny-fp button:hover:not(:disabled) { background: ${B.lavenderSoft}; border-color: ${B.lavender}; }
.bunny-fp button:disabled { opacity: .5; cursor: default; }
.bunny-fp button:focus-visible, .bunny-fp select:focus-visible, .bunny-fp textarea:focus-visible, .bunny-fp summary:focus-visible { outline: 2px solid ${B.violet}; outline-offset: 2px; }
.bunny-fp button.bfp-primary:hover:not(:disabled) { background: ${B.violetDeep}; border-color: ${B.violetDeep}; }
/* Keyboard shortcut hint after a button's label (Start ⌘↵); generated content, so the label stays the button's text. */
.bunny-fp button[data-kbd]::after { content: attr(data-kbd); margin-left: 8px; font-size: 11px; font-weight: 500; opacity: .9; }
@media (hover: none), (pointer: coarse) { .bunny-fp button[data-kbd]::after { content: none; } }
.bunny-fp button.bfp-icon:hover:not(:disabled), .bunny-fp button.bfp-item:hover:not(:disabled) { background: ${B.hover}; border-color: transparent; }
.bunny-fp button.bfp-item.bfp-on { background: ${B.lavenderSoft}; }
.bunny-fp button.bfp-danger { color: ${B.danger}; }
.bunny-fp select { appearance: none; -webkit-appearance: none; font: 500 13px ${UI_FONT}; color: ${B.espresso}; background: light-dark(#fff, var(--bunny-surface)) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%232E1F16' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E") no-repeat right 10px center; border: 1px solid ${B.line}; border-radius: 10px; padding: 6px 28px 6px 10px; cursor: pointer; max-width: 100%; }
.bunny-fp textarea { font: 13px/1.4 ${UI_FONT}; color: ${B.espresso}; background: light-dark(#fff, var(--bunny-surface)); border: 1px solid ${B.line}; border-radius: 10px; padding: 8px 10px; resize: vertical; box-sizing: border-box; }
.bunny-fp textarea::placeholder { color: ${B.muted}; }
.bunny-fp input[type=checkbox] { accent-color: ${B.violet}; width: 15px; height: 15px; margin: 0; }
.bunny-fp details > summary { cursor: pointer; list-style: none; font: 500 13px ${UI_FONT}; padding: 7px 10px; border-radius: 9px; }
.bunny-fp details > summary::-webkit-details-marker { display: none; }
.bunny-fp details > summary::after { content: "›"; float: right; color: ${B.muted}; transition: transform .15s; }
.bunny-fp details[open] > summary::after { transform: rotate(90deg); }
.bunny-fp details > summary:hover { background: ${B.hover}; }
.bunny-fp details > div { padding: 4px 10px 6px !important; }
.bunny-fp .bfp-chips:empty { display: none !important; }
.bunny-fp .bfp-seg { display: inline-flex; flex-wrap: wrap; gap: 2px; padding: 2px; border: 1px solid ${B.line}; border-radius: 10px; background: ${B.hover}; }
.bunny-fp .bfp-seg > button { font: 500 13px ${UI_FONT}; color: ${B.muted}; background: transparent; border: 1px solid transparent; border-radius: 8px; padding: 4px 10px; white-space: nowrap; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.bunny-fp .bfp-seg > button:hover:not(:disabled) { color: ${B.espresso}; background: ${B.hover}; border-color: transparent; }
.bunny-fp .bfp-seg > button[aria-checked=true] { color: ${B.espresso}; font-weight: 600; background: light-dark(#fff, var(--bunny-raised)); border-color: ${B.line}; box-shadow: 0 1px 2px rgba(0,0,0,.12); }
.bunny-fp .bfp-seg > button[aria-checked=true]:hover { background: light-dark(#fff, var(--bunny-raised)); border-color: ${B.line}; }
.bunny-fp .bfp-seg > button:disabled { opacity: .45; text-decoration: line-through; }
.bunny-fp button.bfp-switch { display: inline-flex; align-items: center; gap: 8px; font: 500 13px ${UI_FONT}; color: ${B.espresso}; background: transparent; border: 0; padding: 4px 6px 4px 2px; }
.bunny-fp button.bfp-switch:hover:not(:disabled) { background: transparent; border-color: transparent; }
.bunny-fp .bfp-switch-track { position: relative; width: 30px; height: 18px; border-radius: 999px; background: light-dark(rgba(46,31,22,.22), #4b5466); transition: background .15s; flex: none; }
.bunny-fp .bfp-switch-thumb { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.3); transition: transform .15s; }
.bunny-fp .bfp-switch[aria-checked=true] .bfp-switch-track { background: ${B.violet}; }
.bunny-fp .bfp-switch[aria-checked=true] .bfp-switch-thumb { transform: translateX(12px); }
@media (prefers-reduced-motion: reduce) { .bunny-fp .bfp-switch-track, .bunny-fp .bfp-switch-thumb { transition: none; } }
.bunny-fp .bfp-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
@keyframes bfp-pop { from { opacity: 0; transform: translateY(-4px) scale(.98); } to { opacity: 1; transform: none; } }
.bunny-fp .bfp-pop { animation: bfp-pop .14s ease-out; }
@media (prefers-reduced-motion: reduce) { .bunny-fp .bfp-pop { animation: none; } }
`;
