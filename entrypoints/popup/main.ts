import { STORE, DEFAULT_REINJECT_INTERVAL } from '../../lib/constants';
import type { UserProfile } from '../../lib/profile';

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

/* ── Init ── */

async function init() {
  const data = await browser.storage.local.get([
    STORE.PROFILE,
    STORE.ENABLED,
    STORE.DEBUG,
    STORE.SHOW_INJECTION,
    STORE.REINJECT_INTERVAL,
  ]);

  const profile: UserProfile = data[STORE.PROFILE] ?? {
    bio: '',
    persona: '',
    style: '',
  };
  const enabled: boolean = data[STORE.ENABLED] ?? true;
  const debug: boolean = data[STORE.DEBUG] ?? false;
  const showInjection: boolean = data[STORE.SHOW_INJECTION] ?? false;
  const reinjectInterval: number = data[STORE.REINJECT_INTERVAL] ?? DEFAULT_REINJECT_INTERVAL;

  // Populate form
  $<HTMLTextAreaElement>('bio').value = profile.bio;
  $<HTMLTextAreaElement>('persona').value = profile.persona;
  $<HTMLTextAreaElement>('style').value = profile.style;
  $<HTMLInputElement>('reinjectInterval').value = String(reinjectInterval);
  $<HTMLInputElement>('enabled').checked = enabled;
  $<HTMLInputElement>('debug').checked = debug;
  $<HTMLInputElement>('showInjection').checked = showInjection;

  // Show/hide the "show injection" toggle based on debug state
  syncDebugUI(debug);

  // Debug checkbox toggles the show-injection visibility
  $<HTMLInputElement>('debug').addEventListener('change', () => {
    const isDebug = $<HTMLInputElement>('debug').checked;
    syncDebugUI(isDebug);
    if (!isDebug) {
      $<HTMLInputElement>('showInjection').checked = false;
    }
  });

  // Save handler
  $('save').addEventListener('click', save);
}

function syncDebugUI(debug: boolean) {
  $('show-injection-label').style.display = debug ? 'flex' : 'none';
}

/* ── Save ── */

async function save() {
  const profile: UserProfile = {
    bio: $<HTMLTextAreaElement>('bio').value.trim(),
    persona: $<HTMLTextAreaElement>('persona').value.trim(),
    style: $<HTMLTextAreaElement>('style').value.trim(),
  };

  await browser.storage.local.set({
    [STORE.PROFILE]: profile,
    [STORE.ENABLED]: $<HTMLInputElement>('enabled').checked,
    [STORE.DEBUG]: $<HTMLInputElement>('debug').checked,
    [STORE.SHOW_INJECTION]: $<HTMLInputElement>('showInjection').checked,
    [STORE.REINJECT_INTERVAL]: parseInt($<HTMLInputElement>('reinjectInterval').value, 10) || 0,
  });

  flash('✅ 已保存');
}

/* ── Toast ── */

function flash(text: string) {
  const el = $('status');
  el.textContent = text;
  el.classList.add('visible');
  setTimeout(() => el.classList.remove('visible'), 1500);
}

init();
