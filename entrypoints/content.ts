/**
 * ISOLATED-world content script.
 *
 * Responsibilities:
 *   1. Read user profile from chrome.storage and relay it to the MAIN-world
 *      interceptor via postMessage (bridge between extension APIs ↔ page JS)
 *   2. Watch for storage changes and re-send profile in real-time
 *   3. DOM cleaning — hide injection blocks that appear in rendered messages
 *   4. Debug panel — show current injection text when "显示注入" is on
 */

import { deepseekAdapter } from '../lib/adapters/deepseek';
import { formatInjection } from '../lib/injection';
import { MSG, STORE, DEFAULT_REINJECT_INTERVAL, RESP_TAG } from '../lib/constants';
import type { UserProfile } from '../lib/profile';

export default defineContentScript({
  matches: ['*://chat.deepseek.com/*'],
  runAt: 'document_idle',

  async main() {
    /* ── Load settings ── */
    const settings = await browser.storage.local.get([
      STORE.PROFILE,
      STORE.ENABLED,
      STORE.DEBUG,
      STORE.SHOW_INJECTION,
      STORE.REINJECT_INTERVAL,
    ]);

    let profile: UserProfile = settings[STORE.PROFILE] ?? {
      bio: '',
      persona: '',
      style: '',
    };
    let enabled: boolean = settings[STORE.ENABLED] ?? true;
    let debug: boolean = settings[STORE.DEBUG] ?? false;
    let showInjection: boolean = settings[STORE.SHOW_INJECTION] ?? false;
    let reinjectInterval: number = settings[STORE.REINJECT_INTERVAL] ?? DEFAULT_REINJECT_INTERVAL;

    // Initial push to MAIN world
    sendToPage(profile, enabled, debug, reinjectInterval);

    // Debug panel
    updateDebugPanel(showInjection, profile);

    /* ── Listen for info-control data from MAIN world ── */
    window.addEventListener('message', (e) => {
      if (e.source !== window) return;
      if (e.data?.type !== MSG.INFO_CONTROL) return;

      const data = e.data.data as { needUpdate: boolean; updatedBio?: string };
      if (debug) console.log('[GhostContext] 📦 Info-control received:', data);

      if (data.needUpdate && data.updatedBio) {
        // Auto-update bio in profile
        profile = { ...profile, bio: data.updatedBio };
        browser.storage.local.set({ [STORE.PROFILE]: profile });
        if (debug) console.log('[GhostContext] ✏️ Bio auto-updated:', data.updatedBio.slice(0, 50));

        // Re-send updated profile to MAIN world
        sendToPage(profile, enabled, debug, reinjectInterval);
        updateDebugPanel(showInjection, profile);
      }
    });

    /* ── React to popup changes ── */
    browser.storage.onChanged.addListener((changes) => {
      if (changes[STORE.PROFILE]) profile = changes[STORE.PROFILE].newValue;
      if (changes[STORE.ENABLED]) enabled = changes[STORE.ENABLED].newValue;
      if (changes[STORE.DEBUG]) debug = changes[STORE.DEBUG].newValue;
      if (changes[STORE.SHOW_INJECTION] != null) {
        showInjection = changes[STORE.SHOW_INJECTION].newValue;
      }
      if (changes[STORE.REINJECT_INTERVAL] != null) {
        reinjectInterval = changes[STORE.REINJECT_INTERVAL].newValue;
      }

      sendToPage(profile, enabled, debug, reinjectInterval);
      updateDebugPanel(showInjection, profile);

      if (debug) console.log('[GhostContext] Settings updated, re-sent to page');
    });

    /* ── DOM cleaning ── */
    setupDOMCleaner();

    if (debug) console.log('[GhostContext] Content script loaded');
  },
});

/* ── Helpers ── */

function sendToPage(profile: UserProfile, enabled: boolean, debug: boolean, reinjectInterval: number) {
  window.postMessage({ type: MSG.PROFILE_UPDATE, profile, enabled, debug, reinjectInterval }, '*');
}

function setupDOMCleaner() {
  const clean = () => deepseekAdapter.cleanDOM(document.body);
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
            deepseekAdapter.cleanDOM(node);
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

function updateDebugPanel(show: boolean, profile: UserProfile) {
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

  const injection = formatInjection(profile, '（用户输入将出现在此处）');
  panel.innerHTML = `<div style="color:#ff9800;font-weight:bold;margin-bottom:8px">👻 当前注入结构</div><div style="color:#aaa">${escapeHtml(injection)}</div>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}
