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
  '*://qianwen.com/*',
  '*://www.qianwen.com/*',
];

export default defineContentScript({
  matches: SCRIPT_MATCHES,
  world: 'MAIN',
  runAt: 'document_start',

  main() {
    const adapter: PlatformAdapter = getAdapterForHost(window.location.hostname);
    const sniffEnabled = [
      'chat.qwen.ai',
      'tongyi.aliyun.com',
      'tongyi.com',
      'qianwen.com',
      'www.qianwen.com',
    ].includes(window.location.hostname);

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

    function shortText(input: string, max = 400): string {
      const singleLine = input.replace(/\s+/g, ' ').trim();
      return singleLine.length > max ? `${singleLine.slice(0, max)}…` : singleLine;
    }

    function sniffLog(title: string, extra?: unknown) {
      if (!sniffEnabled) return;
      if (extra === undefined) {
        console.log(`[Qianyi][Sniff] ${title}`);
      } else {
        console.log(`[Qianyi][Sniff] ${title}`, extra);
      }
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

    async function extractRawBodyText(body: BodyInit | null | undefined): Promise<string | undefined> {
      if (!body) return undefined;
      if (typeof body === 'string') return body;
      if (body instanceof Blob) return await body.text();
      if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
        return new TextDecoder().decode(body);
      }
      if (body instanceof URLSearchParams) return body.toString();
      return undefined;
    }

    async function extractFetchBody(
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<{ body?: Record<string, unknown>; source: 'init' | 'request' | 'none' }> {
      if (init?.body) {
        const parsed = await extractBody(init.body);
        return { body: parsed, source: parsed ? 'init' : 'none' };
      }

      if (input instanceof Request) {
        const method = (input.method || 'GET').toUpperCase();
        if (method === 'GET' || method === 'HEAD') return { source: 'none' };

        try {
          const text = await input.clone().text();
          if (!text) return { source: 'none' };
          return { body: JSON.parse(text), source: 'request' };
        } catch {
          return { source: 'none' };
        }
      }

      return { source: 'none' };
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
        const method = (
          init?.method
          || (input instanceof Request ? input.method : 'GET')
          || 'GET'
        ).toUpperCase();

        if (sniffEnabled) {
          let bodyText: string | undefined;
          if (init?.body) {
            bodyText = await extractRawBodyText(init.body);
          } else if (input instanceof Request) {
            try {
              bodyText = await input.clone().text();
            } catch {
              bodyText = undefined;
            }
          }
          sniffLog(`FETCH ${method} ${url}`);
          if (bodyText) {
            try {
              const parsed = JSON.parse(bodyText) as Record<string, unknown>;
              sniffLog('FETCH body keys', Object.keys(parsed));
            } catch {
              sniffLog('FETCH body preview', shortText(bodyText));
            }
          }
        }

        if (ctx && ctx.mode !== 'off' && !isContextEmpty(ctx)) {
          const extracted = await extractFetchBody(input, init);
          const body = extracted.body;

          const interceptable = !!(body && adapter.shouldIntercept(url, body));
          if (sniffEnabled && body) {
            sniffLog(`FETCH interceptable=${interceptable} injectable=${shouldInject(body)}`);
            if (!interceptable) {
              sniffLog('FETCH adapter miss keys', Object.keys(body));
            }
          }

          if (body && interceptable && shouldInject(body)) {
            const modified = adapter.modifyRequestBody(body, ctx);

            if (extracted.source === 'request' && input instanceof Request && !init?.body) {
              input = new Request(input, { body: JSON.stringify(modified) });
            } else {
              init = { ...init, body: JSON.stringify(modified) };
            }

            recordInjection(body);

            console.log('[Qianyi] ✅ Intercepted:', url, `[${ctx.mode}]`);
          }
        } else if (ctx && ctx.mode === 'time') {
          // Time-only mode
          if (!adapter.capabilities.knowsCurrentTime) {
            const extracted = await extractFetchBody(input, init);
            const body = extracted.body;
            if (body && adapter.shouldIntercept(url, body)) {
              const modified = adapter.modifyRequestBodyTimeOnly(body);
              if (modified) {
                if (extracted.source === 'request' && input instanceof Request && !init?.body) {
                  input = new Request(input, { body: JSON.stringify(modified) });
                } else {
                  init = { ...init, body: JSON.stringify(modified) };
                }

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
        if (sniffEnabled) {
          sniffLog(`XHR SEND ${url}`);
        }

        // Check if this is a chat completion request
        let isChatRequest = false;
        let parsed: Record<string, unknown> | undefined;

        if (typeof body === 'string') {
          try {
            parsed = JSON.parse(body);
          } catch { /* not JSON */ }

          if (parsed && adapter.shouldIntercept(url, parsed)) {
            isChatRequest = true;
            if (sniffEnabled) {
              sniffLog('XHR body keys', Object.keys(parsed));
            }
          } else if (sniffEnabled && parsed) {
            sniffLog('XHR adapter miss keys', Object.keys(parsed));
          }
        }

        if (sniffEnabled && typeof body === 'string' && !parsed) {
          sniffLog('XHR non-JSON body preview', shortText(body));
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

    /* ── WebSocket interception (for sites using ws transport) ── */
    const _wsSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      try {
        if (sniffEnabled) {
          sniffLog(`WS SEND type=${typeof data}`);
        }

        if (typeof data === 'string' && ctx) {
          let parsed: Record<string, unknown> | undefined;
          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = undefined;
          }

          if (sniffEnabled) {
            if (parsed) sniffLog('WS body keys', Object.keys(parsed));
            else sniffLog('WS body preview', shortText(data));
          }

          if (parsed && adapter.shouldIntercept(window.location.href, parsed)) {
            if (ctx.mode !== 'off' && !isContextEmpty(ctx) && shouldInject(parsed)) {
              const modified = adapter.modifyRequestBody(parsed, ctx);
              recordInjection(parsed);
              console.log('[Qianyi] ✅ Intercepted (WS):', adapter.name, `[${ctx.mode}]`);
              return _wsSend.call(this, JSON.stringify(modified));
            }

            if (ctx.mode === 'time' && !adapter.capabilities.knowsCurrentTime) {
              const modified = adapter.modifyRequestBodyTimeOnly(parsed);
              if (modified) {
                console.log('[Qianyi] ✅ Intercepted time-only (WS):', adapter.name);
                return _wsSend.call(this, JSON.stringify(modified));
              }
            }
          }
          if (sniffEnabled && parsed && !adapter.shouldIntercept(window.location.href, parsed)) {
            sniffLog('WS adapter miss keys', Object.keys(parsed));
          }
        }
      } catch (err) {
        console.error('[Qianyi] WebSocket override error (pass-through):', err);
      }

      return _wsSend.call(this, data as never);
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

    console.log(`[Qianyi] 🚀 Interceptors installed (${adapter.name}, fetch + XHR + WS)`);
  },
});
