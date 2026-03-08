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
  '*://kimi.com/*',
  '*://www.kimi.com/*',
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

        if (ctx && ctx.mode !== 'off' && !isContextEmpty(ctx)) {
          const extracted = await extractFetchBody(input, init);
          const body = extracted.body;

          if (body && adapter.shouldIntercept(url, body) && shouldInject(body)) {
            const modified = adapter.modifyRequestBody(body, ctx);

            if (extracted.source === 'request' && input instanceof Request && !init?.body) {
              input = new Request(input, { body: JSON.stringify(modified) });
            } else {
              init = { ...init, body: JSON.stringify(modified) };
            }

            recordInjection(body);

            console.log('[Qianyi] ✅ Intercepted:', url, `[${ctx.mode}]`);
            wasInjected = true;
          } else if (!body && adapter.shouldInterceptRaw && adapter.modifyRawRequestBody) {
            // Raw body fallback (e.g. Gemini batchexecute via fetch)
            let rawText: string | undefined;
            if (typeof init?.body === 'string') rawText = init.body;
            else if (input instanceof Request) {
              try { rawText = await input.clone().text(); } catch { /* ignore */ }
            }
            if (rawText && adapter.shouldInterceptRaw(url, rawText)) {
              const modified = adapter.modifyRawRequestBody(rawText, ctx);
              if (modified) {
                if (input instanceof Request && !init?.body) {
                  input = new Request(input, { body: modified });
                } else {
                  init = { ...init, body: modified };
                }
                console.log('[Qianyi] ✅ Intercepted (raw):', url, `[${ctx.mode}]`);
                wasInjected = true;
              }
            }
          } else if (!body && adapter.shouldInterceptBinary && adapter.modifyBinaryRequestBody) {
            // Binary body fallback (e.g. Kimi gRPC-Web)
            let binaryBody: Uint8Array | undefined;
            if (init?.body instanceof ArrayBuffer) {
              binaryBody = new Uint8Array(init.body);
            } else if (init?.body && ArrayBuffer.isView(init.body)) {
              binaryBody = new Uint8Array(
                (init.body as ArrayBufferView).buffer,
                (init.body as ArrayBufferView).byteOffset,
                (init.body as ArrayBufferView).byteLength,
              );
            }
            if (binaryBody && adapter.shouldInterceptBinary(url, binaryBody)) {
              const modified = adapter.modifyBinaryRequestBody(binaryBody, ctx);
              if (modified) {
                init = { ...init, body: modified };
                console.log('[Qianyi] \u2705 Intercepted (binary):', url, `[${ctx.mode}]`);
                wasInjected = true;
              }
            }
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

        // Raw body interception (non-JSON, e.g. Gemini batchexecute)
        if (!isChatRequest && typeof body === 'string' && !parsed) {
          if (adapter.shouldInterceptRaw?.(url, body)) {
            const canInject = !!(ctx && ctx.mode !== 'off' && !isContextEmpty(ctx));
            if (canInject) {
              const modified = adapter.modifyRawRequestBody?.(body, ctx!);
              if (modified) {
                console.log('[Qianyi] ✅ Intercepted (XHR raw):', url, `[${ctx!.mode}]`);
                return _xhrSend.call(this, modified);
              }
            }
          }
        }

        // Determine injection type and set up response monitor
        if (isChatRequest && parsed) {
          const canInject = !!(ctx && ctx.mode !== 'off' && !isContextEmpty(ctx));

          if (canInject && shouldInject(parsed)) {
            const modified = adapter.modifyRequestBody(parsed, ctx!);
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
        if (typeof data === 'string' && ctx) {
          let parsed: Record<string, unknown> | undefined;
          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = undefined;
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

      // Connect / gRPC-Web protocol: envelope-level ghost-ml filtering
      if (ct.includes('connect+') || ct.includes('grpc')) {
        return wasInjected ? wrapConnectFilter(response) : response;
      }

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

    /* ── Connect / gRPC-Web envelope frame filter ── */

    /**
     * Filter a Connect streaming response at the envelope frame level.
     *
     * Connect streaming frames: [1B flags][4B big-endian length][JSON payload]
     * We parse each frame's JSON, run GhostMLFilter on `content` string fields
     * only, then re-encode the frame. JSON structure stays intact because
     * the filter never sees raw JSON — only the string value inside `content`.
     *
     * Falls back to pass-through if the first byte isn't a valid Connect flag.
     */
    function wrapConnectFilter(response: Response): Response {
      const filter = new GhostMLFilter();
      let buf = new Uint8Array(0);
      let infoReported = false;
      let passthrough = false;

      const ts = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          if (passthrough) {
            controller.enqueue(chunk);
            return;
          }

          buf = concatBytes(buf, chunk);

          while (buf.length >= 5) {
            const flag = buf[0];
            // Valid Connect flags: 0 (data), 1 (compressed data), 2 (end-of-stream)
            if (flag > 2) {
              passthrough = true;
              controller.enqueue(buf);
              buf = new Uint8Array(0);
              return;
            }

            const payloadLen = (buf[1] << 24) | (buf[2] << 16) | (buf[3] << 8) | buf[4];
            if (payloadLen > 10 * 1024 * 1024) {
              passthrough = true;
              controller.enqueue(buf);
              buf = new Uint8Array(0);
              return;
            }

            if (buf.length < 5 + payloadLen) break; // incomplete frame

            const framePayload = buf.slice(5, 5 + payloadLen);
            buf = buf.slice(5 + payloadLen);

            // End-of-stream frame — pass through unmodified
            if (flag & 0x02) {
              controller.enqueue(connectFrame(flag, framePayload));
              continue;
            }

            // Parse JSON, filter content fields, re-encode
            let outputPayload = framePayload;
            try {
              const text = new TextDecoder().decode(framePayload);
              const json = JSON.parse(text);
              if (filterConnectContent(json, filter)) {
                outputPayload = new TextEncoder().encode(JSON.stringify(json));
              }
            } catch {
              // Unparseable — pass through this frame
            }

            controller.enqueue(connectFrame(flag, outputPayload));

            if (!infoReported && filter.infoControl) {
              infoReported = true;
              window.postMessage({ type: MSG.INFO_CONTROL, data: filter.infoControl }, '*');
            }
          }
        },
        flush(controller) {
          if (buf.length > 0) controller.enqueue(buf);
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

    /** Encode a Connect envelope frame. */
    function connectFrame(flag: number, payload: Uint8Array): Uint8Array {
      const frame = new Uint8Array(5 + payload.length);
      frame[0] = flag;
      frame[1] = (payload.length >> 24) & 0xff;
      frame[2] = (payload.length >> 16) & 0xff;
      frame[3] = (payload.length >> 8) & 0xff;
      frame[4] = payload.length & 0xff;
      frame.set(payload, 5);
      return frame;
    }

    /** Concatenate two Uint8Arrays. */
    function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
      const c = new Uint8Array(a.length + b.length);
      c.set(a);
      c.set(b, a.length);
      return c;
    }

    /**
     * Recursively filter `content` string fields through GhostMLFilter.
     * Only touches fields named `content` — other string fields are left intact,
     * preserving JSON structure even when the filter is in removing mode.
     */
    function filterConnectContent(obj: unknown, filter: GhostMLFilter): boolean {
      if (!obj || typeof obj !== 'object') return false;
      let modified = false;

      if (Array.isArray(obj)) {
        for (const item of obj) {
          if (filterConnectContent(item, filter)) modified = true;
        }
        return modified;
      }

      const record = obj as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        const val = record[key];
        if (typeof val === 'string' && key === 'content') {
          const filtered = filter.feed(val);
          if (filtered !== val) {
            record[key] = filtered;
            modified = true;
          }
        } else if (typeof val === 'object' && val !== null) {
          if (filterConnectContent(val, filter)) modified = true;
        }
      }
      return modified;
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
