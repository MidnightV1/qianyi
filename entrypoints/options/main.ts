import {
  loadConfig,
  saveConfig,
  genId,
  DEFAULT_IDENTITY,
  DEFAULT_PERSONA,
  MAX_SLOTS,
  INJECTION_MODES,
  type GhostConfig,
  type UserIdentity,
  type AIPersona,
  type InjectionMode,
} from '../../lib/profile';
import { encodePersona, decodePersona } from '../../lib/share';
import { generateQR, decodeQR, QR_MAX_BYTES } from '../../lib/qr';
import {
  loadGrowthLog, appendGrowth, getSlotHistory, lineDiff, formatTs,
  clearSlotGrowth,
  type GrowthField, type GrowthEntry,
} from '../../lib/growth';
import {
  initTheme, applyTheme, saveThemePref,
  type ThemePref,
} from '../../lib/theme';
import { STORE } from '../../lib/constants';

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

let config: GhostConfig;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

/* ── Growth log state ── */
let growthLog: GrowthEntry[] = [];
let growthField: GrowthField = 'bio';
let growthSlotId: string | null = null;
let growthShowAll = false;
const GROWTH_PREVIEW_COUNT = 5;

/** Snapshot of field values at load time — for detecting user edits */
const bioSnapshots = new Map<string, string>();
const soulSnapshots = new Map<string, string>();

/* ── Char counter helper ── */
const CHAR_WARN = 800;
const CHAR_OVER = 1500;

/** Wrap a textarea with a character counter */
function withCharCount(textarea: HTMLTextAreaElement): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'slot-field-wrap';
  const counter = document.createElement('span');
  counter.className = 'char-count';
  const update = () => {
    const len = textarea.value.length;
    counter.textContent = `${len}`;
    counter.classList.toggle('warn', len >= CHAR_WARN && len < CHAR_OVER);
    counter.classList.toggle('over', len >= CHAR_OVER);
  };
  textarea.addEventListener('input', update);
  update();
  wrap.appendChild(textarea);
  wrap.appendChild(counter);
  return wrap;
}

/* ══════════════════════════════════════════
 *  Init
 * ══════════════════════════════════════════ */

async function init() {
  // Theme — apply before rendering to prevent flash
  const themePref = await initTheme();
  initThemeToggle(themePref);

  config = await loadConfig();
  growthLog = await loadGrowthLog();

  // Take snapshots of current field values (for detecting user edits)
  snapshotAll();

  // Version
  const manifest = browser.runtime.getManifest();
  $('version').textContent = `v${manifest.version}`;

  // Render slot lists
  renderIdentityList();
  renderPersonaList();
  renderDepthBar();
  syncAddButtons();

  // Growth log
  initGrowthUI();

  // Populate settings
  $<HTMLInputElement>('reinjectInterval').value = String(config.reinjectInterval);

  // ── Add slot buttons ──
  $('addIdentity').addEventListener('click', () => {
    if (config.identities.length >= MAX_SLOTS) return;
    const newSlot = { ...DEFAULT_IDENTITY, id: genId() };
    config.identities.push(newSlot);
    config.activeIdentity = config.identities.length - 1;
    bioSnapshots.set(newSlot.id, '');
    renderIdentityList();
    syncAddButtons();
    autoSave();
    renderGrowthSlots();
    renderGrowthTimeline();
  });

  $('addPersona').addEventListener('click', () => {
    if (config.personas.length >= MAX_SLOTS) return;
    const newSlot = { ...DEFAULT_PERSONA, id: genId() };
    config.personas.push(newSlot);
    config.activePersona = config.personas.length - 1;
    soulSnapshots.set(newSlot.id, '');
    renderPersonaList();
    syncAddButtons();
    autoSave();
    renderGrowthSlots();
    renderGrowthTimeline();
  });

  $('importPersona').addEventListener('click', () => showImportModal());

  // ── Settings auto-save ──
  $<HTMLInputElement>('reinjectInterval').addEventListener('change', () => {
    const v = parseInt($<HTMLInputElement>('reinjectInterval').value, 10) || 0;
    config.reinjectInterval = Math.min(Math.max(v, 0), 20);
    $<HTMLInputElement>('reinjectInterval').value = String(config.reinjectInterval);
    autoSave();
  });

  // ── Data management ──
  $('clearGrowth').addEventListener('click', async () => {
    if (!confirm('确定清除所有成长记录？此操作不可恢复。')) return;
    await browser.storage.local.remove(STORE.GROWTH_LOG);
    growthLog = [];
    renderGrowthSlots();
    renderGrowthTimeline();
    flash('成长记录已清除');
  });

  $('clearAll').addEventListener('click', async () => {
    if (!confirm('确定重置所有数据？画像、人设、成长记录和配置都将被删除，此操作不可恢复。')) return;
    await browser.storage.local.clear();
    location.reload();
  });
}

/* ══════════════════════════════════════════
 *  Identity list
 * ══════════════════════════════════════════ */

function renderIdentityList() {
  const list = $('identityList');
  list.innerHTML = '';

  config.identities.forEach((slot, i) => {
    list.appendChild(createIdentityItem(slot, i));
  });
}

function createIdentityItem(slot: UserIdentity, index: number): HTMLElement {
  const item = document.createElement('div');
  item.className = 'slot-item' + (index === config.activeIdentity ? ' active' : '');

  const header = document.createElement('div');
  header.className = 'slot-item-header';

  const nameInput = document.createElement('input');
  nameInput.className = 'slot-item-name';
  nameInput.type = 'text';
  nameInput.value = slot.name;
  nameInput.placeholder = '画像名称';
  nameInput.maxLength = 10;
  nameInput.addEventListener('input', () => { slot.name = nameInput.value.trim(); });
  nameInput.addEventListener('change', () => autoSave());

  const actions = document.createElement('div');
  actions.className = 'slot-item-actions';

  if (index !== config.activeIdentity) {
    const useBtn = document.createElement('button');
    useBtn.className = 'slot-action-btn';
    useBtn.textContent = '启用';
    useBtn.addEventListener('click', () => {
      config.activeIdentity = index;
      renderIdentityList();
      autoSave();
    });
    actions.appendChild(useBtn);
  }

  header.appendChild(nameInput);
  header.appendChild(actions);

  const bioField = document.createElement('textarea');
  bioField.className = 'slot-field';
  bioField.rows = 3;
  bioField.value = slot.bio;
  bioField.placeholder = '你的角色、技术栈、当前关注的领域——AI 会据此调整回复的深度和方向';
  bioField.addEventListener('input', () => { slot.bio = bioField.value; });
  bioField.addEventListener('change', () => autoSave());

  const delBtn = document.createElement('button');
  delBtn.className = 'slot-action-btn danger slot-delete-btn';
  delBtn.textContent = '删除画像';
  delBtn.addEventListener('click', async () => {
    const oldId = slot.id;
    if (config.identities.length <= 1) {
      // Last slot — clear content + growth
      slot.name = '';
      slot.bio = '';
      bioSnapshots.set(slot.id, '');
    } else {
      config.identities.splice(index, 1);
      if (config.activeIdentity >= config.identities.length) {
        config.activeIdentity = config.identities.length - 1;
      } else if (config.activeIdentity > index) {
        config.activeIdentity--;
      }
    }
    await clearSlotGrowth(oldId);
    growthLog = await loadGrowthLog();
    renderIdentityList();
    syncAddButtons();
    autoSave();
    renderGrowthSlots();
    renderGrowthTimeline();
  });

  item.appendChild(header);
  item.appendChild(withCharCount(bioField));
  item.appendChild(delBtn);
  return item;
}

/* ══════════════════════════════════════════
 *  Persona list
 * ══════════════════════════════════════════ */

function renderPersonaList() {
  const list = $('personaList');
  list.innerHTML = '';

  config.personas.forEach((slot, i) => {
    list.appendChild(createPersonaItem(slot, i));
  });
}

function createPersonaItem(slot: AIPersona, index: number): HTMLElement {
  const item = document.createElement('div');
  item.className = 'slot-item' + (index === config.activePersona ? ' active' : '');

  const header = document.createElement('div');
  header.className = 'slot-item-header';

  const nameInput = document.createElement('input');
  nameInput.className = 'slot-item-name';
  nameInput.type = 'text';
  nameInput.value = slot.name;
  nameInput.placeholder = '人设名称';
  nameInput.maxLength = 10;
  nameInput.addEventListener('input', () => { slot.name = nameInput.value.trim(); });
  nameInput.addEventListener('change', () => autoSave());

  const actions = document.createElement('div');
  actions.className = 'slot-item-actions';

  // Share button (潜忆匙)
  const shareBtn = document.createElement('button');
  shareBtn.className = 'slot-action-btn share';
  shareBtn.textContent = '分享';
  shareBtn.title = '生成潜忆匙';
  shareBtn.addEventListener('click', () => showShareModal(slot));
  actions.appendChild(shareBtn);

  if (index !== config.activePersona) {
    const useBtn = document.createElement('button');
    useBtn.className = 'slot-action-btn';
    useBtn.textContent = '启用';
    useBtn.addEventListener('click', () => {
      config.activePersona = index;
      renderPersonaList();
      autoSave();
    });
    actions.appendChild(useBtn);
  }

  header.appendChild(nameInput);
  header.appendChild(actions);

  const idLabel = document.createElement('span');
  idLabel.className = 'slot-field-label';
  idLabel.textContent = '身份设定';

  const idField = document.createElement('textarea');
  idField.className = 'slot-field';
  idField.rows = 3;
  idField.value = slot.identity;
  idField.placeholder = '如：资深全栈工程师，擅长系统设计和代码审查';
  idField.addEventListener('input', () => { slot.identity = idField.value; });
  idField.addEventListener('change', () => autoSave());

  const soulLabel = document.createElement('span');
  soulLabel.className = 'slot-field-label';
  soulLabel.textContent = '灵魂';

  const soulField = document.createElement('textarea');
  soulField.className = 'slot-field';
  soulField.rows = 2;
  soulField.value = slot.soul;
  soulField.placeholder = '思维习惯、表达偏好、沟通规则——如：先分析本质再给方案，用中文讨论、英文写代码，反对过度工程';
  soulField.addEventListener('input', () => { slot.soul = soulField.value; });
  soulField.addEventListener('change', () => autoSave());

  const delBtn = document.createElement('button');
  delBtn.className = 'slot-action-btn danger slot-delete-btn';
  delBtn.textContent = '删除人设';
  delBtn.addEventListener('click', async () => {
    const oldId = slot.id;
    if (config.personas.length <= 1) {
      // Last slot — clear content + growth
      slot.name = '';
      slot.identity = '';
      slot.soul = '';
      soulSnapshots.set(slot.id, '');
    } else {
      config.personas.splice(index, 1);
      if (config.activePersona >= config.personas.length) {
        config.activePersona = config.personas.length - 1;
      } else if (config.activePersona > index) {
        config.activePersona--;
      }
    }
    await clearSlotGrowth(oldId);
    growthLog = await loadGrowthLog();
    renderPersonaList();
    syncAddButtons();
    autoSave();
    renderGrowthSlots();
    renderGrowthTimeline();
  });

  item.appendChild(header);
  item.appendChild(idLabel);
  item.appendChild(withCharCount(idField));
  item.appendChild(soulLabel);
  item.appendChild(withCharCount(soulField));
  item.appendChild(delBtn);
  return item;
}

/* ══════════════════════════════════════════
 *  Depth bar (浮 漾 流 潜 沉)
 * ══════════════════════════════════════════ */

function renderDepthBar() {
  const bar = $('depthBar');
  bar.innerHTML = '';

  INJECTION_MODES.forEach((m) => {
    const btn = document.createElement('button');
    btn.className = 'depth-btn' + (config.mode === m.value ? ' active' : '');
    btn.dataset.mode = m.value;
    btn.textContent = m.glyph;
    btn.title = m.label;
    btn.addEventListener('click', async () => {
      if (config.mode === m.value) return;
      config.mode = m.value;
      renderDepthBar();
      await saveConfig(config);
      flash('✅ 已保存');
    });
    bar.appendChild(btn);
  });

  // Update description text
  const active = INJECTION_MODES.find((m) => m.value === config.mode);
  $('depthDesc').textContent = active ? `${active.label} — ${active.desc}` : '';
}

/* ══════════════════════════════════════════
 *  潜忆匙 — Import modal (text / image paste / file upload)
 * ══════════════════════════════════════════ */

let importOverlay: HTMLElement | null = null;

function ensureImportModal(): HTMLElement {
  if (importOverlay) return importOverlay;

  importOverlay = document.createElement('div');
  importOverlay.className = 'share-overlay';
  importOverlay.innerHTML = `
    <div class="share-modal import-modal">
      <div class="share-modal-title">🔑 导入潜忆匙</div>
      <div class="share-modal-sub">粘贴文本码、粘贴/拖入二维码图片，或选择图片文件</div>
      <textarea class="import-text" placeholder="在此粘贴潜忆匙文本码，或直接粘贴二维码截图…" rows="3"></textarea>
      <div class="import-drop-zone" id="importDropZone">
        <span class="import-drop-icon">📷</span>
        <span>拖入二维码图片，或 <label class="import-file-label">选择文件<input type="file" accept="image/*" class="import-file-input" /></label></span>
      </div>
      <div class="import-preview" hidden></div>
      <div class="share-actions">
        <button class="primary" data-action="import" disabled>导入</button>
        <button data-action="close">取消</button>
      </div>
    </div>
  `;
  document.body.appendChild(importOverlay);

  const textarea = importOverlay.querySelector('.import-text') as HTMLTextAreaElement;
  const dropZone = importOverlay.querySelector('.import-drop-zone') as HTMLElement;
  const fileInput = importOverlay.querySelector('.import-file-input') as HTMLInputElement;
  const preview = importOverlay.querySelector('.import-preview') as HTMLElement;
  const importBtn = importOverlay.querySelector('[data-action="import"]') as HTMLButtonElement;
  let pendingPersona: AIPersona | null = null;

  function setPending(p: AIPersona | null, label?: string) {
    pendingPersona = p;
    importBtn.disabled = !p;
    if (p) {
      preview.hidden = false;
      preview.textContent = `✅ 识别到人设「${p.name || '未命名'}」${label ? ' — ' + label : ''}`;
    } else {
      preview.hidden = true;
      preview.textContent = '';
    }
  }

  // Text input — debounced decode
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  textarea.addEventListener('input', () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      const text = textarea.value.trim();
      if (!text) { setPending(null); return; }
      const persona = await decodePersona(text);
      setPending(persona, persona ? '文本码' : undefined);
      if (!persona && text.length > 5) {
        preview.hidden = false;
        preview.textContent = '⚠️ 无法识别该文本码';
      }
    }, 300);
  });

  // Paste — handle both text and image
  textarea.addEventListener('paste', async (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const blob = item.getAsFile();
        if (!blob) continue;
        await tryDecodeImage(blob);
        return;
      }
    }
    // Text paste handled by 'input' event
  });

  // Drag & drop
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer?.files[0];
    if (file?.type.startsWith('image/')) await tryDecodeImage(file);
  });

  // File picker
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (file) await tryDecodeImage(file);
    fileInput.value = '';
  });

  async function tryDecodeImage(blob: Blob) {
    preview.hidden = false;
    preview.textContent = '⏳ 正在识别二维码…';
    const persona = await decodeQR(blob);
    if (persona) {
      setPending(persona, '二维码');
    } else {
      setPending(null);
      preview.hidden = false;
      preview.textContent = '⚠️ 未识别到有效的潜忆匙二维码';
    }
  }

  // Close on overlay click
  importOverlay.addEventListener('click', (e) => {
    if (e.target === importOverlay) closeImportModal();
  });

  // Button actions
  importOverlay.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = (btn as HTMLElement).dataset.action;
      if (action === 'close') { closeImportModal(); return; }
      if (action === 'import' && pendingPersona) {
        if (config.personas.length >= MAX_SLOTS) {
          flash('⚠️ 人设已满，请先删除一个');
          return;
        }
        pendingPersona.id = genId();
        config.personas.push(pendingPersona);
        config.activePersona = config.personas.length - 1;
        renderPersonaList();
        syncAddButtons();
        autoSave();
        renderGrowthSlots();
        renderGrowthTimeline();
        flash(`🔑 已导入「${pendingPersona.name || '未命名'}」`);
        closeImportModal();
      }
    });
  });

  return importOverlay;
}

function showImportModal() {
  const overlay = ensureImportModal();
  // Reset state
  const textarea = overlay.querySelector('.import-text') as HTMLTextAreaElement;
  const preview = overlay.querySelector('.import-preview') as HTMLElement;
  const importBtn = overlay.querySelector('[data-action="import"]') as HTMLButtonElement;
  textarea.value = '';
  preview.hidden = true;
  importBtn.disabled = true;
  overlay.classList.add('show');
  setTimeout(() => textarea.focus(), 100);
}

function closeImportModal() {
  importOverlay?.classList.remove('show');
}

/* ══════════════════════════════════════════
 *  Helpers
 * ══════════════════════════════════════════ */

function syncAddButtons() {
  ($('addIdentity') as HTMLButtonElement).disabled = config.identities.length >= MAX_SLOTS;
  ($('addPersona') as HTMLButtonElement).disabled = config.personas.length >= MAX_SLOTS;
}

/** Snapshot all current bio/soul values for change detection */
function snapshotAll() {
  bioSnapshots.clear();
  soulSnapshots.clear();
  for (const s of config.identities) bioSnapshots.set(s.id, s.bio);
  for (const s of config.personas) soulSnapshots.set(s.id, s.soul);
}

let saveDebounce: ReturnType<typeof setTimeout> | null = null;

function autoSave() {
  if (saveDebounce) clearTimeout(saveDebounce);
  saveDebounce = setTimeout(async () => {
    // Detect bio changes and record growth
    for (const slot of config.identities) {
      const before = bioSnapshots.get(slot.id) ?? '';
      if (slot.bio !== before) {
        const source = before === '' && slot.bio !== '' ? 'init' as const : 'user' as const;
        await appendGrowth({ ts: Date.now(), field: 'bio', slotId: slot.id, before, after: slot.bio, source });
        bioSnapshots.set(slot.id, slot.bio);
      }
    }
    // Detect soul changes and record growth
    for (const slot of config.personas) {
      const before = soulSnapshots.get(slot.id) ?? '';
      if (slot.soul !== before) {
        const source = before === '' && slot.soul !== '' ? 'init' as const : 'user' as const;
        await appendGrowth({ ts: Date.now(), field: 'soul', slotId: slot.id, before, after: slot.soul, source });
        soulSnapshots.set(slot.id, slot.soul);
      }
    }

    await saveConfig(config);
    growthLog = await loadGrowthLog();
    renderGrowthTimeline();
    flash('✅ 已保存');
  }, 300);
}

/* ══════════════════════════════════════════
 *  Share modal (QR + text code)
 * ══════════════════════════════════════════ */

let shareOverlay: HTMLElement | null = null;
let sharePersonaName = '';

function ensureShareModal(): HTMLElement {
  if (shareOverlay) return shareOverlay;

  shareOverlay = document.createElement('div');
  shareOverlay.className = 'share-overlay';
  shareOverlay.innerHTML = `
    <div class="share-modal">
      <div class="share-modal-title">🔑 潜忆匙</div>
      <div class="share-modal-sub"></div>
      <div class="share-qr-wrap"></div>
      <div class="share-code-wrap">
        <textarea class="share-code" readonly></textarea>
      </div>
      <div class="share-actions">
        <button class="primary" data-action="copy">复制文本码</button>
        <button data-action="save">保存二维码</button>
        <button data-action="close">关闭</button>
      </div>
    </div>
  `;
  document.body.appendChild(shareOverlay);

  // Close on overlay click
  shareOverlay.addEventListener('click', (e) => {
    if (e.target === shareOverlay) closeShareModal();
  });

  // Button actions
  shareOverlay.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = (btn as HTMLElement).dataset.action;
      if (action === 'close') closeShareModal();
      else if (action === 'copy') {
        const code = shareOverlay!.querySelector('.share-code') as HTMLTextAreaElement;
        navigator.clipboard.writeText(code.value).then(() => flash('🔑 潜忆匙已复制'));
      } else if (action === 'save') {
        const img = shareOverlay!.querySelector('.share-qr-wrap img') as HTMLImageElement | null;
        if (!img) { flash('⚠️ 该人设超出二维码容量'); return; }
        const a = document.createElement('a');
        a.href = img.src;
        a.download = `潜忆匙-${sharePersonaName || '未命名'}.png`;
        a.click();
      }
    });
  });

  return shareOverlay;
}

async function showShareModal(persona: AIPersona) {
  const overlay = ensureShareModal();
  const sub = overlay.querySelector('.share-modal-sub')!;
  const qrWrap = overlay.querySelector('.share-qr-wrap')!;
  const codeArea = overlay.querySelector('.share-code') as HTMLTextAreaElement;

  // Show loading state
  sharePersonaName = persona.name || '未命名';
  sub.textContent = `「${sharePersonaName}」· 生成中…`;
  qrWrap.innerHTML = '<div class="share-qr-none">生成中…</div>';
  codeArea.value = '';

  // Show overlay first
  overlay.classList.add('show');

  // Generate both in parallel
  const [code, qrDataUrl] = await Promise.all([
    encodePersona(persona),
    generateQR(persona),
  ]);

  codeArea.value = code;
  sub.textContent = `「${sharePersonaName}」· ${code.length} 字符`;

  if (qrDataUrl) {
    qrWrap.innerHTML = `<img src="${qrDataUrl}" alt="QR" class="share-card-img" />`;
  } else {
    qrWrap.innerHTML = `<div class="share-qr-none">内容过长（超出 QR 容量 ${QR_MAX_BYTES}B），请用文本码分享</div>`;
  }
}

function closeShareModal() {
  shareOverlay?.classList.remove('show');
}

function flash(text: string) {
  const el = $('toast');
  $('toastText').textContent = text;
  el.hidden = false;
  void el.offsetHeight;
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => { el.hidden = true; }, 300);
  }, 1200);
}

/* ══════════════════════════════════════════
 *  Growth log UI
 * ══════════════════════════════════════════ */

function initGrowthUI() {
  // Tab switching
  document.querySelectorAll('.growth-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      growthField = (tab as HTMLElement).dataset.field as GrowthField;
      growthSlotId = null;
      growthShowAll = false;
      document.querySelectorAll('.growth-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      renderGrowthSlots();
      renderGrowthTimeline();
    });
  });

  // More button
  $('growthMore').addEventListener('click', () => {
    growthShowAll = true;
    $('growthMore').hidden = true;
    renderGrowthTimeline();
  });

  renderGrowthSlots();
  renderGrowthTimeline();
}

function renderGrowthSlots() {
  const container = $('growthSlots');
  container.innerHTML = '';

  const slots = growthField === 'bio' ? config.identities : config.personas;
  if (slots.length <= 1) {
    // Single slot — no need for pills, auto-select
    growthSlotId = slots[0]?.id ?? null;
    container.hidden = true;
    return;
  }

  container.hidden = false;
  // Auto-select first if none selected or current not in list
  if (!growthSlotId || !slots.some(s => s.id === growthSlotId)) {
    growthSlotId = slots[0]?.id ?? null;
  }

  slots.forEach(slot => {
    const pill = document.createElement('button');
    pill.className = 'growth-slot-pill' + (slot.id === growthSlotId ? ' active' : '');
    pill.textContent = (slot as { name: string }).name || '未命名';
    pill.addEventListener('click', () => {
      growthSlotId = slot.id;
      growthShowAll = false;
      renderGrowthSlots();
      renderGrowthTimeline();
    });
    container.appendChild(pill);
  });
}

function renderGrowthTimeline() {
  const container = $('growthTimeline');
  container.innerHTML = '';

  if (!growthSlotId) {
    container.innerHTML = '<p class="growth-empty">暂无记录</p>';
    $('growthMore').hidden = true;
    return;
  }

  const history = getSlotHistory(growthLog, growthSlotId, growthField);
  if (history.length === 0) {
    container.innerHTML = '<p class="growth-empty">暂无记录</p>';
    $('growthMore').hidden = true;
    return;
  }

  const display = growthShowAll ? history : history.slice(0, GROWTH_PREVIEW_COUNT);

  display.forEach(entry => {
    container.appendChild(createGrowthEntry(entry));
  });

  $('growthMore').hidden = growthShowAll || history.length <= GROWTH_PREVIEW_COUNT;
}

function createGrowthEntry(entry: GrowthEntry): HTMLElement {
  const el = document.createElement('div');
  el.className = `growth-entry source-${entry.source}`;

  // Header: timestamp + source badge
  const header = document.createElement('div');
  header.className = 'growth-header';

  const ts = document.createElement('span');
  ts.className = 'growth-ts';
  ts.textContent = entry.source === 'init' ? '★ 初始版本' : formatTs(entry.ts);

  const badge = document.createElement('span');
  badge.className = `growth-source ${entry.source}`;
  badge.textContent = entry.source === 'init' ? '首次记录'
    : entry.source === 'auto' ? '自主成长'
    : '手动编辑';

  header.appendChild(ts);
  if (entry.source !== 'init') header.appendChild(badge);
  el.appendChild(header);

  // Content: init shows full text, others show diff
  if (entry.source === 'init') {
    const text = document.createElement('div');
    text.className = 'growth-init-text';
    text.textContent = entry.after || '（空）';
    el.appendChild(text);
  } else {
    const diffContainer = document.createElement('div');
    diffContainer.className = 'growth-diff';
    const diffs = lineDiff(entry.before, entry.after);

    // Only show changed lines (add/del), skip equal lines for brevity
    let hasChanges = false;
    for (const d of diffs) {
      if (d.type === 'eq') continue;
      hasChanges = true;
      const line = document.createElement('div');
      line.className = `diff-line ${d.type}`;
      line.textContent = `${d.type === 'add' ? '+' : '−'} ${d.text}`;
      diffContainer.appendChild(line);
    }

    if (!hasChanges) {
      const noChange = document.createElement('div');
      noChange.className = 'diff-line eq';
      noChange.textContent = '（格式调整，内容未变）';
      diffContainer.appendChild(noChange);
    }

    el.appendChild(diffContainer);
  }

  return el;
}

/* ══════════════════════════════════════════
 *  Theme toggle
 * ══════════════════════════════════════════ */

function initThemeToggle(current: ThemePref) {
  const container = $('themeToggle');
  const btns = container.querySelectorAll<HTMLButtonElement>('.theme-btn');

  // Set initial active
  btns.forEach(btn => {
    if (btn.dataset.theme === current) btn.classList.add('active');
  });

  container.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.theme-btn');
    if (!btn) return;
    const pref = btn.dataset.theme as ThemePref;
    btns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    applyTheme(pref);
    await saveThemePref(pref);
  });
}

init();
