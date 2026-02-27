/**
 * MAIN-world content script — runs in the page's JS context.
 *
 * Responsibilities:
 *   1. Override window.fetch & XMLHttpRequest to intercept outgoing chat requests
 *   2. Prepend user profile injection block to the message payload
 *
 * Communication:
 *   Receives profile data from the ISOLATED-world content script via postMessage.
 *   Cannot access browser.storage directly (page context has no extension APIs).
 */

import { deepseekAdapter } from '../lib/adapters/deepseek';
import { isProfileEmpty } from '../lib/profile';
import { MSG, DEFAULT_REINJECT_INTERVAL } from '../lib/constants';
import { StreamParser } from '../lib/stream-parser';
import type { UserProfile } from '../lib/profile';
import type { PlatformAdapter } from '../lib/adapters/types';

export default defineContentScript({
  matches: ['*://chat.deepseek.com/*'],
  world: 'MAIN',
  runAt: 'document_start',

  main() {
    console.log('[GhostContext] 🚀 MAIN world script executing...');

    const adapter: PlatformAdapter = deepseekAdapter;

    let profile: UserProfile | null = null;
    let enabled = true;
    let debug = false;
    let reinjectInterval = DEFAULT_REINJECT_INTERVAL;

    /**
     * Injection frequency control.
     * Tracks per-session: which turn we last injected at.
     * Key = chat_session_id, Value = parent_message_id at injection time.
     */
    const injectionLog = new Map<string, number>();

    /** Decide whether this request needs injection */
    function shouldInject(body: Record<string, unknown>): boolean {
      const sessionId = body.chat_session_id as string | undefined;
      const parentId = (body.parent_message_id as number) ?? 0;

      if (!sessionId) {
        // Can't identify session — inject to be safe
        return true;
      }

      const lastInjectedAt = injectionLog.get(sessionId);

      if (lastInjectedAt === undefined) {
        // New session — always inject
        if (debug) console.log('[GhostContext] New session detected:', sessionId.slice(0, 8));
        return true;
      }

      if (reinjectInterval === 0) {
        // 0 = only inject on new session
        if (debug) console.log('[GhostContext] Skip: interval=0, already injected in this session');
        return false;
      }

      const turnsSince = parentId - lastInjectedAt;
      if (turnsSince >= reinjectInterval * 2) {
        // parentId increments by 2 per round (user + assistant)
        if (debug) console.log(`[GhostContext] Re-inject: ${turnsSince / 2} turns since last injection`);
        return true;
      }

      if (debug) console.log(`[GhostContext] Skip: only ${turnsSince / 2} turns since last injection`);
      return false;
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

    /* ── Receive profile from isolated world ── */
    window.addEventListener('message', (e) => {
      if (e.source !== window) return;
      if (e.data?.type !== MSG.PROFILE_UPDATE) return;

      profile = e.data.profile ?? null;
      enabled = e.data.enabled ?? true;
      debug = e.data.debug ?? false;
      reinjectInterval = e.data.reinjectInterval ?? DEFAULT_REINJECT_INTERVAL;

      console.log('[GhostContext] Profile received:', profile?.bio?.slice(0, 20) || '(empty)', '| enabled:', enabled, '| debug:', debug);
    });

    /* ── Fetch interception ── */
    const _fetch = window.fetch;

    window.fetch = async function (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      try {
        const url = getUrl(input);

        // Debug: log all API calls
        if (debug && url.includes('/api')) {
          console.log('[GhostContext] 🔍 fetch:', url);
        }

        if (enabled && profile && !isProfileEmpty(profile) && init?.body) {
          const body = await extractBody(init.body);

          if (body && adapter.shouldIntercept(url, body) && shouldInject(body)) {
            const modified = adapter.modifyRequestBody(body, profile);
            init = { ...init, body: JSON.stringify(modified) };
            recordInjection(body);

            console.log('[GhostContext] ✅ Intercepted:', url);
            if (debug) {
              console.log('[GhostContext] Modified prompt with ghost-ml wrapper');
            }
          }
        } else if (init?.body) {
          // Disabled: inject time only (if platform doesn't know it)
          if (!adapter.capabilities.knowsCurrentTime) {
            const body = await extractBody(init.body);
            if (body && adapter.shouldIntercept(url, body)) {
              const modified = adapter.modifyRequestBodyTimeOnly(body);
              if (modified) {
                init = { ...init, body: JSON.stringify(modified) };
                if (debug) console.log('[GhostContext] ⏰ Time-only injection');
              }
            }
          }
        }
      } catch (err) {
        console.error('[GhostContext] Fetch override error (pass-through):', err);
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

        if (debug && url.includes('/api')) {
          console.log('[GhostContext] 🔍 XHR:', url);
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
          }
        }

        // Determine injection type and set up response monitor
        if (isChatRequest && parsed) {
          const hasProfile = !!(enabled && profile && !isProfileEmpty(profile));

          if (hasProfile && shouldInject(parsed)) {
            // Full injection
            const modified = adapter.modifyRequestBody(parsed, profile);
            recordInjection(parsed);
            console.log('[GhostContext] ✅ Intercepted (XHR):', url);
            setupResponseMonitor(this, true);
            return _xhrSend.call(this, JSON.stringify(modified));
          } else if (!hasProfile && !adapter.capabilities.knowsCurrentTime) {
            // Profile empty/disabled — time-only injection
            const modified = adapter.modifyRequestBodyTimeOnly(parsed);
            if (modified) {
              if (debug) console.log('[GhostContext] ⏰ Time-only injection (XHR)');
              setupResponseMonitor(this, false);
              return _xhrSend.call(this, JSON.stringify(modified));
            }
          }

          // Chat request but no injection (frequency control / profile available but skipped)
          setupResponseMonitor(this, false);
        }
      } catch (err) {
        console.error('[GhostContext] XHR override error (pass-through):', err);
      }

      return _xhrSend.call(this, body);
    };

    /**
     * Attach progress/loadend listeners to an intercepted XHR
     * to parse the SSE response stream for info-control blocks.
     */
    let monitorCount = 0;
    function setupResponseMonitor(xhr: XMLHttpRequest, injected: boolean) {
      const monitorId = ++monitorCount;
      const parser = new StreamParser();
      const parseState: Record<string, unknown> & { partial: string } = { partial: '', debug };
      let lastLength = 0;
      let reported = false;
      let totalChunks = 0;
      let totalDeltas = 0;

      if (debug) {
        console.log(`[GhostContext] 🔊 Monitor #${monitorId} attached | injected: ${injected}`);
      }

      xhr.addEventListener('progress', () => {
        try {
          const full = xhr.responseText;
          if (full.length <= lastLength) return;

          const chunk = full.slice(lastLength);
          lastLength = full.length;
          totalChunks++;

          // Debug: log first 10 raw SSE chunks
          if (debug && totalChunks <= 10) {
            console.log(`[GhostContext] 📡 [M${monitorId}] SSE chunk #${totalChunks - 1}:`, chunk.slice(0, 500));
          }

          const deltas = adapter.extractContentDeltas(chunk, parseState);

          if (deltas.length > 0) {
            totalDeltas += deltas.length;
            if (debug && totalDeltas <= 10) {
              console.log(`[GhostContext] 📝 [M${monitorId}] Deltas (${deltas.length}):`, deltas.map(d => d.slice(0, 50)).join(' | '));
            }
          }

          for (const delta of deltas) {
            const result = parser.feed(delta);
            if (result && !reported) {
              reported = true;
              if (debug) console.log('[GhostContext] 📦 Info-control extracted:', result);
              window.postMessage({ type: MSG.INFO_CONTROL, data: result }, '*');
            }
          }
        } catch (err) {
          if (debug) console.error('[GhostContext] Response monitor error:', err);
        }
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
          if (debug) console.log('[GhostContext] 📦 Info-control extracted (final):', result);
          window.postMessage({ type: MSG.INFO_CONTROL, data: result }, '*');
        }

        if (debug) {
          const fragTypes = parseState.fragmentTypes as Map<number, string> | undefined;
          const fragObj = fragTypes ? Object.fromEntries(fragTypes) : {};
          console.log(
            `[GhostContext] 📊 [M${monitorId}] Summary:`,
            `\n  injected: ${injected}`,
            `\n  xhr.status: ${xhr.status}`,
            `\n  totalChunks: ${totalChunks}`,
            `\n  totalDeltas: ${totalDeltas}`,
            `\n  fragmentTypes:`, fragObj,
            `\n  accumulatedText: ${parser.text.length} chars`,
            `\n  infoControlFound: ${!!result}`,
            parser.text.length > 0 ? `\n  lastText: ...${parser.text.slice(-200)}` : '',
          );
        }

        if (debug && injected && !result) {
          console.warn('[GhostContext] ⚠️  Injected but no info-control block found — model may have ignored the template.');
        }
      });
    }

    console.log('[GhostContext] 🚀 Interceptors installed (fetch + XHR)');
  },
});
