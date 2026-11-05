// A frame conversation's status dot (frame panel, pinned pills), with its words for screen readers.
// "cloud" (the frame's own agent is paused while a cloud session it dispatched works) is drawn
// as a blue cloud instead of a dot, so a frame waiting on its cloud builder never looks idle.
import { B, DOT } from "./bunnyTheme";

export const CLOUD_BLUE = "#2F80ED";

const CLOUD_CSS = "@keyframes bunnyCloudPulse{0%,100%{opacity:1}50%{opacity:.7}}.bunny-cloud-mark{animation:bunnyCloudPulse 1.8s ease-in-out infinite}@media (prefers-reduced-motion: reduce){.bunny-cloud-mark{animation:none}}";

// The blue cloud on its own (aria-hidden): for headers that draw their own dot.
export const CloudMark = ({ size = 16 }: { size?: number }) => (
  <svg aria-hidden data-status-mark="cloud" className="bunny-cloud-mark" width={size} height={Math.round(size * 0.76)} viewBox="2 4 20 15.2" style={{ flex: "none", display: "block", overflow: "visible" }}>
    <style>{CLOUD_CSS}</style>
    <path d="M7 18.5h10.2a4 4 0 0 0 .6-7.95A5.6 5.6 0 0 0 7 9.6a4.45 4.45 0 0 0 0 8.9Z" fill={CLOUD_BLUE} stroke={B.cream} strokeWidth={1.4} strokeLinejoin="round" />
  </svg>
);

// A status dot, or the cloud mark for "cloud", for headers outside the frame panel (sidebar,
// transcript card) that use the STATUS_DOT palette.
export const StatusMark = ({ status, color, size = 9, title }: { status: string; color: string; size?: number; title?: string }) =>
  status === "cloud" ? (
    <span title={title} style={{ display: "inline-flex", alignItems: "center", flex: "none" }}>
      <CloudMark size={size + 7} />
    </span>
  ) : (
    <span aria-hidden title={title} style={{ width: size, height: size, borderRadius: "50%", flex: "none", background: color }} />
  );

export const Dot = ({ status, text, testId }: { status: string; text: string; testId?: string }) => (
  <span data-testid={testId} data-status={status} title={text} style={{ display: "inline-flex", alignItems: "center", flex: "none" }}>
    {status === "cloud" ? <CloudMark /> : <span aria-hidden style={{ width: 9, height: 9, borderRadius: 5, background: DOT[status] ?? DOT.unbound, boxShadow: `0 0 0 2px ${B.cream}, 0 0 0 3px ${B.line}` }} />}
    <span className="bfp-sr">{text}</span>
  </span>
);
