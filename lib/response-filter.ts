/**
 * Response-level ghost-ml filtering.
 *
 * Two mechanisms:
 *   1. GhostMLFilter    — stateful streaming filter for LLM content deltas (SSE)
 *   2. stripGhostML     — one-shot regex cleanup for complete text (history JSON)
 *
 * The shared `rewriteStandardSSE` handles OpenAI-compatible, Gemini, and Kimi
 * SSE formats.  DeepSeek's JSON-patch format needs its own adapter implementation.
 */

import {
  INFO_CTRL_TAG, NEED_UPDATE_TAG, UPDATED_BIO_TAG,
  NEED_UPDATE_SOUL_TAG, UPDATED_SOUL_TAG,
} from './constants';

/* ══════════════════════════════════════════
 *  Types
 * ══════════════════════════════════════════ */

export interface InfoControlResult {
  needUpdate: boolean;
  updatedBio?: string;
  needUpdateSoul: boolean;
  updatedSoul?: string;
}

/* ══════════════════════════════════════════
 *  GhostMLFilter — streaming content filter
 * ══════════════════════════════════════════ */

/**
 * Stateful filter for streaming LLM content.
 *
 * Fed token-by-token with content deltas extracted from SSE.
 * Strips ghost-ml tags, removes main-ghost-ml / info-control blocks,
 * and extracts info-control data.
 *
 * States:
 *   normal   — passing through content, stripping unwrap-only tags
 *   removing — inside a block being completely removed
 */
export class GhostMLFilter {
  private buffer = '';
  private state: 'normal' | 'removing' = 'normal';
  private removingTag = '';
  private removedContent = '';
  private _infoControl: InfoControlResult | null = null;

  /** Extracted info-control data (null until the block is fully received). */
  get infoControl(): InfoControlResult | null {
    return this._infoControl;
  }

  /**
   * Feed a content delta from the LLM output stream.
   * Returns the cleaned text to emit (may be empty when content is being removed).
   */
  feed(delta: string): string {
    this.buffer += delta;
    let output = '';

    // eslint-disable-next-line no-labels
    loop: while (this.buffer.length > 0) {
      if (this.state === 'removing') {
        const closeTag = `</${this.removingTag}>`;
        const closeIdx = this.buffer.indexOf(closeTag);

        if (closeIdx !== -1) {
          // Found closing tag — finish removing
          this.removedContent += this.buffer.slice(0, closeIdx);
          this.buffer = this.buffer.slice(closeIdx + closeTag.length);
          if (this.removingTag === 'info-control-ghost-ml') {
            this._infoControl = parseInfoControl(this.removedContent);
          }
          this.state = 'normal';
          this.removingTag = '';
          this.removedContent = '';
          continue;
        }

        // Check for partial closing tag at buffer tail
        for (let i = Math.max(0, this.buffer.length - closeTag.length); i < this.buffer.length; i++) {
          if (closeTag.startsWith(this.buffer.slice(i))) {
            this.removedContent += this.buffer.slice(0, i);
            this.buffer = this.buffer.slice(i);
            // eslint-disable-next-line no-labels
            break loop;
          }
        }

        // No partial match — accumulate all content as removed
        this.removedContent += this.buffer;
        this.buffer = '';
        break;
      }

      // ── Normal state ──

      // Look for ghost-ml opening tag
      const openMatch = this.buffer.match(/<([a-z][a-z-]*-ghost-ml)>/);
      if (openMatch) {
        output += this.buffer.slice(0, openMatch.index!);
        this.buffer = this.buffer.slice(openMatch.index! + openMatch[0].length);
        const tagName = openMatch[1];
        if (tagName === 'main-ghost-ml' || tagName === 'info-control-ghost-ml') {
          this.state = 'removing';
          this.removingTag = tagName;
          this.removedContent = '';
        }
        // Other ghost-ml tags (model-response, origin-user-input): just strip
        continue;
      }

      // Look for orphaned closing ghost-ml tags
      const closeMatch = this.buffer.match(/<\/([a-z][a-z-]*-ghost-ml)>/);
      if (closeMatch) {
        output += this.buffer.slice(0, closeMatch.index!);
        this.buffer = this.buffer.slice(closeMatch.index! + closeMatch[0].length);
        continue;
      }

      // Check for partial tag at tail (unclosed '<')
      const lastLt = this.buffer.lastIndexOf('<');
      if (lastLt !== -1) {
        const tail = this.buffer.slice(lastLt);
        // Ghost-ml tags are max ~35 chars. Buffer if tail is short and unclosed.
        if (tail.length < 50 && !tail.includes('>')) {
          output += this.buffer.slice(0, lastLt);
          this.buffer = tail;
          break;
        }
      }

      // Safe to emit everything
      output += this.buffer;
      this.buffer = '';
      break;
    }

    return output;
  }

  /** Flush remaining buffer at end of stream. */
  flush(): string {
    const rest = this.buffer;
    this.buffer = '';
    return rest;
  }
}

/* ══════════════════════════════════════════
 *  stripGhostML — complete-text cleanup
 * ══════════════════════════════════════════ */

/**
 * Strip ghost-ml from complete text (non-streaming).
 * Handles both raw and JSON-escaped forward-slashes (`<\/tag>`).
 */
export function stripGhostML(text: string): string {
  return text
    // Remove entire <main-ghost-ml>...</main-ghost-ml> blocks
    .replace(/<main-ghost-ml>[\s\S]*?<\\?\/main-ghost-ml>/g, '')
    // Remove entire <info-control-ghost-ml>...</info-control-ghost-ml> blocks
    .replace(/<info-control-ghost-ml>[\s\S]*?<\\?\/info-control-ghost-ml>/g, '')
    // Strip remaining ghost-ml tags (keep content between them)
    .replace(/<\\?\/?[a-z][a-z-]*-ghost-ml>/g, '');
}

/* ══════════════════════════════════════════
 *  rewriteStandardSSE — shared SSE rewriter
 * ══════════════════════════════════════════ */

/**
 * Rewrite SSE chunks for OpenAI-compatible formats.
 *
 * Handles:
 *   - choices[].delta.content       (OpenAI / Qwen / Kimi)
 *   - choices[].delta.content[]     (array variant)
 *   - choices[].message.content     (Kimi alternative)
 *   - candidates[].content.parts[]  (Gemini)
 *   - output_text / text            (fallback)
 */
export function rewriteStandardSSE(
  sseChunk: string,
  contentFilter: (delta: string) => string,
  parseState: Record<string, unknown> & { partial: string },
): string {
  const text = parseState.partial + sseChunk;
  const lines = text.split('\n');
  parseState.partial = lines.pop() || '';

  const output: string[] = [];
  for (const line of lines) {
    if (!line.startsWith('data: ') || line.includes('[DONE]')) {
      output.push(line);
      continue;
    }
    const payload = line.slice(6).trim();
    if (!payload) {
      output.push(line);
      continue;
    }
    try {
      const json = JSON.parse(payload);
      let modified = false;

      // OpenAI / Qwen / Kimi: choices[].delta.content
      if (Array.isArray(json.choices)) {
        for (const choice of json.choices) {
          if (typeof choice.delta?.content === 'string') {
            choice.delta.content = contentFilter(choice.delta.content);
            modified = true;
          }
          if (Array.isArray(choice.delta?.content)) {
            for (const part of choice.delta.content) {
              if (typeof part?.text === 'string') {
                part.text = contentFilter(part.text);
                modified = true;
              }
            }
          }
          if (typeof choice.message?.content === 'string') {
            choice.message.content = contentFilter(choice.message.content);
            modified = true;
          }
        }
      }

      // Gemini: candidates[].content.parts[].text
      if (Array.isArray(json.candidates)) {
        for (const candidate of json.candidates) {
          const parts = candidate.content?.parts;
          if (Array.isArray(parts)) {
            for (const part of parts) {
              if (typeof part.text === 'string') {
                part.text = contentFilter(part.text);
                modified = true;
              }
            }
          }
        }
      }

      // Fallback fields
      if (!modified && typeof json.output_text === 'string') {
        json.output_text = contentFilter(json.output_text);
        modified = true;
      }
      if (!modified && typeof json.text === 'string') {
        json.text = contentFilter(json.text);
        modified = true;
      }

      output.push(modified ? 'data: ' + JSON.stringify(json) : line);
    } catch {
      output.push(line);
    }
  }

  return output.length > 0 ? output.join('\n') + '\n' : '';
}

/* ══════════════════════════════════════════
 *  Internal
 * ══════════════════════════════════════════ */

function parseInfoControl(content: string): InfoControlResult {
  const needMatch = content.match(
    new RegExp(`<${NEED_UPDATE_TAG}>\\s*(true|false)\\s*</${NEED_UPDATE_TAG}>`, 'i'),
  );
  const needUpdate = needMatch?.[1]?.toLowerCase() === 'true';

  let updatedBio: string | undefined;
  if (needUpdate) {
    const bioMatch = content.match(
      new RegExp(`<${UPDATED_BIO_TAG}>([\\s\\S]*?)</${UPDATED_BIO_TAG}>`),
    );
    updatedBio = bioMatch?.[1]?.trim();
  }

  const soulMatch = content.match(
    new RegExp(`<${NEED_UPDATE_SOUL_TAG}>\\s*(true|false)\\s*</${NEED_UPDATE_SOUL_TAG}>`, 'i'),
  );
  const needUpdateSoul = soulMatch?.[1]?.toLowerCase() === 'true';

  let updatedSoul: string | undefined;
  if (needUpdateSoul) {
    const soulContentMatch = content.match(
      new RegExp(`<${UPDATED_SOUL_TAG}>([\\s\\S]*?)</${UPDATED_SOUL_TAG}>`),
    );
    updatedSoul = soulContentMatch?.[1]?.trim();
  }

  return { needUpdate, updatedBio, needUpdateSoul, updatedSoul };
}
