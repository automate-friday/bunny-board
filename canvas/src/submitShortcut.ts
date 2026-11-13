// ⌘↵ (macOS) / Ctrl+↵ (elsewhere) submits a form whose plain Enter is a new line, such as the
// Start conversation form. Either modifier works on every platform. A held key (repeat) never
// submits twice, and neither does Enter that confirms an IME candidate (isComposing in Chrome
// and Firefox; Safari reports it only as keyCode 229).
export type SubmitKey = { key: string; metaKey: boolean; ctrlKey: boolean; altKey?: boolean; shiftKey?: boolean; repeat?: boolean; isComposing?: boolean; keyCode?: number };

export function modEnterSubmits(e: SubmitKey): boolean {
  return e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && !e.repeat && !e.isComposing && e.keyCode !== 229;
}

export function isMacPlatform(nav: { platform?: string; userAgentData?: { platform?: string } } | undefined = typeof navigator === "undefined" ? undefined : (navigator as Navigator & { userAgentData?: { platform?: string } })): boolean {
  return /mac|iphone|ipad|ipod/i.test(nav?.userAgentData?.platform || nav?.platform || "");
}

// The hint shown next to a Start button.
const MAC = isMacPlatform();
export function modEnterHint(mac = MAC): string {
  return mac ? "⌘↵" : "Ctrl ↵";
}
