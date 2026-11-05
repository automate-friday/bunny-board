// Line icons for stamps and their response state, drawn like the widget icons
// (canvas/src/components/widget/icons.tsx): 24-unit viewBox, currentColor stroke, round
// joins. Stamps never use emoji.

const PATHS: Record<string, React.ReactNode> = {
  // kinds (shared/components/stamp.ts STAMP_KIND_INFO[kind].icon)
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  pencil: (
    <>
      <path d="M4.5 19.5l1-4.2L15.8 5a2 2 0 0 1 2.8 0l.4.4a2 2 0 0 1 0 2.8L8.7 18.5z" />
      <path d="M13.5 7.3l3.2 3.2" />
    </>
  ),
  question: (
    <>
      <path d="M9.2 9.2a2.9 2.9 0 1 1 4.1 2.6c-.8.4-1.3 1-1.3 1.9v.6" />
      <path d="M12 17.6h.01" strokeWidth="2.6" />
    </>
  ),
  flag: (
    <>
      <path d="M6 20.5V4" />
      <path d="M6 4.5h10.5l-2.3 3.7 2.3 3.8H6" />
    </>
  ),
  stop: (
    <>
      <path d="M8.6 3.8h6.8l4.8 4.8v6.8l-4.8 4.8H8.6l-4.8-4.8V8.6z" />
      <path d="M9 9l6 6M15 9l-6 6" />
    </>
  ),
  heart: <path d="M12 19.5s-7.5-4.4-7.5-9.6A4.1 4.1 0 0 1 12 7.6a4.1 4.1 0 0 1 7.5 2.3c0 5.2-7.5 9.6-7.5 9.6z" />,
  // states
  send: (
    <>
      <path d="M4.5 12h13" />
      <path d="M13 6.5l5.5 5.5-5.5 5.5" />
    </>
  ),
  eye: (
    <>
      <path d="M2.8 12s3.3-6 9.2-6 9.2 6 9.2 6-3.3 6-9.2 6-9.2-6-9.2-6z" />
      <circle cx="12" cy="12" r="2.6" />
    </>
  ),
  bolt: <path d="M13 3.5L6 13.5h5.5l-1 7 7-10H12z" />,
  done: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8 12.3l2.8 2.8L16.2 9.6" />
    </>
  ),
  alert: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5v5.5" />
      <path d="M12 16.5h.01" strokeWidth="2.6" />
    </>
  ),
};

export function StampIcon({ name, size = 16, strokeWidth = 2, title }: { name: string; size?: number; strokeWidth?: number; title?: string }) {
  return (
    <svg data-icon={name} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true} role={title ? "img" : undefined} style={{ flexShrink: 0, display: "block" }}>
      {title ? <title>{title}</title> : null}
      {PATHS[name] ?? PATHS.check}
    </svg>
  );
}

export const STATE_ICON: Record<string, { icon: string; color: string }> = {
  sent: { icon: "send", color: "#8a929c" },
  seen: { icon: "eye", color: "#2f6fe0" },
  acting: { icon: "bolt", color: "#d98a00" },
  done: { icon: "done", color: "#1f9d55" },
  failed: { icon: "alert", color: "#d93025" },
};
