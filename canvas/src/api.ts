export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json as T;
}

export const STATUS_LABEL: Record<string, string> = {
  requested: "starting…",
  idle: "idle",
  running: "working",
  "needs-permission": "needs permission",
  archived: "archived",
  error: "error",
};
