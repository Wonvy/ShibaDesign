import { useSyncExternalStore } from 'react';
import { THEMES, type ThemeDef } from './themes';

/** 用户的选择：'system' 表示跟随系统，否则是某个主题的 id */
export type ThemePreference = 'system' | string;

const STORAGE_KEY = 'shiba.theme';
const listeners = new Set<() => void>();
const darkQuery = typeof matchMedia === 'undefined' ? null : matchMedia('(prefers-color-scheme: dark)');

let preference: ThemePreference = readPreference();
let state = { preference, theme: resolve(preference) };

function readPreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'system' || THEMES.some((t) => t.id === saved)) return saved as ThemePreference;
  } catch {
    // 读不到存储时用默认值
  }
  return 'system';
}

function resolve(pref: ThemePreference): ThemeDef {
  const id = pref === 'system' ? (darkQuery?.matches ? 'dark' : 'light') : pref;
  return THEMES.find((t) => t.id === id) ?? THEMES[0]!;
}

function apply(): void {
  const theme = resolve(preference);
  state = { preference, theme };
  const root = document.documentElement;
  for (const [name, value] of Object.entries(theme.vars)) root.style.setProperty(name, value);
  root.dataset.theme = theme.id;
  root.style.colorScheme = theme.scheme;
  for (const listener of [...listeners]) listener();
}

/** 启动时调用一次：应用主题，并在系统主题变化时自动跟随 */
export function initTheme(): void {
  apply();
  darkQuery?.addEventListener('change', () => {
    if (preference === 'system') apply();
  });
}

export function setThemePreference(next: ThemePreference): void {
  preference = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // 存不进去时只是不会被记住
  }
  apply();
}

export function currentTheme(): ThemeDef {
  return state.theme;
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React 里读取当前主题和用户的选择 */
export function useTheme(): { preference: ThemePreference; theme: ThemeDef } {
  return useSyncExternalStore(subscribeTheme, () => state);
}

export { THEMES } from './themes';
export type { ThemeDef } from './themes';
