import type { PlatformAdapter } from './types';
import { deepseekAdapter } from './deepseek';
import { geminiAdapter } from './gemini';
import { kimiAdapter } from './kimi';
import { qwenAdapter } from './qwen';

export const ADAPTERS: PlatformAdapter[] = [
  deepseekAdapter,
  geminiAdapter,
  kimiAdapter,
  qwenAdapter,
];

export function getAdapterForHost(hostname: string): PlatformAdapter {
  const lowered = hostname.toLowerCase();

  if (lowered === 'chat.deepseek.com') return deepseekAdapter;
  if (lowered === 'gemini.google.com' || lowered === 'aistudio.google.com') return geminiAdapter;
  if (lowered === 'kimi.moonshot.cn') return kimiAdapter;
  if (lowered === 'chat.qwen.ai' || lowered === 'tongyi.aliyun.com' || lowered === 'tongyi.com') return qwenAdapter;

  return deepseekAdapter;
}
