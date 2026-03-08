import { defineConfig } from 'wxt';

export default defineConfig({
  modules: [],
  manifest: {
    name: '潜忆 Qianyi',
    description: '让 AI 记住你——非侵入式 LLM 记忆注入',
    version: '1.1.0',
    permissions: ['storage'],
    host_permissions: [
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
      'https://api.github.com/*',
    ],
    icons: {
      16: 'img/icon_16_16.png',
      32: 'img/icon_32_32.png',
      48: 'img/icon_48_48.png',
      128: 'img/icon_128_128.png',
    },
  },
});
