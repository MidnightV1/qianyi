import { INFO_CTRL_TAG, NEED_UPDATE_TAG, UPDATED_BIO_TAG, RESP_TAG } from './constants';

/**
 * Data extracted from model's <info-control-ghost-ml> block.
 */
export interface InfoControlData {
  needUpdate: boolean;
  updatedBio?: string;
}

/**
 * Streaming text parser with a 100-char sliding buffer.
 *
 * Design:
 *   Model output arrives as small text deltas (SSE chunks).
 *   Tags like `<info-control-ghost-ml>` can be split across chunks.
 *   We maintain a FIFO buffer of the latest 100 chars at the tail of
 *   the accumulated text. Tag detection happens inside this buffer,
 *   so we never miss a boundary that straddles two chunks.
 *
 * States:
 *   SCANNING  — normal text, looking for <info-control-ghost-ml>
 *   CAPTURING — inside the block, accumulating until </info-control-ghost-ml>
 *   DONE      — block fully extracted
 */
export class StreamParser {
  private accumulated = '';
  private scanCursor = 0;     // how far we've confidently scanned
  private capturing = false;
  private captureStart = -1;
  private result: InfoControlData | null = null;

  private readonly BUF_SIZE = 100;
  private readonly OPEN = `<${INFO_CTRL_TAG}>`;
  private readonly CLOSE = `</${INFO_CTRL_TAG}>`;

  /**
   * Feed a new text delta from SSE content.
   * Returns extracted InfoControlData when the block closes, otherwise null.
   */
  feed(delta: string): InfoControlData | null {
    this.accumulated += delta;

    if (this.result) return null; // already done

    if (!this.capturing) {
      // Scan from (cursor - BUF_SIZE) to catch tags split across deltas
      const searchFrom = Math.max(0, this.scanCursor - this.BUF_SIZE);
      const idx = this.accumulated.indexOf(this.OPEN, searchFrom);

      if (idx !== -1) {
        this.capturing = true;
        this.captureStart = idx;
      }

      // Advance cursor, keeping BUF_SIZE chars as look-back
      this.scanCursor = this.accumulated.length;
    }

    if (this.capturing) {
      const closeIdx = this.accumulated.indexOf(this.CLOSE, this.captureStart);
      if (closeIdx !== -1) {
        const blockEnd = closeIdx + this.CLOSE.length;
        const block = this.accumulated.slice(this.captureStart, blockEnd);
        this.result = this.parseBlock(block);
        this.capturing = false;
        return this.result;
      }
    }

    return null;
  }

  /** Index in accumulated text where <info-control-ghost-ml> starts. -1 if not found yet. */
  get infoControlStart(): number {
    return this.captureStart;
  }

  /** Full accumulated text so far. */
  get text(): string {
    return this.accumulated;
  }

  /** Already-extracted result (null until block is complete). */
  get extracted(): InfoControlData | null {
    return this.result;
  }

  /** Reset for a new response stream. */
  reset(): void {
    this.accumulated = '';
    this.scanCursor = 0;
    this.capturing = false;
    this.captureStart = -1;
    this.result = null;
  }

  /* ── Internal ── */

  private parseBlock(block: string): InfoControlData {
    const needMatch = block.match(
      new RegExp(`<${NEED_UPDATE_TAG}>\\s*(true|false)\\s*</${NEED_UPDATE_TAG}>`, 'i'),
    );
    const needUpdate = needMatch?.[1]?.toLowerCase() === 'true';

    let updatedBio: string | undefined;
    if (needUpdate) {
      const bioMatch = block.match(
        new RegExp(`<${UPDATED_BIO_TAG}>([\\s\\S]*?)</${UPDATED_BIO_TAG}>`),
      );
      updatedBio = bioMatch?.[1]?.trim();
    }

    return { needUpdate, updatedBio };
  }
}
