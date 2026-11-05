// Browser settings move lazily, so unopened boards keep their settings until visited.
export interface SettingsStorage {
  getItem(key: string): string | null;
  setItem?(key: string, value: string): void;
  removeItem?(key: string): void;
}

export const legacyStorageKey = (key: string): string => key.replace(/^bunny-/, 'paseo-board-');

export function readSetting(storage: SettingsStorage | undefined, key: string): string | null {
  if (!storage) return null;
  const oldKey = legacyStorageKey(key);
  let value: string | null;
  try {
    value = storage.getItem(key);
    if (value !== null) {
      // Clearing this setting later must not bring an old value back.
      if (oldKey !== key) { try { storage.removeItem?.(oldKey); } catch { /* still readable */ } }
      return value;
    }
    if (oldKey === key) return null;
    value = storage.getItem(oldKey);
  } catch { return null; }
  if (value !== null && storage.setItem) {
    try {
      storage.setItem(key, value);
      storage.removeItem?.(oldKey);
    } catch { /* Keep the old value if quota or private mode prevents migration. */ }
  }
  return value;
}
