import type { PlatformAdapter } from './types';
import { MAIN_TAG, USER_INPUT_TAG, RESP_TAG, INFO_CTRL_TAG, NEED_UPDATE_TAG, UPDATED_BIO_TAG } from '../constants';
import { formatInjection, formatTimeOnlyInjection } from '../injection';
import type { InjectionContext } from '../profile';

/**
 * DeepSeek Web Chat adapter (chat.deepseek.com)
 *
 * ⚠️  The exact API endpoint and request body schema need empirical calibration.
 *     Enable debug mode in the popup → all fetch calls are logged to console,
 *     so you can identify the correct URL pattern and body fields.
 */
export const deepseekAdapter: PlatformAdapter = {
  id: 'deepseek',
  name: 'DeepSeek',
  matchPatterns: ['*://chat.deepseek.com/*'],

  capabilities: {
    knowsCurrentTime: false,
  },

  /* ── Request detection ─────────────────────────────── */

  shouldIntercept(url: string, body?: Record<string, unknown>): boolean {
    // Normalize: handle both absolute and relative URLs
    let pathname: string;
    try {
      const u = new URL(url, 'https://chat.deepseek.com');
      pathname = u.pathname;
    } catch {
      pathname = url.split('?')[0]; // raw fallback
    }

    // Primary: exact endpoint match (confirmed via network inspection)
    if (pathname === '/api/v0/chat/completion') return true;

    // Fallback: any /api/ path with a prompt field
    if (pathname.startsWith('/api/') && body && typeof body.prompt === 'string') return true;

    return false;
  },

  /* ── Payload modification ──────────────────────────── */

  modifyRequestBody(
    body: Record<string, unknown>,
    ctx: InjectionContext,
  ): Record<string, unknown> {
    // DeepSeek uses { prompt: "..." } — replace with full ghost-ml structure
    if (typeof body.prompt === 'string') {
      return { ...body, prompt: formatInjection(ctx, body.prompt) };
    }

    // Fallback: OpenAI-compatible messages array
    if (Array.isArray(body.messages)) {
      const msgs = body.messages as Array<{ role: string; content: string }>;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'user') {
          msgs[i] = { ...msgs[i], content: formatInjection(ctx, msgs[i].content) };
          break;
        }
      }
      return body;
    }

    // Generic fallback
    for (const key of ['message', 'content', 'query', 'input'] as const) {
      if (typeof body[key] === 'string') {
        return { ...body, [key]: formatInjection(ctx, body[key] as string) };
      }
    }

    console.warn(
      '[GhostContext] ⚠️ Unrecognized body format — keys:',
      Object.keys(body),
    );
    return body;
  },

  /* ── Time-only injection (switch OFF) ───────────────── */

  modifyRequestBodyTimeOnly(body: Record<string, unknown>): Record<string, unknown> | null {
    if (typeof body.prompt === 'string') {
      return { ...body, prompt: formatTimeOnlyInjection(body.prompt) };
    }
    return null;
  },

  /* ── SSE parsing ─────────────────────────────── */

  /**
   * DeepSeek uses JSON-patch style SSE:
   *   - Initial: {"v":{"response":{"fragments":[{"id":2,"type":"THINK","content":"..."}]}}}
   *   - Append:  {"p":"response/fragments/-1/content","o":"APPEND","v":"text"}
   *   - Add:     {"o":"ADD","p":"response/fragments/-","v":{"id":3,"type":"TEXT","content":"..."}}
   *
   * THINK fragments come first (reasoning), then TEXT fragments (actual response).
   * APPEND ops use fragment index (e.g. -1 = last), not type, so we track fragment types.
   *
   * parseState extra fields:
   *   - fragmentTypes: Map<number, string>  — fragment index → type mapping
   *   - lastOp: string  — last seen JSON-patch op (for implicit inherit)
   *   - lastPath: string — last seen JSON-patch path (for implicit inherit)
   *   - debug: boolean — enable unmatched-line logging
   *   - _unmatched: number — count of unmatched data lines (for debug)
   *
   * Observed DeepSeek SSE ops:
   *   Initial:  {"v":{"response":{"fragments":[{"type":"THINK",...}]}}}
   *   APPEND array on fragments: {"p":"response/fragments","o":"APPEND","v":[{"type":"RESPONSE",...}]}
   *   APPEND string on content:  {"p":"response/fragments/-1/content","o":"APPEND","v":"text"}
   *   Bare value (inherit):      {"v":"text"}              — inherits last o/p
   *   Bare path+value (inherit): {"p":"response/fragments/-1/content","v":"text"} — implicit APPEND
   *   SET:   {"p":"response/fragments/-1/elapsed_secs","o":"SET","v":5.6}
   *   BATCH: {"p":"response","o":"BATCH","v":[...]}
   */
  extractContentDeltas(sseChunk: string, parseState: Record<string, unknown> & { partial: string }): string[] {
    const text = parseState.partial + sseChunk;
    const lines = text.split('\n');
    parseState.partial = lines.pop() || '';

    // Initialize fragment type tracker
    if (!parseState.fragmentTypes) {
      parseState.fragmentTypes = new Map<number, string>();
    }
    const fragTypes = parseState.fragmentTypes as Map<number, string>;
    if (!parseState._unmatched) parseState._unmatched = 0;

    const deltas: string[] = [];
    for (const line of lines) {
      if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
      try {
        const json = JSON.parse(line.slice(6));

        // ① Initial full fragment data — register types and extract non-THINK content
        const fragments = json.v?.response?.fragments;
        if (Array.isArray(fragments)) {
          for (let i = 0; i < fragments.length; i++) {
            const frag = fragments[i];
            fragTypes.set(i, frag.type);
            if (frag.content && frag.type !== 'THINK') {
              deltas.push(frag.content);
            }
          }
          continue;
        }

        // ② APPEND array on "response/fragments" — new fragment(s) added
        //    e.g. {"p":"response/fragments","o":"APPEND","v":[{"type":"RESPONSE","content":"<",...}]}
        if (json.o === 'APPEND' && typeof json.p === 'string'
            && json.p.endsWith('/fragments') && Array.isArray(json.v)) {
          for (const frag of json.v) {
            const newIdx = fragTypes.size;
            fragTypes.set(newIdx, frag.type || 'RESPONSE');
            parseState.lastOp = 'APPEND';
            parseState.lastPath = `response/fragments/${newIdx}/content`;
            if (frag.content && frag.type !== 'THINK') {
              deltas.push(frag.content);
            }
          }
          continue;
        }

        // ③ ADD on fragments path — alternative new-fragment format
        if (json.o === 'ADD' && typeof json.p === 'string' && json.p.includes('fragments') && json.v) {
          const newIdx = fragTypes.size;
          fragTypes.set(newIdx, json.v.type || 'RESPONSE');
          parseState.lastOp = 'APPEND';
          parseState.lastPath = `response/fragments/${newIdx}/content`;
          if (json.v.content && json.v.type !== 'THINK') {
            deltas.push(json.v.content);
          }
          continue;
        }

        // ④ Explicit APPEND on a fragment content path
        if (json.o === 'APPEND' && typeof json.p === 'string' && json.p.includes('/content') && typeof json.v === 'string') {
          parseState.lastOp = 'APPEND';
          parseState.lastPath = json.p;
          const delta = this._resolveAppend(json.v, json.p, fragTypes);
          if (delta !== null) deltas.push(delta);
          continue;
        }

        // ⑤ Implicit APPEND with path but no op: {"p":"response/fragments/-1/content","v":"text"}
        if (!json.o && typeof json.p === 'string' && json.p.includes('/content') && typeof json.v === 'string') {
          parseState.lastOp = 'APPEND';
          parseState.lastPath = json.p;
          const delta = this._resolveAppend(json.v, json.p, fragTypes);
          if (delta !== null) deltas.push(delta);
          continue;
        }

        // ⑥ Bare {"v":"text"} — inherit last op/path
        if (typeof json.v === 'string' && !json.o && !json.p && parseState.lastOp === 'APPEND' && parseState.lastPath) {
          const delta = this._resolveAppend(json.v, parseState.lastPath as string, fragTypes);
          if (delta !== null) deltas.push(delta);
          continue;
        }

        // ── Skip known non-content ops ──
        if (json.o === 'SET' || json.o === 'BATCH') continue;

        // ── Unmatched data line — log for diagnosis ──
        if (parseState.debug) {
          const count = (parseState._unmatched as number) + 1;
          parseState._unmatched = count;
          if (count <= 20) {
            console.log(`[GhostContext] 🔎 Unmatched data #${count}:`, JSON.stringify(json).slice(0, 300));
          }
        }
      } catch { /* partial JSON, skip */ }
    }
    return deltas;
  },

  /** Resolve an APPEND value against a path, filtering THINK fragments */
  _resolveAppend(value: string, path: string, fragTypes: Map<number, string>): string | null {
    const idxMatch = path.match(/fragments\/(-?\d+)\/content/);
    if (idxMatch) {
      let idx = parseInt(idxMatch[1], 10);
      if (idx < 0) idx = fragTypes.size + idx;
      const type = fragTypes.get(idx);
      if (type === 'THINK') return null;
    }
    return value;
  },

  /* ── DOM cleanup ───────────────────────────────────── */

  cleanDOM(root: Element): void {
    const mainOpen = `<${MAIN_TAG}>`;
    const mainClose = `</${MAIN_TAG}>`;
    const userOpen = `<${USER_INPUT_TAG}>`;
    const userClose = `</${USER_INPUT_TAG}>`;
    const respOpen = `<${RESP_TAG}>`;
    const respClose = `</${RESP_TAG}>`;
    const infoOpen = `<${INFO_CTRL_TAG}>`;
    const infoClose = `</${INFO_CTRL_TAG}>`;

    // ── Strategy A: Element-level cleanup ──
    // When the markdown renderer parses ghost-ml tags as real HTML custom elements,
    // they won't appear in text nodes. Handle them by direct querySelectorAll.
    cleanGhostElements(root);

    // ── Strategy B: Text-node-level cleanup ──
    // When ghost-ml tags appear as literal text (not parsed as HTML).
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const hitNodes: Text[] = [];

    while (walker.nextNode()) {
      const tn = walker.currentNode as Text;
      const val = tn.nodeValue || '';
      if (val.includes('ghost-ml')) {
        hitNodes.push(tn);
      }
    }

    if (hitNodes.length === 0) return;

    const processed = new Set<HTMLElement>();

    for (const tn of hitNodes) {
      let el = tn.parentElement;
      while (el && el !== document.body) {
        if (processed.has(el)) break;

        const text = el.textContent || '';

        // Request-side injection: <main-ghost-ml>...<origin-user-input-ghost-ml>
        if (text.includes(mainOpen) && text.includes(mainClose)) {
          replaceInjectionKeepUserInput(el, mainOpen, mainClose, userOpen, userClose);
          el.dataset.ghostCleaned = 'true';
          processed.add(el);
          break;
        }

        // Response-side: strip <model-response-ghost-ml> wrapper + remove <info-control-ghost-ml> block
        if (text.includes(respOpen) || text.includes(infoOpen)) {
          cleanResponseTags(el, respOpen, respClose, infoOpen, infoClose);
          el.dataset.ghostCleaned = 'true';
          processed.add(el);
          break;
        }

        if (isBlockContainer(el)) break;
        el = el.parentElement;
      }
    }
  },
};

/**
 * Strip the <main-ghost-ml>...</main-ghost-ml> block and the
 * <origin-user-input-ghost-ml></origin-user-input-ghost-ml> wrapper tags,
 * keeping only the user's original input text.
 */
function replaceInjectionKeepUserInput(
  container: HTMLElement,
  mainOpen: string,
  mainClose: string,
  userOpen: string,
  userClose: string,
) {
  // Work on textContent (DeepSeek renders user messages as plain text)
  let text = container.textContent || '';

  // 1. Remove the entire <main-ghost-ml>...</main-ghost-ml> block
  const mStart = text.indexOf(mainOpen);
  const mEnd = text.indexOf(mainClose);
  if (mStart !== -1 && mEnd !== -1) {
    text = text.slice(0, mStart) + text.slice(mEnd + mainClose.length);
  }

  // 2. Remove the wrapper tags but keep content inside
  text = text.replace(userOpen, '').replace(userClose, '');

  // 3. Trim leading/trailing whitespace
  text = text.trim();

  // 4. Apply back
  container.textContent = text;
}

/**
 * Clean model response text nodes:
 *  - Strip <model-response-ghost-ml> wrapper tags (keep content)
 *  - Remove <info-control-ghost-ml>...</info-control-ghost-ml> block content
 *
 * Simple per-text-node regex approach. For the cross-node case
 * (tags split across DOM nodes), CSS `display:none` on the custom
 * elements handles it — this is the fallback for escaped-text rendering.
 */
function cleanResponseTags(
  container: HTMLElement,
  respOpen: string,
  respClose: string,
  infoOpen: string,
  infoClose: string,
) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) {
    const tn = walker.currentNode as Text;
    if (tn.nodeValue?.includes('ghost-ml')) {
      nodes.push(tn);
    }
  }

  for (const tn of nodes) {
    let val = tn.nodeValue || '';

    // Remove complete info-control block if fully within this text node
    const re = new RegExp(
      escapeForRegex(infoOpen) + '[\\s\\S]*?' + escapeForRegex(infoClose),
      'g',
    );
    val = val.replace(re, '');

    // Strip individual ghost-ml tags (opening and closing)
    val = val
      .replace(new RegExp(escapeForRegex(respOpen), 'g'), '')
      .replace(new RegExp(escapeForRegex(respClose), 'g'), '')
      .replace(new RegExp(escapeForRegex(infoOpen), 'g'), '')
      .replace(new RegExp(escapeForRegex(infoClose), 'g'), '')
      .replace(/<\/?need-update-ghost-ml>/g, '')
      .replace(/<\/?updated-user-bio-ghost-ml>/g, '');

    tn.nodeValue = val;
  }

  // Remove text nodes that became empty or only whitespace
  for (const tn of nodes) {
    if (tn.parentNode && tn.nodeValue?.trim() === '') {
      tn.remove();
    }
  }
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isBlockContainer(el: HTMLElement): boolean {
  const tag = el.tagName;
  return /^(ARTICLE|SECTION|MAIN|LI|TR|TBODY|TABLE|FORM)$/i.test(tag) ||
    el.getAttribute('role') === 'article' ||
    el.classList.contains('message') ||
    el.classList.contains('chat-message');
}

/**
 * Element-level cleanup: when the markdown renderer parses ghost-ml tags
 * as real HTML custom elements (not text), they live in the DOM as actual
 * `<info-control-ghost-ml>`, `<model-response-ghost-ml>` etc.
 *
 * Strategy:
 *  - Remove entire info-control, need-update, updated-bio elements
 *  - Unwrap model-response (keep inner content, remove wrapper element)
 *  - Also remove main-ghost-ml wrapper on request side
 */
function cleanGhostElements(root: Element): void {
  // Remove info-control block and its children entirely
  const removeSelectors = [
    INFO_CTRL_TAG,
    NEED_UPDATE_TAG,
    UPDATED_BIO_TAG,
  ].join(',');

  for (const el of root.querySelectorAll(removeSelectors)) {
    el.remove();
  }

  // Unwrap model-response wrapper (keep rendered response content)
  for (const el of root.querySelectorAll(RESP_TAG)) {
    const parent = el.parentNode;
    if (!parent) continue;
    while (el.firstChild) {
      parent.insertBefore(el.firstChild, el);
    }
    el.remove();
  }

  // Unwrap request-side tags: main-ghost-ml (remove entirely — content already handled)
  // user-input wrapper (unwrap — keep content)
  for (const el of root.querySelectorAll(MAIN_TAG)) {
    el.remove();
  }
  for (const el of root.querySelectorAll(USER_INPUT_TAG)) {
    const parent = el.parentNode;
    if (!parent) continue;
    while (el.firstChild) {
      parent.insertBefore(el.firstChild, el);
    }
    el.remove();
  }
}
