import type { PlatformAdapter } from './types';
import { formatInjection, formatTimeOnlyInjection } from '../injection';
import type { InjectionContext } from '../profile';
import { deepseekAdapter } from './deepseek';

function injectIntoMessages(messages: unknown[], injected: string): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as Record<string, unknown>;
    if (!message || message.role !== 'user') continue;

    if (typeof message.content === 'string') {
      messages[index] = { ...message, content: injected };
      return true;
    }

    if (Array.isArray(message.content)) {
      const chunks = [...message.content];
      for (let chunkIndex = chunks.length - 1; chunkIndex >= 0; chunkIndex--) {
        const chunk = chunks[chunkIndex] as Record<string, unknown>;
        if (typeof chunk?.text === 'string') {
          chunks[chunkIndex] = { ...chunk, text: injected };
          messages[index] = { ...message, content: chunks };
          return true;
        }
      }
    }
  }
  return false;
}

function injectGeneric(body: Record<string, unknown>, formatter: (source: string) => string): Record<string, unknown> {
  for (const key of ['prompt', 'query', 'input', 'message', 'content', 'text'] as const) {
    if (typeof body[key] === 'string') {
      return { ...body, [key]: formatter(body[key] as string) };
    }
  }
  return body;
}

export const kimiAdapter: PlatformAdapter = {
  id: 'kimi',
  name: 'Kimi',
  matchPatterns: ['*://kimi.moonshot.cn/*'],

  capabilities: {
    knowsCurrentTime: true,
  },

  shouldIntercept(url: string, body?: Record<string, unknown>): boolean {
    let pathname = '';
    try {
      pathname = new URL(url, 'https://kimi.moonshot.cn').pathname;
    } catch {
      pathname = url;
    }

    if (pathname.includes('/chat') || pathname.includes('/completion') || pathname.includes('/stream')) {
      return true;
    }

    if (!body) return false;
    if (Array.isArray(body.messages)) return true;
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

    if (Array.isArray(body.messages)) {
      const next = { ...body, messages: [...body.messages] };
      if (injectIntoMessages(next.messages as unknown[], injected)) {
        return next;
      }
    }

    return injectGeneric(body, (text) => formatInjection(ctx, text));
  },

  modifyRequestBodyTimeOnly(body: Record<string, unknown>): Record<string, unknown> | null {
    const modified = injectGeneric(body, (text) => formatTimeOnlyInjection(text));
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
        const choices = parsed.choices;
        if (Array.isArray(choices)) {
          for (const choice of choices) {
            const choiceObj = choice as Record<string, unknown>;
            const delta = choiceObj.delta as Record<string, unknown> | undefined;
            if (typeof delta?.content === 'string' && delta.content) deltas.push(delta.content);
            const message = choiceObj.message as Record<string, unknown> | undefined;
            if (typeof message?.content === 'string' && message.content) deltas.push(message.content);
          }
          continue;
        }

        if (typeof parsed.text === 'string' && parsed.text) {
          deltas.push(parsed.text);
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
