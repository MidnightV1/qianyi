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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasInjectableField(container: Record<string, unknown>): boolean {
  if (Array.isArray(container.messages)) return true;
  return ['prompt', 'query', 'input', 'message', 'content', 'text'].some((key) => typeof container[key] === 'string');
}

function tryModifyContainer(container: Record<string, unknown>, ctx: InjectionContext): boolean {
  const source =
    (typeof container.prompt === 'string' && container.prompt) ||
    (typeof container.query === 'string' && container.query) ||
    (typeof container.input === 'string' && container.input) ||
    (typeof container.message === 'string' && container.message) ||
    (typeof container.content === 'string' && container.content) ||
    '';

  if (Array.isArray(container.messages)) {
    const next = [...container.messages];
    if (injectIntoMessages(next as unknown[], formatInjection(ctx, source))) {
      container.messages = next;
      return true;
    }
  }

  for (const key of ['prompt', 'query', 'input', 'message', 'content', 'text'] as const) {
    if (typeof container[key] === 'string') {
      container[key] = formatInjection(ctx, container[key] as string);
      return true;
    }
  }
  return false;
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
    if (hasInjectableField(body)) return true;

    for (const key of ['input', 'data', 'params', 'payload', 'request'] as const) {
      const nested = asRecord(body[key]);
      if (nested && hasInjectableField(nested)) return true;
    }
    return false;
  },

  modifyRequestBody(body: Record<string, unknown>, ctx: InjectionContext): Record<string, unknown> {
    const cloned = { ...body };

    if (tryModifyContainer(cloned, ctx)) return cloned;

    const nestedKeys = ['input', 'data', 'params', 'payload', 'request'] as const;
    for (const key of nestedKeys) {
      const nested = asRecord(cloned[key]);
      if (!nested) continue;
      const nestedCopy = { ...nested };
      if (tryModifyContainer(nestedCopy, ctx)) {
        cloned[key] = nestedCopy;
        return cloned;
      }
    }

    return injectAnyStringField(cloned, (text) => formatInjection(ctx, text));
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
