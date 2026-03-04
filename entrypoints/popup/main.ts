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
const RELEASE_API = 'https://api.github.com/repos/MidnightV1/qianyi/releases/latest';
const UPDATE_CACHE_KEY = 'qianyi_update_cache_v1';
const UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
let updateUrl = '';

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
  $('checkUpdate').addEventListener('click', () => checkForUpdate(true));
  $('downloadUpdate').addEventListener('click', async () => {
    if (!updateUrl) return;
    await browser.tabs.create({ url: updateUrl });
  });
  $('editIdentity').addEventListener('click', () => browser.runtime.openOptionsPage());
  $('editPersona').addEventListener('click', () => browser.runtime.openOptionsPage());
  $('importPersona').addEventListener('click', () => importPersonaFromClipboard());

  void checkForUpdate(false);
}

type UpdateCache = {
  checkedAt: number;
  latestVersion: string;
  downloadUrl: string;
};

function normalizeVersion(v: string): number[] {
  return v.replace(/^v/i, '').split('.').map(part => Number.parseInt(part, 10) || 0);
}

function isNewerVersion(latest: string, current: string): boolean {
  const left = normalizeVersion(latest);
  const right = normalizeVersion(current);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i++) {
    const a = left[i] ?? 0;
    const b = right[i] ?? 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return false;
}

function showUpdate(version: string, url: string) {
  updateUrl = url;
  $('updateText').textContent = `发现新版本 v${version}`;
  $('updateBar').hidden = false;
}

function hideUpdate() {
  updateUrl = '';
  $('updateBar').hidden = true;
}

async function fetchLatestRelease(): Promise<UpdateCache | null> {
  const resp = await fetch(RELEASE_API, { cache: 'no-store' });
  if (!resp.ok) return null;
  const data = await resp.json() as { tag_name?: string; html_url?: string };
  if (!data.tag_name) return null;
  return {
    checkedAt: Date.now(),
    latestVersion: data.tag_name,
    downloadUrl: data.html_url || 'https://github.com/MidnightV1/qianyi/releases/latest',
  };
}

async function checkForUpdate(force: boolean) {
  const currentVersion = browser.runtime.getManifest().version;
  try {
    const store = await browser.storage.local.get(UPDATE_CACHE_KEY);
    const cached = store[UPDATE_CACHE_KEY] as UpdateCache | undefined;
    let latest = cached;

    const stale = !cached || (Date.now() - cached.checkedAt > UPDATE_CHECK_INTERVAL_MS);
    if (force || stale) {
      const fetched = await fetchLatestRelease();
      if (fetched) {
        latest = fetched;
        await browser.storage.local.set({ [UPDATE_CACHE_KEY]: fetched });
      }
    }

    if (!latest) {
      if (force) flash('⚠️ 检查更新失败');
      return;
    }

    if (isNewerVersion(latest.latestVersion, currentVersion)) {
      showUpdate(latest.latestVersion, latest.downloadUrl);
      if (force) flash(`发现新版本 v${latest.latestVersion}`);
    } else {
      hideUpdate();
      if (force) flash('✅ 已是最新版本');
    }
  } catch {
    if (force) flash('⚠️ 检查更新失败');
  }
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
