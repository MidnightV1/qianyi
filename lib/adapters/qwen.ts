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
      const parts = [...message.content];
      for (let partIndex = parts.length - 1; partIndex >= 0; partIndex--) {
        const part = parts[partIndex] as Record<string, unknown>;
        if (typeof part?.text === 'string') {
          parts[partIndex] = { ...part, text: injected };
          messages[index] = { ...message, content: parts };
          return true;
        }
      }
    }
  }
  return false;
}

function injectAnyStringField(body: Record<string, unknown>, formatter: (text: string) => string): Record<string, unknown> {
  for (const key of ['prompt', 'query', 'input', 'message', 'content', 'text'] as const) {
    if (typeof body[key] === 'string') {
      return { ...body, [key]: formatter(body[key] as string) };
    }
  }
  return body;
}

export const qwenAdapter: PlatformAdapter = {
  id: 'qwen',
  name: 'Qwen',
  matchPatterns: ['*://chat.qwen.ai/*', '*://tongyi.aliyun.com/*', '*://tongyi.com/*', '*://qianwen.com/*', '*://www.qianwen.com/*'],

  capabilities: {
    knowsCurrentTime: true,
  },

  shouldIntercept(url: string, body?: Record<string, unknown>): boolean {
    let pathname = '';
    try {
      pathname = new URL(url, 'https://chat.qwen.ai').pathname;
    } catch {
      pathname = url;
    }

    if (pathname.includes('/chat') || pathname.includes('/completion') || pathname.includes('/completions')) return true;
    if (pathname.includes('/conversation') || pathname.includes('/stream')) return true;

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
      const cloned = { ...body, messages: [...body.messages] };
      if (injectIntoMessages(cloned.messages as unknown[], injected)) {
        return cloned;
      }
    }

    return injectAnyStringField(body, (text) => formatInjection(ctx, text));
  },

  modifyRequestBodyTimeOnly(body: Record<string, unknown>): Record<string, unknown> | null {
    const modified = injectAnyStringField(body, (text) => formatTimeOnlyInjection(text));
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

            if (Array.isArray(delta?.content)) {
              for (const chunk of delta.content as unknown[]) {
                const textChunk = (chunk as Record<string, unknown>).text;
                if (typeof textChunk === 'string' && textChunk) deltas.push(textChunk);
              }
            }
          }
          continue;
        }

        if (typeof parsed.output_text === 'string' && parsed.output_text) {
          deltas.push(parsed.output_text);
        } else if (typeof parsed.text === 'string' && parsed.text) {
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
