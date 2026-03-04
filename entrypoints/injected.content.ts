/**
 * MAIN-world content script — runs in the page's JS context.
 *
 * Responsibilities:
 *   1. Override window.fetch & XMLHttpRequest to intercept outgoing chat requests
 *   2. Inject context (identity + persona + time) into the message payload
 *   3. Parse SSE response stream for info-control blocks
 *
 * Communication:
 *   Receives InjectionContext from the ISOLATED-world content script via postMessage.
 *   Cannot access browser.storage directly (page context has no extension APIs).
 */

import { getAdapterForHost } from '../lib/adapters';
import { isContextEmpty } from '../lib/profile';
import { MSG } from '../lib/constants';
import { StreamParser } from '../lib/stream-parser';
import type { InjectionContext } from '../lib/profile';
import type { PlatformAdapter } from '../lib/adapters/types';

const SCRIPT_MATCHES = [
  '*://chat.deepseek.com/*',
  '*://gemini.google.com/*',
  '*://aistudio.google.com/*',
  '*://kimi.moonshot.cn/*',
  '*://chat.qwen.ai/*',
  '*://tongyi.aliyun.com/*',
  '*://tongyi.com/*',
];

export default defineContentScript({
  matches: SCRIPT_MATCHES,
  world: 'MAIN',
  runAt: 'document_start',

  main() {
    const adapter: PlatformAdapter = getAdapterForHost(window.location.hostname);

    let ctx: InjectionContext | null = null;

    /**
     * Injection frequency control.
     * Tracks per-session: which turn we last injected at.
     * Key = chat_session_id, Value = parent_message_id at injection time.
     */
    const injectionLog = new Map<string, number>();

    /** Decide whether this request needs injection */
    function shouldInject(body: Record<string, unknown>): boolean {
      if (!ctx || ctx.mode === 'off') return false;

      const reinjectInterval = ctx.reinjectInterval;
      const sessionId = body.chat_session_id as string | undefined;
      const parentId = (body.parent_message_id as number) ?? 0;

      if (!sessionId) return true;

      const lastInjectedAt = injectionLog.get(sessionId);

      if (lastInjectedAt === undefined) return true;

      if (reinjectInterval === 0) return false;

      const turnsSince = parentId - lastInjectedAt;
      return turnsSince >= reinjectInterval * 2;
    }

    /** Record that we injected for this session */
    function recordInjection(body: Record<string, unknown>) {
      const sessionId = body.chat_session_id as string | undefined;
      const parentId = (body.parent_message_id as number) ?? 0;
      if (sessionId) {
        injectionLog.set(sessionId, parentId);
      }
    }

    /* ── Helpers ── */

    function getUrl(input: RequestInfo | URL): string {
      if (typeof input === 'string') return input;
      if (input instanceof URL) return input.href;
      return (input as Request).url;
    }

    /** Extract JSON body from various BodyInit types */
    async function extractBody(
      body: BodyInit | null | undefined,
    ): Promise<Record<string, unknown> | undefined> {
      if (!body) return undefined;
      let text: string | undefined;
      if (typeof body === 'string') {
        text = body;
      } else if (body instanceof Blob) {
        text = await body.text();
      } else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
        text = new TextDecoder().decode(body);
      } else if (body instanceof URLSearchParams) {
        text = body.toString();
      }
      if (!text) return undefined;
      try {
        return JSON.parse(text);
      } catch {
        return undefined;
      }
    }

    /* ── Receive context from isolated world ── */
    window.addEventListener('message', (e) => {
      if (e.source !== window) return;
      if (e.data?.type !== MSG.PROFILE_UPDATE) return;

      ctx = e.data.ctx ?? null;
    });

    /* ── Fetch interception ── */
    const _fetch = window.fetch;

    window.fetch = async function (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      try {
        const url = getUrl(input);

        if (ctx && ctx.mode !== 'off' && !isContextEmpty(ctx) && init?.body) {
          const body = await extractBody(init.body);

          if (body && adapter.shouldIntercept(url, body) && shouldInject(body)) {
            const modified = adapter.modifyRequestBody(body, ctx);
            init = { ...init, body: JSON.stringify(modified) };
            recordInjection(body);

            console.log('[Qianyi] ✅ Intercepted:', url, `[${ctx.mode}]`);
          }
        } else if (ctx && ctx.mode === 'time' && init?.body) {
          // Time-only mode
          if (!adapter.capabilities.knowsCurrentTime) {
            const body = await extractBody(init.body);
            if (body && adapter.shouldIntercept(url, body)) {
              const modified = adapter.modifyRequestBodyTimeOnly(body);
              if (modified) {
                init = { ...init, body: JSON.stringify(modified) };

              }
            }
          }
        }
      } catch (err) {
        console.error('[Qianyi] Fetch override error (pass-through):', err);
      }

      return _fetch.call(this, input, init);
    };

    /* ── XHR interception (fallback) ── */
    const _xhrOpen = XMLHttpRequest.prototype.open;
    const _xhrSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: any[]) {
      (this as any).__ghostUrl = typeof url === 'string' ? url : url.href;
      return _xhrOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
      try {
        const url: string = (this as any).__ghostUrl || '';

        // Check if this is a chat completion request
        let isChatRequest = false;
        let parsed: Record<string, unknown> | undefined;

        if (typeof body === 'string') {
          try {
            parsed = JSON.parse(body);
          } catch { /* not JSON */ }

          if (parsed && adapter.shouldIntercept(url, parsed)) {
            isChatRequest = true;
          }
        }

        // Determine injection type and set up response monitor
        if (isChatRequest && parsed) {
          const canInject = !!(ctx && ctx.mode !== 'off' && !isContextEmpty(ctx));

          if (canInject && shouldInject(parsed)) {
            const modified = adapter.modifyRequestBody(parsed, ctx!);
            recordInjection(parsed);
            console.log('[Qianyi] ✅ Intercepted (XHR):', url, `[${ctx!.mode}]`);
            setupResponseMonitor(this, true);
            return _xhrSend.call(this, JSON.stringify(modified));
          } else if (ctx && ctx.mode === 'time' && !adapter.capabilities.knowsCurrentTime) {
            // Time-only mode
            const modified = adapter.modifyRequestBodyTimeOnly(parsed);
            if (modified) {
              setupResponseMonitor(this, false);
              return _xhrSend.call(this, JSON.stringify(modified));
            }
          }

          // Chat request but no injection (frequency control / mode skip)
          setupResponseMonitor(this, false);
        }
      } catch (err) {
        console.error('[Qianyi] XHR override error (pass-through):', err);
      }

      return _xhrSend.call(this, body);
    };

    /**
     * Attach progress/loadend listeners to an intercepted XHR
     * to parse the SSE response stream for info-control blocks.
     */
    function setupResponseMonitor(xhr: XMLHttpRequest, injected: boolean) {
      const parser = new StreamParser();
      const parseState: Record<string, unknown> & { partial: string } = { partial: '' };
      let lastLength = 0;
      let reported = false;

      xhr.addEventListener('progress', () => {
        try {
          const full = xhr.responseText;
          if (full.length <= lastLength) return;

          const chunk = full.slice(lastLength);
          lastLength = full.length;

          const deltas = adapter.extractContentDeltas(chunk, parseState);

          for (const delta of deltas) {
            const result = parser.feed(delta);
            if (result && !reported) {
              reported = true;
              window.postMessage({ type: MSG.INFO_CONTROL, data: result }, '*');
            }
          }
        } catch { /* ignore parse errors */ }
      });

      xhr.addEventListener('loadend', () => {
        // Final flush: feed any remaining partial line
        if (parseState.partial) {
          const deltas = adapter.extractContentDeltas('\n', parseState);
          for (const delta of deltas) {
            parser.feed(delta);
          }
        }

        const result = parser.extracted;
        if (result && !reported) {
          reported = true;
          window.postMessage({ type: MSG.INFO_CONTROL, data: result }, '*');
        }

        if (injected && !result) {
          console.warn('[Qianyi] ⚠️ No info-control block found — model may have ignored the template.');
        }
      });
    }

    console.log(`[Qianyi] 🚀 Interceptors installed (${adapter.name})`);
  },
});
