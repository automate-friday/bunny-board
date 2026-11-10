import {Context, Effect, Layer} from 'effect';
import type { AttentionItem } from './attentionItems';

// Review reminders age out of the main queue after a week. They remain available under
// Older alerts; errors and requests for input never expire or become dismissible.
export const REVIEW_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
export function reviewIsOld(item: AttentionItem, now: number): boolean {
  return item.reason === 'Ready to review' && !!item.since && now - Date.parse(item.since) > REVIEW_MAX_AGE;
}
export const attentionKey = (item: AttentionItem): string => JSON.stringify([item.frameId, item.agentId, item.reason, item.since]);
export type AttentionPreferences = {collapsed: boolean; dismissed: string[]};
const empty = (): AttentionPreferences => ({collapsed:false,dismissed:[]});
function decode(raw: string | null): AttentionPreferences {
  try {
    const value = JSON.parse(raw ?? 'null');
    return {collapsed:value?.collapsed === true, dismissed:Array.isArray(value?.dismissed) ? value.dismissed.filter((v: unknown): v is string => typeof v === 'string').slice(-500) : []};
  } catch { return empty(); }
}
export class AttentionPreferencesStore extends Context.Tag('bunny/AttentionPreferencesStore')<AttentionPreferencesStore, {
  readonly read: (boardId: string) => Effect.Effect<AttentionPreferences>;
  readonly save: (boardId: string, value: AttentionPreferences) => Effect.Effect<void>;
}>() {}
// Browser storage is accessed only in this live layer; callers use the Tag.
export const AttentionPreferencesLive = (storage: () => Pick<Storage, 'getItem' | 'setItem'> = () => localStorage) => Layer.succeed(AttentionPreferencesStore, {
  read: (boardId: string) => Effect.sync(() => {
    try { return decode(storage().getItem(`bunny-attention:${boardId}`)); } catch { return empty(); }
  }),
  save: (boardId: string, value: AttentionPreferences) => Effect.sync(() => {
    try { storage().setItem(`bunny-attention:${boardId}`, JSON.stringify(value)); } catch { /* Session state still works. */ }
  }),
});
export function AttentionPreferencesMock() {
  const values = new Map<string, string>();
  return Layer.succeed(AttentionPreferencesStore, {
    read: (boardId: string) => Effect.sync(() => decode(values.get(boardId) ?? null)),
    save: (boardId: string, value: AttentionPreferences) => Effect.sync(() => { values.set(boardId, JSON.stringify(value)); }),
  });
}
export const readAttentionPreferences = (boardId: string) => Effect.flatMap(AttentionPreferencesStore, store => store.read(boardId));
export const saveAttentionPreferences = (boardId: string, value: AttentionPreferences) => Effect.flatMap(AttentionPreferencesStore, store => store.save(boardId, value));
