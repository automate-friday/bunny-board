// The model and reasoning effort the last agent was started with from this device, shared
// by the desktop start form (FramePanel.tsx) and the phone's start sheet; both preselect it
// next time (shared/start-catalogue.ts rememberedChoice).
const KEY = "bunny:last-start-model";
const OLD_KEY = "bunny:last-provider"; // phone sheet, provider only

export type StartChoice = { provider: string | null; effort: string | null };

export function lastStartChoice(): StartChoice | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (v && typeof v.provider === "string") return { provider: v.provider, effort: typeof v.effort === "string" ? v.effort : null };
    const old = localStorage.getItem(OLD_KEY);
    return old ? { provider: old, effort: null } : null;
  } catch {
    return null;
  }
}

export function rememberStartChoice(choice: StartChoice) {
  if (!choice.provider) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ provider: choice.provider, effort: choice.effort ?? null }));
    localStorage.setItem(OLD_KEY, choice.provider);
  } catch { /* storage blocked */ }
}

// Model ids typed into the picker ("Custom model ID…"), newest first, as `harness/model`.
const CUSTOM = "bunny:custom-models";
export function customModels(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(CUSTOM) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.includes("/")).slice(0, 12) : [];
  } catch {
    return [];
  }
}
export function addCustomModel(value: string): string[] {
  const next = [value, ...customModels().filter((v) => v !== value)].slice(0, 12);
  try { localStorage.setItem(CUSTOM, JSON.stringify(next)); } catch { /* storage blocked */ }
  return next;
}
// A typed model id, cleaned ("claude-fable-5-2"; spaces and slashes at the ends dropped), or
// null when it cannot be one.
export function cleanModelId(raw: string): string | null {
  const id = raw.trim().replace(/^\/+|\/+$/g, "");
  return /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,119}$/.test(id) ? id : null;
}

// The page the phone last started an agent on (its start sheet's page dropdown), offered as
// "last used" and used when a start from the tiles has no page in view.
const PAGE = "bunny:last-start-page";
export function lastStartPage(board: string): string | null {
  try {
    const v = JSON.parse(localStorage.getItem(PAGE) ?? "{}");
    return typeof v?.[board] === "string" ? v[board] : null;
  } catch {
    return null;
  }
}
export function rememberStartPage(board: string, page: string) {
  try {
    const v = JSON.parse(localStorage.getItem(PAGE) ?? "{}");
    localStorage.setItem(PAGE, JSON.stringify({ ...(v && typeof v === "object" ? v : {}), [board]: page }));
  } catch { /* storage blocked */ }
}
