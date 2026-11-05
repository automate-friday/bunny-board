// The board's own emoji set: small line drawings that replace the system emoji glyphs
// (🔒 🔓 ⏸ ✓ ⚙ ↗ ? 🕘 🗄 🧹 ☁) so the UI looks the same on every OS. They inherit the text colour
// and size (1em), so they sit inline in buttons, badges and transcript rows.
import type { CSSProperties, ReactNode } from "react";

export type EmojiName = "lock" | "unlock" | "pause" | "check" | "gear" | "open" | "unknown" | "history" | "archive" | "broom" | "cloud";

const PATHS: Record<EmojiName, ReactNode> = {
  lock: (
    <>
      <rect x="4" y="10.5" width="16" height="11" rx="3" fill="currentColor" fillOpacity="0.18" />
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
      <circle cx="12" cy="16" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  unlock: (
    <>
      <rect x="4" y="10.5" width="16" height="11" rx="3" />
      <path d="M8 10.5V8a4 4 0 0 1 7.6-1.8" />
      <circle cx="12" cy="16" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  pause: (
    <>
      <rect x="6" y="5" width="4" height="14" rx="1.6" fill="currentColor" stroke="none" />
      <rect x="14" y="5" width="4" height="14" rx="1.6" fill="currentColor" stroke="none" />
    </>
  ),
  cloud: <path d="M7 18.5h10.2a4 4 0 0 0 .6-7.95A5.6 5.6 0 0 0 7 9.6a4.45 4.45 0 0 0 0 8.9Z" fill="currentColor" fillOpacity="0.18" />,
  check: <path d="M4.5 12.5l4.8 4.8L19.5 7" strokeWidth="2.6" />,
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6M5.5 5.5l1.9 1.9M16.6 16.6l1.9 1.9M5.5 18.5l1.9-1.9M16.6 7.4l1.9-1.9" />
      <circle cx="12" cy="12" r="6.4" />
    </>
  ),
  open: (
    <>
      <path d="M9 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3" />
      <path d="M13 4h7v7M20 4l-9 9" />
    </>
  ),
  history: (
    <>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.5-6" />
      <path d="M3 3.5v4h4" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  archive: (
    <>
      <rect x="3" y="4" width="18" height="5" rx="1.5" fill="currentColor" fillOpacity="0.18" />
      <path d="M5 9v9.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V9" />
      <path d="M10 13h4" />
    </>
  ),
  broom: (
    <>
      <path d="M19.5 3.5l-7 7" />
      <path d="M12.5 10.5l1.5 1.5c.8.8.8 2 0 2.8L12 16.8 7.2 12l2-2c.8-.8 2-.8 2.8 0z" fill="currentColor" fillOpacity="0.18" />
      <path d="M7.2 12L4 15.2c1.2 2.6 2.4 3.8 4.8 4.8L12 16.8" />
      <path d="M6 17.5l1.6-1.6M8.6 19l1.4-1.4" />
    </>
  ),
  unknown: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.4 9.4a2.7 2.7 0 1 1 3.6 2.5c-.6.3-1 .8-1 1.5v.6" />
      <circle cx="12" cy="17" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
};

export function Emoji({ name, style }: { name: EmojiName; style?: CSSProperties }) {
  return (
    <svg
      data-emoji={name}
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "inline-block", verticalAlign: "-0.15em", flexShrink: 0, ...style }}
    >
      {PATHS[name]}
    </svg>
  );
}
