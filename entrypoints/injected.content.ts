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
import { GhostMLFilter, stripGhostML } from '../lib/response-filter';
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
      let wasInjected = false;
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
            if (sniffEnabled) {
              let applied = false;
              try {
                applied = JSON.stringify(modified).includes('<main-ghost-ml>');
              } catch {
                applied = false;
              }
              sniffLog(`FETCH injectionApplied=${applied}`);
            }

            if (extracted.source === 'request' && input instanceof Request && !init?.body) {
              input = new Request(input, { body: JSON.stringify(modified) });
            } else {
              init = { ...init, body: JSON.stringify(modified) };
            }

            recordInjection(body);

            console.log('[Qianyi] ✅ Intercepted:', url, `[${ctx.mode}]`);
            wasInjected = true;
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

      const response = await _fetch.call(this, input, init);
      try {
        return filterFetchResponse(response, wasInjected);
      } catch {
        return response;
      }
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
            if (sniffEnabled) {
              let applied = false;
              try {
                applied = JSON.stringify(modified).includes('<main-ghost-ml>');
              } catch {
                applied = false;
              }
              sniffLog(`XHR injectionApplied=${applied}`);
            }
            recordInjection(parsed);
            console.log('[Qianyi] ✅ Intercepted (XHR):', url, `[${ctx!.mode}]`);
            setupResponseFilter(this);
            return _xhrSend.call(this, JSON.stringify(modified));
          } else if (ctx && ctx.mode === 'time' && !adapter.capabilities.knowsCurrentTime) {
            // Time-only mode
            const modified = adapter.modifyRequestBodyTimeOnly(parsed);
            if (modified) {
              return _xhrSend.call(this, JSON.stringify(modified));
            }
          }

          // Chat request but no injection (frequency control / mode skip)
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
              if (sniffEnabled) {
                let applied = false;
                try {
                  applied = JSON.stringify(modified).includes('<main-ghost-ml>');
                } catch {
                  applied = false;
                }
                sniffLog(`WS injectionApplied=${applied}`);
              }
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

    /* ── Response filtering ── */

    /**
     * Filter a fetch Response to strip ghost-ml from the body.
     *
     * Track 1 (wasInjected): SSE stream — adapter-specific rewriting with
     *         GhostMLFilter for info-control extraction + content stripping.
     * Track 2 (all other JSON): lightweight regex strip for history data.
     */
    function filterFetchResponse(response: Response, wasInjected: boolean): Response {
      if (!response.body || !response.ok) return response;

      const ct = response.headers.get('content-type') || '';

      // Track 1: SSE stream filtering for injected requests
      if (wasInjected || ct.includes('event-stream')) {
        return wrapSSEFilter(response);
      }

      // Track 2: JSON / NDJSON responses only (conversation history on refresh).
      // Narrow scope: only buffer-and-strip responses that are likely to carry
      // stored conversation data. JS/CSS/HTML/images pass through untouched.
      if (ct.includes('json')) {
        return wrapTextFilter(response);
      }

      return response;
    }

    /** Wrap a streaming SSE Response with adapter-specific ghost-ml rewriting. */
    function wrapSSEFilter(response: Response): Response {
      const filter = new GhostMLFilter();
      const state: Record<string, unknown> & { partial: string } = { partial: '' };
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let infoReported = false;

      const ts = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          const text = decoder.decode(chunk, { stream: true });
          let rewritten = adapter.rewriteSSEChunk(text, (d) => filter.feed(d), state);

          // Safety net: if adapter-level SSE parsing missed ghost-ml
          // (e.g. non-standard SSE format, content in unexpected field),
          // fall back to text-level regex stripping.
          if (rewritten.includes('ghost-ml')) {
            rewritten = stripGhostML(rewritten);
          }

          if (rewritten) controller.enqueue(encoder.encode(rewritten));

          if (!infoReported && filter.infoControl) {
            infoReported = true;
            window.postMessage({ type: MSG.INFO_CONTROL, data: filter.infoControl }, '*');
          }
        },
        flush(controller) {
          // Flush remaining partial line from SSE state
          if (state.partial) {
            const last = adapter.rewriteSSEChunk('\n', (d) => filter.feed(d), state);
            if (last) controller.enqueue(encoder.encode(last));
          }

          const rest = filter.flush();
          if (rest) controller.enqueue(encoder.encode(rest));

          if (!infoReported && filter.infoControl) {
            window.postMessage({ type: MSG.INFO_CONTROL, data: filter.infoControl }, '*');
          }
        },
      });

      const headers = new Headers(response.headers);
      headers.delete('content-length');

      return new Response(response.body!.pipeThrough(ts), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    /**
     * Wrap a text-like Response: buffer full body, apply stripGhostML, re-emit.
     * Handles cross-chunk ghost-ml blocks that per-chunk regex misses.
     * History JSON is finite-sized; full buffering is safe.
     */
    function wrapTextFilter(response: Response): Response {
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      const chunks: string[] = [];

      const ts = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk) {
          chunks.push(decoder.decode(chunk, { stream: true }));
        },
        flush(controller) {
          let fullText = chunks.join('') + decoder.decode();
          if (fullText.includes('ghost-ml')) {
            fullText = stripGhostML(fullText);
          }
          controller.enqueue(encoder.encode(fullText));
        },
      });

      const headers = new Headers(response.headers);
      headers.delete('content-length');

      return new Response(response.body!.pipeThrough(ts), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    /**
     * Override XHR responseText getter to return filtered content.
     * Used for injected XHR requests (platforms that use XHR for streaming).
     */
    function setupResponseFilter(xhr: XMLHttpRequest) {
      const filter = new GhostMLFilter();
      const state: Record<string, unknown> & { partial: string } = { partial: '' };
      const origDesc = Object.getOwnPropertyDescriptor(
        XMLHttpRequest.prototype, 'responseText',
      );

      if (!origDesc?.get) return; // Can't override — fall back to DOM cleanup

      let lastLen = 0;
      let filtered = '';
      let infoReported = false;
      let flushed = false;

      Object.defineProperty(xhr, 'responseText', {
        get() {
          const orig: string = origDesc.get!.call(this);
          if (orig.length > lastLen) {
            const chunk = orig.slice(lastLen);
            lastLen = orig.length;
            filtered += adapter.rewriteSSEChunk(chunk, (d) => filter.feed(d), state);
            if (!infoReported && filter.infoControl) {
              infoReported = true;
              window.postMessage({ type: MSG.INFO_CONTROL, data: filter.infoControl }, '*');
            }
          }
          return filtered;
        },
        configurable: true,
      });

      // Also shadow 'response' for text/default responseType
      const respDesc = Object.getOwnPropertyDescriptor(
        XMLHttpRequest.prototype, 'response',
      );
      if (respDesc?.get) {
        Object.defineProperty(xhr, 'response', {
          get() {
            if (!this.responseType || this.responseType === 'text') {
              return this.responseText;
            }
            return respDesc.get!.call(this);
          },
          configurable: true,
        });
      }

      xhr.addEventListener('loadend', () => {
        if (flushed) return;
        flushed = true;
        // Trigger final processing via getter
        void xhr.responseText; // eslint-disable-line @typescript-eslint/no-unused-expressions
        const rest = filter.flush();
        if (rest) filtered += rest;
        if (!infoReported && filter.infoControl) {
          window.postMessage({ type: MSG.INFO_CONTROL, data: filter.infoControl }, '*');
        }
      });
    }

    console.log(`[Qianyi] 🚀 Interceptors installed (${adapter.name}, fetch + XHR + WS)`);
  },
});
