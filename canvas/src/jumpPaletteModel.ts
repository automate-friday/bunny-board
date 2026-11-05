import { readSetting, type SettingsStorage } from "../../shared/bunny-storage";
import type { Editor, TLShapeId } from 'tldraw';

export interface PaletteRecord {
  id: string;
  typeName: string;
  type?: string;
  parentId?: string;
  name?: string;
  props?: unknown;
  meta?: unknown;
}
export interface PaletteFrame {
  id: string;
  pageId: string;
  pageName: string;
  name: string;
  agentId: string;
  agentTitle: string;
  reportUrl?: string;
  status: string;
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const normalize = (value: string) => value.normalize('NFKC').toLowerCase();
const STATUS: Record<string, string> = { requested: 'starting', idle: 'idle', running: 'working', 'needs-permission': 'needs permission', archived: 'archived', error: 'error' };

function reportLink(raw: unknown, origin: string): string | undefined {
  if (typeof raw !== 'string') return;
  try {
    const url = new URL(raw, origin);
    if (!['http:', 'https:'].includes(url.protocol) ||
      !/\.(?:html?|pdf|md|txt)$/i.test(decodeURIComponent(url.pathname))) return;
    // Board artifacts may retain an old host/port in the synced snapshot.
    if (/^\/api\/assets\/(?:files|bundles)\/[a-f0-9]{32}\//i.test(url.pathname)) {
      return new URL(url.pathname + url.search + url.hash, origin).href;
    }
    return url.href;
  } catch { return; }
}

export function indexFrames(records: readonly PaletteRecord[], origin: string): PaletteFrame[] {
  const byId = new Map(records.map(record => [record.id, record]));
  const frames: PaletteFrame[] = [];
  const reports = new Map<string, string>();
  for (const record of records) {
    if (record.typeName !== 'shape' || record.type !== 'bookmark') continue;
    const url = reportLink(object(record.props).url, origin);
    if (!url) continue;
    let parent = byId.get(record.parentId ?? '');
    const seen = new Set<string>();
    while (parent?.typeName === 'shape' && !seen.has(parent.id)) {
      seen.add(parent.id);
      if (parent.type === 'frame') {
        if (!reports.has(parent.id)) reports.set(parent.id, url);
        break;
      }
      parent = byId.get(parent.parentId ?? '');
    }
  }
  for (const record of records) {
    if (record.typeName !== 'shape' || record.type !== 'frame') continue;
    let page = byId.get(record.parentId ?? '');
    const seen = new Set([record.id]);
    while (page?.typeName === 'shape' && !seen.has(page.id)) {
      seen.add(page.id);
      page = byId.get(page.parentId ?? '');
    }
    if (page?.typeName !== 'page') continue;
    const paseo = object(object(record.meta).paseo);
    const bound = Boolean(text(paseo.agentId));
    const state = text(paseo.status);
    frames.push({
      id: record.id, pageId: page.id, pageName: page.name || 'Untitled page',
      name: text(object(record.props).name) || 'Untitled frame',
      agentId: text(paseo.agentId),
      agentTitle: bound ? text(paseo.title) || text(paseo.agentTitle) : '',
      reportUrl: reports.get(record.id),
      status: bound ? Object.hasOwn(STATUS, state) ? STATUS[state] : 'unknown' : 'unbound',
    });
  }
  return frames;
}

// Order is by when the viewer last touched a frame (jumped to it, or sent its agent a
// message), not by agent activity. A query still puts better name matches first.
export function searchFrames(frames: readonly PaletteFrame[], query: string, touched: ReadonlyMap<string, number>): PaletteFrame[] {
  const q = normalize(query.trim());
  const terms = q.split(/\s+/).filter(Boolean);
  const rank = (frame: PaletteFrame) => {
    const name = normalize(frame.name);
    return !q || name === q ? 0 : name.startsWith(q) ? 1 : name.includes(q) ? 2 : 3;
  };
  return frames.filter(frame => {
    const haystack = normalize(`${frame.name} ${frame.agentTitle}`);
    return terms.every(term => haystack.includes(term));
  }).sort((a, b) => rank(a) - rank(b) ||
    (touched.get(b.id) ?? -1) - (touched.get(a.id) ?? -1) ||
    a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

interface StorageReader extends SettingsStorage {}
interface StorageWriter extends StorageReader { setItem(key: string, value: string): void }
export const recencyKey = (board: string, viewer: string) =>
  `bunny-jump:${encodeURIComponent(board)}:${encodeURIComponent(viewer)}`;
// Agent ids are unique across boards, so sends need no board scope.
export const AGENT_SENDS_KEY = 'bunny-agent-sends';
const LIMIT = 200;

// Stored newest first as [id, epochMs]. The older format (bare frame ids) reads as time 0:
// still ordered, shown as "earlier".
function readTimes(storage: StorageReader | undefined, key: string, valid: (id: string) => boolean): Map<string, number> {
  const times = new Map<string, number>();
  try {
    const value: unknown = JSON.parse(readSetting(storage, key) ?? '[]');
    if (!Array.isArray(value)) return times;
    value.forEach((entry: unknown, i) => {
      const [id, at] = typeof entry === 'string' ? [entry, -i] : Array.isArray(entry) ? entry : [];
      if (typeof id === 'string' && valid(id) && typeof at === 'number' && Number.isFinite(at) && !times.has(id)) times.set(id, Math.max(at, -LIMIT));
    });
  } catch { /* Corrupt or blocked storage reads as empty. */ }
  return new Map([...times].sort((a, b) => b[1] - a[1]).slice(0, LIMIT));
}
function touch(storage: StorageWriter | undefined, key: string, id: string, at: number, valid: (id: string) => boolean): Map<string, number> {
  const times = readTimes(storage, key, valid);
  times.delete(id);
  const next = new Map<string, number>([[id, at] as const, ...times].slice(0, LIMIT));
  try { storage?.setItem(key, JSON.stringify([...next])); } catch { /* Navigation still works without storage. */ }
  return next;
}
const isShape = (id: string) => id.startsWith('shape:');
const isAgent = (id: string) => id.length > 0;
export const readRecents = (storage: StorageReader | undefined, key: string) => readTimes(storage, key, isShape);
export const rememberFrame = (storage: StorageWriter | undefined, key: string, id: string, at = Date.now()) => touch(storage, key, id, at, isShape);
export const readAgentSends = (storage: StorageReader | undefined) => readTimes(storage, AGENT_SENDS_KEY, isAgent);
export const rememberAgentSend = (storage: StorageWriter | undefined, agentId: string, at = Date.now()) => touch(storage, AGENT_SENDS_KEY, agentId, at, isAgent);

// Last interaction per frame: the later of jumping to it and messaging its bound agent.
export function lastInteracted(frames: readonly PaletteFrame[], jumps: ReadonlyMap<string, number>, sends: ReadonlyMap<string, number>): Map<string, number> {
  const times = new Map<string, number>();
  for (const frame of frames) {
    const jumped = jumps.get(frame.id);
    const sent = frame.agentId ? sends.get(frame.agentId) : undefined;
    if (jumped !== undefined || sent !== undefined) times.set(frame.id, Math.max(jumped ?? -Infinity, sent ?? -Infinity));
  }
  return times;
}

export function timeAgo(at: number | undefined, now: number): string {
  if (at === undefined) return 'never';
  if (at <= 0) return 'earlier';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d}d ago` : new Date(at).toLocaleDateString();
}

export function jumpToFrame(editor: Editor, id: string): boolean {
  const frame = editor.getShape(id as TLShapeId);
  if (frame?.type !== 'frame') return false;
  const pageId = editor.getAncestorPageId(frame);
  if (!pageId) return false;
  editor.setCurrentPage(pageId);
  editor.select(frame.id);
  editor.zoomToSelection({ animation: { duration: editor.options.animationMediumMs } });
  return true;
}
