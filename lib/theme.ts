import { STORE } from './constants';

/* ══════════════════════════════════════════
 *  Theme — dark / light / system
 * ══════════════════════════════════════════ */

export type ThemePref = 'system' | 'dark' | 'light';

const MEDIA = '(prefers-color-scheme: dark)';

/** Resolve the effective theme (dark | light) from preference */
export function resolveTheme(pref: ThemePref): 'dark' | 'light' {
  if (pref === 'system') {
    return window.matchMedia(MEDIA).matches ? 'dark' : 'light';
  }
  return pref;
}

/** Apply the resolved theme to the document */
export function applyTheme(pref: ThemePref): void {
  const theme = resolveTheme(pref);
  document.documentElement.setAttribute('data-theme', theme);
}

/** Load stored preference (defaults to 'system') */
export async function loadThemePref(): Promise<ThemePref> {
  const data = await browser.storage.local.get(STORE.THEME);
  const val = data[STORE.THEME];
  if (val === 'dark' || val === 'light' || val === 'system') return val;
  return 'system';
}

/** Persist preference */
export async function saveThemePref(pref: ThemePref): Promise<void> {
  await browser.storage.local.set({ [STORE.THEME]: pref });
}

/**
 * Init theme: load pref, apply, listen for system changes.
 * Returns the initial pref for UI binding.
 */
export async function initTheme(): Promise<ThemePref> {
  const pref = await loadThemePref();
  applyTheme(pref);

  // Listen for system theme changes (only matters when pref === 'system')
  window.matchMedia(MEDIA).addEventListener('change', async () => {
    const current = await loadThemePref();
    if (current === 'system') applyTheme('system');
  });

  return pref;
}
