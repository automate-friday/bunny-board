import type { ToolCallIcon } from "./paseo/tool-call-icon-name";

// Small stroke icons for tool calls and timeline rows, drawn for the board (no icon
// package). 14 px, currentColor.
export type GlyphName = ToolCallIcon | "x" | "chevron" | "info" | "alert" | "scissors" | "list" | "image";

const PATHS: Record<GlyphName, React.ReactNode> = {
  wrench: <path d="M10.5 2.5a3 3 0 0 0-3.3 4L2.5 11.2l2.3 2.3 4.7-4.7a3 3 0 0 0 4-3.3l-1.8 1.8-1.7-.5-.5-1.7z" />,
  square_terminal: (
    <>
      <rect x="2" y="2.5" width="12" height="11" rx="2" />
      <path d="M5 6.5l2 1.5-2 1.5M8.5 10.5h2.5" />
    </>
  ),
  eye: (
    <>
      <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  pencil: <path d="M10.5 2.5l3 3-8 8H2.5v-3zM9 4l3 3" />,
  search: (
    <>
      <circle cx="7" cy="7" r="4.25" />
      <path d="M10.2 10.2l3.3 3.3" />
    </>
  ),
  bot: (
    <>
      <rect x="2.5" y="5" width="11" height="8.5" rx="2" />
      <path d="M8 2.5V5M6 9h.01M10 9h.01" />
    </>
  ),
  sparkles: <path d="M8 1.5l1.4 4.1 4.1 1.4-4.1 1.4L8 12.5 6.6 8.4 2.5 7l4.1-1.4zM13 11.5l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5z" />,
  brain: (
    <>
      <path d="M6 2.5a2 2 0 0 0-2 2 2 2 0 0 0-1.5 3.3A2.3 2.3 0 0 0 4.5 12a2 2 0 0 0 3.5 1V3.5a1.6 1.6 0 0 0-2-1z" />
      <path d="M10 2.5a2 2 0 0 1 2 2 2 2 0 0 1 1.5 3.3 2.3 2.3 0 0 1-2 4.2 2 2 0 0 1-3.5 1V3.5a1.6 1.6 0 0 1 2-1z" />
    </>
  ),
  mic_vocal: (
    <>
      <rect x="6" y="1.5" width="4" height="8" rx="2" />
      <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5" />
    </>
  ),
  paseo: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M6.5 11V5.5h2a1.6 1.6 0 0 1 0 3.2h-2" />
    </>
  ),
  x: <path d="M4 4l8 8M12 4l-8 8" />,
  chevron: <path d="M6 3.5L10.5 8 6 12.5" />,
  info: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7.5v3.5M8 5h.01" />
    </>
  ),
  alert: <path d="M8 2l6.5 11.5h-13zM8 6.5v3M8 11.5h.01" />,
  scissors: (
    <>
      <circle cx="4.5" cy="4.5" r="2" />
      <circle cx="4.5" cy="11.5" r="2" />
      <path d="M6.2 5.6L13.5 12M6.2 10.4L13.5 4" />
    </>
  ),
  list: <path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01" />,
  image: (
    <>
      <rect x="2" y="2.5" width="12" height="11" rx="2" />
      <circle cx="6" cy="6.5" r="1.2" />
      <path d="M14 10.5l-3.5-3.5L3 13.5" />
    </>
  ),
};

export function Glyph({ name, size = 14, color, style }: { name: GlyphName; size?: number; color?: string; style?: React.CSSProperties }) {
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke={color ?? "currentColor"}
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flex: "none", display: "block", ...style }}
    >
      {PATHS[name] ?? PATHS.wrench}
    </svg>
  );
}

export function Spinner({ size = 12, color = "#2f80ed" }: { size?: number; color?: string }) {
  return <span aria-hidden className="tl-spinner" style={{ width: size, height: size, borderColor: `${color}33`, borderTopColor: color }} />;
}
