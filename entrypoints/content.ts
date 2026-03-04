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
import { MSG, STORE, RESP_TAG } from '../lib/constants';
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

  // ── Synchronous streaming cleanup ──
  // When ghost-ml tags appear as literal text (not HTML elements),
  // CSS can't hide them. Clean synchronously in MutationObserver
  // callback — before the browser paints.
  //
  // Two strategies:
  //   STRIP:    opening <model-response-ghost-ml> — remove tag text, keep content after it
  //   TRUNCATE: </model-response-ghost-ml> and <info-control-ghost-ml> — cut everything from tag onward

  const RESP_OPEN = `<${RESP_TAG}>`;
  const TRUNC_TARGETS = [
    `</${RESP_TAG}`,            // </model-response-ghost-ml (closing)
    `<info-control-ghost-ml`,   // control block opening
  ];

  /**
   * Synchronous text-node cleanup: strip opening tag, truncate at closing/control tags.
   * Returns true if any modification was made.
   */
  function cleanGhostText(textNode: Text): boolean {
    let val = textNode.nodeValue || '';
    if (!val || !val.includes('<')) return false;

    let changed = false;

    // STRIP: remove opening <model-response-ghost-ml> tag text, keep content after
    if (val.includes(RESP_OPEN)) {
      val = val.replace(RESP_OPEN, '');
      changed = true;
    }

    // STRIP: also handle partial opening tag being built at the tail
    // e.g. "Hello<model-response-ghost-m" — remove from '<' onward
    if (!changed) {
      const searchStart = Math.max(0, val.length - 30);
      const tail = val.slice(searchStart);
      const ltIdx = tail.lastIndexOf('<');
      if (ltIdx !== -1) {
        const candidate = tail.slice(ltIdx);
        // Check if it's building toward the opening tag
        if (RESP_OPEN.startsWith(candidate) && candidate.length > 1 && candidate !== RESP_OPEN) {
          val = val.slice(0, searchStart + ltIdx);
          changed = true;
        }
      }
    }

    // TRUNCATE: find earliest closing/control tag and cut everything from there
    let cutAt = -1;
    for (const target of TRUNC_TARGETS) {
      const idx = val.indexOf(target);
      if (idx !== -1 && (cutAt === -1 || idx < cutAt)) {
        cutAt = idx;
      }
    }

    if (cutAt !== -1) {
      val = val.slice(0, cutAt);
      changed = true;
    } else {
      // Partial truncation target at the tail
      const searchStart = Math.max(0, val.length - 40);
      const tail = val.slice(searchStart);
      const ltIdx = tail.lastIndexOf('<');
      if (ltIdx !== -1) {
        const candidate = tail.slice(ltIdx);
        for (const target of TRUNC_TARGETS) {
          if (target.startsWith(candidate) && candidate.length > 1) {
            val = val.slice(0, searchStart + ltIdx);
            changed = true;
            break;
          }
        }
      }
    }

    if (changed) {
      textNode.nodeValue = val;
    }
    return changed;
  }

  /** Run cleanGhostText on all text nodes inside an element */
  function cleanGhostTextInTree(root: Node): boolean {
    let cleaned = false;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if (cleanGhostText(walker.currentNode as Text)) {
        cleaned = true;
      }
    }
    return cleaned;
  }

  const observer = new MutationObserver((mutations) => {
    let needsClean = false;

    for (const m of mutations) {
      // New nodes added
      for (const node of m.addedNodes) {
        if (node instanceof HTMLElement) {
          const tag = node.tagName.toLowerCase();
          if (tag.includes('ghost-ml')) {
            // Synchronous removal — don't let it paint even one frame
            if (tag === 'info-control-ghost-ml' || tag === 'need-update-ghost-ml' || tag === 'updated-user-bio-ghost-ml') {
              node.remove();
            } else if (tag === 'model-response-ghost-ml') {
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
            adapter.cleanDOM(node);
            // Also run text-level cleanup on descendants (belt & suspenders)
            cleanGhostTextInTree(node);
          }
        }
        // Text node added with ghost-ml content
        if (node.nodeType === Node.TEXT_NODE) {
          if (cleanGhostText(node as Text)) {
            needsClean = true;
          } else if (node.nodeValue?.includes('ghost-ml')) {
            needsClean = true;
          }
        }
      }

      // Existing text node content changed (streaming appends)
      if (m.type === 'characterData') {
        const tn = m.target as Text;
        // Synchronous cleanup — runs before paint
        if (cleanGhostText(tn)) {
          needsClean = true;
        } else if (tn.nodeValue?.includes('ghost-ml')) {
          needsClean = true;
        }
      }
    }

    if (needsClean) scheduleClean();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
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
