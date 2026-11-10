import { readSetting } from '../../shared/bunny-storage';

export type ThemePreference = 'light' | 'dark' | 'system';
export const THEME_KEY = 'bunny-theme';
type Store = Pick<Storage, 'getItem' | 'setItem'>;
export function readTheme(storage: Store | undefined): ThemePreference {
  try {
    const value = readSetting(storage, THEME_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch { return 'system'; }
}
export function writeTheme(storage: Store | undefined, value: ThemePreference): void {
  try { storage?.setItem(THEME_KEY, value); } catch { /* Choice still works until reload. */ }
}
export function resolveTheme(preference: ThemePreference, osDark: boolean): 'light' | 'dark' {
  return preference === 'system' ? osDark ? 'dark' : 'light' : preference;
}
