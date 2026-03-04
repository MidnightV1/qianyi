/**
 * ISOLATED-world content script.
 *
 * Responsibilities:
 *   1. Load GhostConfig from chrome.storage, resolve InjectionContext,
 *      and relay it to the MAIN-world interceptor via postMessage
 *   2. Watch for storage changes and re-send context in real-time
 *   3. Handle info-control bio writeback (update active identity slot)
 *   4. DOM cleaning — hide injection blocks that appear in rendered messages
 *   5. Debug panel — show current injection text when toggled on
 */

import { getAdapterForHost } from '../lib/adapters';
import { formatInjection } from '../lib/injection';
import { MSG, STORE } from '../lib/constants';
import {
  loadConfig, saveConfig, resolveContext,
  type GhostConfig, type InjectionContext,
} from '../lib/profile';
import { appendGrowth } from '../lib/growth';

const SCRIPT_MATCHES = [
  '*://chat.deepseek.com/*',
  '*://gemini.google.com/*',
  '*://aistudio.google.com/*',
  '*://kimi.moonshot.cn/*',
  '*://chat.qwen.ai/*',
  '*://tongyi.aliyun.com/*',
  '*://tongyi.com/*',
  '*://qianwen.com/*',
  '*://www.qianwen.com/*',
];

export default defineContentScript({
  matches: SCRIPT_MATCHES,
  runAt: 'document_idle',

  async main() {
    /* ── Load config (with v1→v2 auto-migration) ── */
    let config = await loadConfig();
    let ctx = resolveContext(config);

    // Initial push to MAIN world
    sendToPage(ctx);

    // Debug panel
    updateDebugPanel(config.showInjection, ctx);

    /* ── Listen for info-control data from MAIN world ── */
    window.addEventListener('message', (e) => {
      if (e.source !== window) return;
      if (e.data?.type !== MSG.INFO_CONTROL) return;

      const data = e.data.data as { needUpdate: boolean; updatedBio?: string; needUpdateSoul: boolean; updatedSoul?: string };

      let changed = false;

      // Auto-update bio in the active identity slot
      if (data.needUpdate && data.updatedBio && config.activeIdentity >= 0) {
        const slot = config.identities[config.activeIdentity];
        if (slot) {
          const before = slot.bio;
          slot.bio = data.updatedBio;
          changed = true;
          console.log('[Qianyi] ✏️ Bio updated:', data.updatedBio.slice(0, 50));
          appendGrowth({ ts: Date.now(), field: 'bio', slotId: slot.id, before, after: data.updatedBio, source: 'auto' });
        }
      }

      // Auto-update soul in the active persona slot
      if (data.needUpdateSoul && data.updatedSoul && config.activePersona >= 0) {
        const personaSlot = config.personas[config.activePersona];
        if (personaSlot) {
          const before = personaSlot.soul;
          personaSlot.soul = data.updatedSoul;
          changed = true;
          console.log('[Qianyi] ✏️ Soul updated:', data.updatedSoul.slice(0, 50));
          appendGrowth({ ts: Date.now(), field: 'soul', slotId: personaSlot.id, before, after: data.updatedSoul, source: 'auto' });
        }
      }

      if (changed) {
        saveConfig(config);
        ctx = resolveContext(config);
        sendToPage(ctx);
        updateDebugPanel(config.showInjection, ctx);
      }
    });

    /* ── React to popup / options page changes ── */
    browser.storage.onChanged.addListener((changes) => {
      if (changes[STORE.CONFIG]) {
        config = changes[STORE.CONFIG].newValue as GhostConfig;
        ctx = resolveContext(config);
        sendToPage(ctx);
        updateDebugPanel(config.showInjection, ctx);
      }
    });

    /* ── DOM cleaning ── */
    setupDOMCleaner();
  },
});

/* ── Helpers ── */

function sendToPage(ctx: InjectionContext) {
  window.postMessage({ type: MSG.PROFILE_UPDATE, ctx }, '*');
}

function setupDOMCleaner() {
  const adapter = getAdapterForHost(window.location.hostname);
  const clean = () => adapter.cleanDOM(document.body);
  clean();

  // Use requestAnimationFrame for near-instant cleanup before paint.
  // Batch rapid mutations within the same frame.
  let rafPending = false;
  const scheduleClean = () => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      clean();
    });
  };

  // MutationObserver: synchronous element-level ghost-ml removal.
  // The response-stream filter handles the primary cleanup at the source;
  // this is a fallback for edge cases (SSR, EventSource, cached DOM, etc.).
  const observer = new MutationObserver((mutations) => {
    let needsClean = false;

    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node instanceof HTMLElement) {
          const tag = node.tagName.toLowerCase();
          if (tag.includes('ghost-ml')) {
            // Synchronous removal — don't let it paint even one frame
            if (
              tag === 'info-control-ghost-ml'
              || tag === 'need-update-ghost-ml'
              || tag === 'updated-user-bio-ghost-ml'
              || tag === 'need-update-soul-ghost-ml'
              || tag === 'updated-ai-soul-ghost-ml'
              || tag === 'main-ghost-ml'
            ) {
              node.remove();
            } else if (
              tag === 'model-response-ghost-ml'
              || tag === 'origin-user-input-ghost-ml'
            ) {
              // Unwrap: keep children, remove wrapper
              const parent = node.parentNode;
              if (parent) {
                while (node.firstChild) parent.insertBefore(node.firstChild, node);
                node.remove();
              }
            } else {
              node.remove(); // unknown ghost-ml element — remove to be safe
            }
          } else {
            needsClean = true;
          }
        }
      }
    }

    if (needsClean) scheduleClean();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

/* ── Debug injection panel ── */

const PANEL_ID = 'ghost-context-debug-panel';

function updateDebugPanel(show: boolean, ctx: InjectionContext) {
  let panel = document.getElementById(PANEL_ID);

  if (!show) {
    panel?.remove();
    return;
  }

  if (!panel) {
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    Object.assign(panel.style, {
      position: 'fixed',
      bottom: '16px',
      right: '16px',
      width: '340px',
      maxHeight: '300px',
      overflowY: 'auto',
      background: '#1a1a2e',
      color: '#e0e0e0',
      border: '2px solid #ff9800',
      borderRadius: '8px',
      padding: '12px',
      fontSize: '12px',
      fontFamily: 'monospace',
      zIndex: '99999',
      boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-all',
    });
    document.body.appendChild(panel);
  }

  const injection = formatInjection(ctx, '（用户输入将出现在此处）');
  panel.innerHTML = `<div style="color:#ff9800;font-weight:bold;margin-bottom:8px">潜忆 · 当前注入结构 [${ctx.mode}]</div><div style="color:#aaa">${escapeHtml(injection)}</div>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}
