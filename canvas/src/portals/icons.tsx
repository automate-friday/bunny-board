// The portal icon, drawn in currentColor (the sticky's colour where it is used). Static:
// no animation. Used on the sticky's portal button, the open portal's chip and the
// toolbar's Portal tool.
//   oval (default): a classic game portal, a tilted elliptical ring with a soft glow inside.
//   window, arch: the two alternatives offered in the PR (a small window with an arrow
//     stepping through; an arch doorway with an arrow).
// localStorage "bunny-portal-icon" = "window" | "arch" previews an alternative.
import { useId } from "react";

export type PortalIconStyle = "oval" | "window" | "arch";

function chosen(): PortalIconStyle {
  try {
    const v = localStorage.getItem("bunny-portal-icon");
    return v === "window" || v === "arch" ? v : "oval";
  } catch {
    return "oval";
  }
}
export const PORTAL_ICON_STYLE: PortalIconStyle = chosen();

export function PortalIcon({ size = 18, style = PORTAL_ICON_STYLE }: { size?: number; style?: PortalIconStyle }) {
  const glow = `portal-glow-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;
  if (style === "window") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="bunny-portal-icon">
        <rect x="3" y="4" width="13" height="16" rx="2.5" fill="currentColor" fillOpacity="0.14" />
        <path d="M9 12h12M17.5 8.5L21 12l-3.5 3.5" />
      </svg>
    );
  }
  if (style === "arch") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="bunny-portal-icon">
        <path d="M4 21V11a6 6 0 0 1 12 0v10" fill="currentColor" fillOpacity="0.14" />
        <path d="M2.5 21h15M9 15h12M18 12l3 3-3 3" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="bunny-portal-icon">
      <defs>
        <radialGradient id={glow} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
          <stop offset="60%" stopColor="currentColor" stopOpacity="0.06" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </radialGradient>
      </defs>
      <g transform="rotate(-28 12 12)">
        <ellipse cx="12" cy="12" rx="5.8" ry="9.4" fill={`url(#${glow})`} />
        <ellipse cx="12" cy="12" rx="5.8" ry="9.4" fill="none" stroke="currentColor" strokeWidth="2.4" />
        <ellipse cx="12" cy="12" rx="3" ry="5.6" fill="none" stroke="currentColor" strokeWidth="0.9" strokeOpacity="0.4" />
      </g>
    </svg>
  );
}
