/**
 * Platform capability flags.
 * Declares what a platform natively supports — controls what we inject.
 */
export interface PlatformCapabilities {
  /** Platform already provides current datetime to the model */
  knowsCurrentTime: boolean;
}

/**
 * Platform adapter interface.
 *
 * Each target website (DeepSeek, Kimi, Qwen, …) implements this interface
 * to encapsulate platform-specific interception, SSE parsing, and DOM cleaning.
 */
export interface PlatformAdapter {
  /** Unique adapter id */
  id: string;

  /** Human-readable name */
  name: string;

  /** URL match patterns (used in manifest & content script registration) */
  matchPatterns: string[];

  /** Platform capability declarations */
  capabilities: PlatformCapabilities;

  /**
   * Determine whether a fetch/XHR request should be intercepted.
   * @param url   Request URL
   * @param body  Parsed JSON body (undefined if not JSON)
   */
  shouldIntercept(url: string, body?: Record<string, unknown>): boolean;

  /**
   * Modify the parsed request body to wrap user input with injection.
   * @param body  Parsed JSON body
   * @param ctx   Resolved injection context (mode, identity, persona)
   */
  modifyRequestBody(
    body: Record<string, unknown>,
    ctx: import('../profile').InjectionContext,
  ): Record<string, unknown>;

  /**
   * Modify the request body with time-only injection (when mode is 'time' or fallback).
   * Returns null if the platform already knows the time (no modification needed).
   */
  modifyRequestBodyTimeOnly(
    body: Record<string, unknown>,
  ): Record<string, unknown> | null;

  /**
   * Extract text content deltas from a raw SSE chunk.
   * Each platform has its own SSE format (OpenAI-style, JSON-patch, etc.).
   *
   * @param sseChunk    Raw SSE text from xhr.responseText delta
   * @param parseState  Shared mutable state for handling partial lines, fragment tracking, etc.
   *                    Initialized as `{ partial: '' }`, adapter can extend with extra fields.
   * @returns Array of text deltas extracted from this chunk
   */
  extractContentDeltas(
    sseChunk: string,
    parseState: Record<string, unknown> & { partial: string },
  ): string[];

  /**
   * Remove injection traces from a DOM subtree.
   * Called on initial load and on every DOM mutation.
   */
  cleanDOM(root: Element): void;
}
