import {
  loadConfig,
  saveConfig,
  genId,
  INJECTION_MODES,
  MAX_SLOTS,
  type GhostConfig,
  type InjectionMode,
} from '../../lib/profile';
import { decodePersona } from '../../lib/share';
import { SUPPORTED_HOSTS } from '../../lib/constants';
import { initTheme } from '../../lib/theme';

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

let config: GhostConfig;

/* ══════════════════════════════════════════
 *  Init
 * ══════════════════════════════════════════ */

async function init() {
  // Theme — apply before rendering to prevent flash
  await initTheme();

  const supported = await isSupportedSite();
  if (!supported) {
    $('unsupported').hidden = false;
    return;
  }

  config = await loadConfig();
  $('main').hidden = false;

  renderModeBar();
  renderSlotBar('identity');
  renderSlotBar('persona');

  // Open options page
  $('settings').addEventListener('click', () => browser.runtime.openOptionsPage());
  $('editIdentity').addEventListener('click', () => browser.runtime.openOptionsPage());
  $('editPersona').addEventListener('click', () => browser.runtime.openOptionsPage());
  $('importPersona').addEventListener('click', () => importPersonaFromClipboard());
}

/* ══════════════════════════════════════════
 *  Site support check
 * ══════════════════════════════════════════ */

async function isSupportedSite(): Promise<boolean> {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return false;
    return SUPPORTED_HOSTS.includes(new URL(tab.url).hostname);
  } catch {
    return false;
  }
}

/* ══════════════════════════════════════════
 *  Mode bar (dynamic, with depth glyphs)
 * ══════════════════════════════════════════ */

function renderModeBar() {
  const bar = $('modeBar');
  bar.innerHTML = '';

  INJECTION_MODES.forEach((m) => {
    const btn = document.createElement('button');
    btn.className = 'mode-btn' + (config.mode === m.value ? ' active' : '');
    btn.dataset.mode = m.value;
    btn.textContent = m.glyph;
    btn.title = m.label;
    btn.addEventListener('click', async () => {
      if (config.mode === m.value) return;
      config.mode = m.value;
      renderModeBar();
      await saveConfig(config);
    });
    bar.appendChild(btn);
  });

  // Update description
  const active = INJECTION_MODES.find((m) => m.value === config.mode);
  $('modeDesc').textContent = active ? active.brief : '';
}

/* ══════════════════════════════════════════
 *  Slot bar — select only, no editing
 * ══════════════════════════════════════════ */

function renderSlotBar(type: 'identity' | 'persona') {
  const bar = $(type === 'identity' ? 'identityBar' : 'personaBar');
  const items = type === 'identity' ? config.identities : config.personas;
  const activeIdx = type === 'identity' ? config.activeIdentity : config.activePersona;

  bar.innerHTML = '';

  items.forEach((item, i) => {
    const btn = document.createElement('button');
    btn.className = 'slot-btn' + (i === activeIdx ? ' active' : '');
    btn.textContent = (item as { name: string }).name || `#${i + 1}`;
    btn.addEventListener('click', async () => {
      if (type === 'identity') config.activeIdentity = i;
      else config.activePersona = i;
      renderSlotBar(type);
      await saveConfig(config);
    });
    bar.appendChild(btn);
  });
}

/* ══════════════════════════════════════════
 *  潜忆匙 — Import persona from clipboard
 * ══════════════════════════════════════════ */

async function importPersonaFromClipboard() {
  if (config.personas.length >= MAX_SLOTS) {
    flash('⚠️ 人设已满');
    return;
  }
  try {
    const text = await navigator.clipboard.readText();
    const persona = await decodePersona(text);
    if (!persona) {
      flash('⚠️ 无效的潜忆匙');
      return;
    }
    persona.id = genId();
    config.personas.push(persona);
    config.activePersona = config.personas.length - 1;
    renderSlotBar('persona');
    await saveConfig(config);
    flash(`🔑 已导入「${persona.name || '未命名'}」`);
  } catch {
    flash('⚠️ 无法读取剪贴板');
  }
}

/* ══════════════════════════════════════════
 *  Toast
 * ══════════════════════════════════════════ */

let toastTimer: ReturnType<typeof setTimeout> | null = null;

function flash(text: string) {
  const el = $('toast');
  $('toastText').textContent = text;
  el.hidden = false;
  void el.offsetHeight;
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => { el.hidden = true; }, 250);
  }, 1200);
}

init();
