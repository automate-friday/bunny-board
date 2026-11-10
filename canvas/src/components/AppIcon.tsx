// Shared app icon family: 24-unit viewBox, 18 px by default, currentColor stroke 1.8, round joins.
// Use for app controls and widget manifests. Keep status/brand marks separate.

export type AppIconName = "widgets" | "smile" | "message" | "close" | "settings" | "chevron-right" | "chevron-down" | "lock" | "stamp" | "activity" | "app" | "external" | "refresh" | "fit" | "check" | "arrow-left" | "play" | "calendar" | "chevron-left" | "more" | "arrow-up" | "image" | "map" | "search";

const PATHS: Record<AppIconName, React.ReactNode> = {
  "chevron-left": <path d="M15 6l-6 6 6 6" />,
  more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  "arrow-up": <path d="M12 20V4M5 11l7-7 7 7" />,
  image: <><rect x="3.5" y="3.5" width="17" height="17" rx="2" /><circle cx="9" cy="9" r="2" /><path d="M4 17l5-5 4 4 3-3 4 4" /></>,
  map: <><path d="M3.5 6.5l5.5-2 6 2 5.5-2v13l-5.5 2-6-2-5.5 2z" /><path d="M9 4.5v13M15 6.5v13" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></>,
  widgets: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </>
  ),
  smile: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.6 14.2c.9 1.3 2 1.9 3.4 1.9s2.5-.6 3.4-1.9" />
      <path d="M9.2 9.6h.01M14.8 9.6h.01" strokeWidth="2.6" />
    </>
  ),
  message: <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H9l-5 4z" />,
  close: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  settings: (
    <>
      <path d="M4 7.5h9M19 7.5h1M4 16.5h3M13 16.5h7" />
      <circle cx="16" cy="7.5" r="2.5" />
      <circle cx="10" cy="16.5" r="2.5" />
    </>
  ),
  "chevron-right": <path d="M9.5 6l6 6-6 6" />,
  "chevron-down": <path d="M6 9.5l6 6 6-6" />,
  // A calendar page: binding rings, header rule, two marked days.
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="2" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
      <path d="M8 14h.01M12 14h.01M16 14h.01M8 17h.01" strokeWidth="2.4" />
    </>
  ),
  // A session and the tasks it runs: a root node branching to two.
  activity: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="12" r="2.5" />
      <circle cx="18" cy="19" r="2.5" />
      <path d="M6 8.5V16a3 3 0 0 0 3 3h6.5M6 12h9.5" />
    </>
  ),
  // A browser window: title bar with two dots.
  app: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M3.5 9h17" />
      <path d="M6.6 6.75h.01M9.1 6.75h.01" strokeWidth="2.2" />
    </>
  ),
  external: (
    <>
      <path d="M13.5 4.5h6v6M19.5 4.5l-8 8" />
      <path d="M17.5 13.5v4a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h4" />
    </>
  ),
  refresh: (
    <>
      <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
      <path d="M19.5 4.5v4h-4" />
    </>
  ),
  // Fit: four corners drawn inward.
  fit: <path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15M9 9h6v6H9z" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  "arrow-left": <path d="M19 12H5M11 6l-6 6 6 6" />,
  play: <path d="M8 5.5v13l10.5-6.5z" />,
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="2" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
    </>
  ),
  // A rubber stamp: knob, neck, base, and the line it prints.
  stamp: (
    <>
      <circle cx="12" cy="5.8" r="2.6" />
      <path d="M10.6 8.2L10 12.5M13.4 8.2l.6 4.3" />
      <rect x="4.5" y="12.5" width="15" height="4.2" rx="1.2" />
      <path d="M6 20.5h12" />
    </>
  ),
};

export function AppIcon({ name, size = 18, title }: { name: string; size?: number; title?: string }) {
  const paths = PATHS[name as AppIconName] ?? PATHS.widgets;
  return (
    <svg data-icon={name} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true} role={title ? "img" : undefined} style={{ flexShrink: 0, display: "block" }}>
      {title ? <title>{title}</title> : null}
      {paths}
    </svg>
  );
}
