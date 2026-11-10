import { useSyncExternalStore } from 'react';
import { getUserPreferences, react, setUserPreferences } from 'tldraw';
import { legacyStorageKey } from '../../shared/bunny-storage';
import { readTheme, resolveTheme, THEME_KEY, writeTheme, type ThemePreference } from './themePreference';
import './theme.css';

const storage = () => { try { return window.localStorage; } catch { return undefined; } };
const media = window.matchMedia('(prefers-color-scheme: dark)');
let preference = readTheme(storage());
const listeners = new Set<() => void>();
function apply() {
  const resolved = resolveTheme(preference, media.matches);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  // tldraw owns shape palettes, menus and canvas, including portal editors. Its user
  // preference is shared by those editors, and never enters the synced document.
  setUserPreferences({ ...getUserPreferences(), colorScheme: preference });
  for (const listener of listeners) listener();
}
export function setTheme(next: ThemePreference) {
  preference = next;
  writeTheme(storage(), next);
  apply();
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const useTheme = () => useSyncExternalStore(subscribe, () => preference);
window.addEventListener('storage', (event) => {
  if (event.key === null || event.key === THEME_KEY || event.key === legacyStorageKey(THEME_KEY)) {
    preference = readTheme(storage());
    apply();
  }
});
media.addEventListener('change', () => { if (preference === 'system') apply(); });
// Before React mounts: avoids a light shell while the board is connecting.
apply();
// Keep tldraw's existing Theme menu and keyboard action connected to the same
// browser preference, so those controls cannot leave the shell in another theme.
const stopFollowingTldraw = react('bunny-theme-preference', () => {
  const value = getUserPreferences().colorScheme;
  if ((value === 'light' || value === 'dark' || value === 'system') && value !== preference) setTheme(value);
});
if (import.meta.hot) import.meta.hot.dispose(stopFollowingTldraw);

export function ThemePicker() {
  const theme = useTheme();
  return <fieldset className="bunny-theme-picker" data-testid="theme-picker">
    <legend>Appearance <small>this browser</small></legend>
    <div role="group" aria-label="Appearance">
      {(['light', 'dark', 'system'] as const).map((value) => <button type="button" key={value}
        data-testid={`theme-${value}`} aria-pressed={theme === value} onClick={() => setTheme(value)}>
        {value[0].toUpperCase() + value.slice(1)}
      </button>)}
    </div>
  </fieldset>;
}
