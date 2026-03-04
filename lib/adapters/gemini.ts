import type { PlatformAdapter } from './types';
import { formatInjection, formatTimeOnlyInjection } from '../injection';
import type { InjectionContext } from '../profile';
import { deepseekAdapter } from './deepseek';

function injectToContentsArray(contents: unknown[], injected: string): boolean {
  for (let index = contents.length - 1; index >= 0; index--) {
    const item = contents[index] as Record<string, unknown>;
    if (!item || item.role !== 'user') continue;

    const parts = item.parts;
    if (!Array.isArray(parts)) continue;

    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex--) {
      const part = parts[partIndex] as Record<string, unknown>;
      if (typeof part?.text === 'string') {
        parts[partIndex] = { ...part, text: injected };
        return true;
      }
    }
  }
  return false;
}

function injectGenericStringField(body: Record<string, unknown>, injectedFormatter: (source: string) => string): Record<string, unknown> {
  for (const key of ['prompt', 'query', 'input', 'message', 'content', 'text'] as const) {
    if (typeof body[key] === 'string') {
      return { ...body, [key]: injectedFormatter(body[key] as string) };
    }
  }
  return body;
}

export const geminiAdapter: PlatformAdapter = {
  id: 'gemini',
  name: 'Gemini',
  matchPatterns: ['*://gemini.google.com/*', '*://aistudio.google.com/*'],

  capabilities: {
    knowsCurrentTime: true,
  },

  shouldIntercept(url: string, body?: Record<string, unknown>): boolean {
    let pathname = '';
    try {
      pathname = new URL(url, 'https://gemini.google.com').pathname;
    } catch {
      pathname = url;
    }

    if (pathname.includes('GenerateContent') || pathname.includes('generateContent')) return true;
    if (pathname.includes('StreamGenerateContent') || pathname.includes('streamGenerateContent')) return true;
    if (pathname.includes('BardFrontendService') || pathname.includes('batchexecute')) return true;

    if (!body) return false;
    if (Array.isArray(body.contents)) return true;
    return ['prompt', 'query', 'input', 'message', 'content', 'text'].some((key) => typeof body[key] === 'string');
  },

  modifyRequestBody(body: Record<string, unknown>, ctx: InjectionContext): Record<string, unknown> {
    const source =
      (typeof body.prompt === 'string' && body.prompt) ||
      (typeof body.query === 'string' && body.query) ||
      (typeof body.input === 'string' && body.input) ||
      (typeof body.message === 'string' && body.message) ||
      (typeof body.content === 'string' && body.content) ||
      '';

    const injected = formatInjection(ctx, source);

    if (Array.isArray(body.contents)) {
      const cloned = { ...body, contents: [...body.contents] };
      if (injectToContentsArray(cloned.contents as unknown[], injected)) {
        return cloned;
      }
    }

    return injectGenericStringField(body, (text) => formatInjection(ctx, text));
  },

  modifyRequestBodyTimeOnly(body: Record<string, unknown>): Record<string, unknown> | null {
    const modified = injectGenericStringField(body, (text) => formatTimeOnlyInjection(text));
    return modified === body ? null : modified;
  },

  extractContentDeltas(sseChunk: string, parseState: Record<string, unknown> & { partial: string }): string[] {
    const text = parseState.partial + sseChunk;
    const lines = text.split('\n');
    parseState.partial = lines.pop() || '';

    const deltas: string[] = [];
    for (const line of lines) {
      if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
      const payload = line.slice(6).trim();
      if (!payload) continue;
      try {
        const parsed = JSON.parse(payload) as Record<string, unknown>;

        const candidates = parsed.candidates;
        if (Array.isArray(candidates)) {
          for (const candidate of candidates) {
            const content = (candidate as Record<string, unknown>).content as Record<string, unknown> | undefined;
            const parts = content?.parts;
            if (!Array.isArray(parts)) continue;
            for (const part of parts) {
              const textPart = (part as Record<string, unknown>).text;
              if (typeof textPart === 'string' && textPart) deltas.push(textPart);
            }
          }
          continue;
        }

        const choices = parsed.choices;
        if (Array.isArray(choices)) {
          for (const choice of choices) {
            const delta = (choice as Record<string, unknown>).delta as Record<string, unknown> | undefined;
            const content = delta?.content;
            if (typeof content === 'string' && content) deltas.push(content);
          }
        }
      } catch {
        continue;
      }
    }
    return deltas;
  },

  cleanDOM(root: Element): void {
    deepseekAdapter.cleanDOM(root);
  },
};
