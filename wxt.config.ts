import { defineConfig } from 'wxt';

export default defineConfig({
  modules: [],
  manifest: {
    name: '潜忆 Qianyi',
    description: '让 AI 记住你——非侵入式 LLM 记忆注入',
    version: '0.1.0',
    permissions: ['storage'],
    host_permissions: ['*://chat.deepseek.com/*', 'https://api.github.com/*'],
    icons: {
      16: 'img/icon_16_16.png',
      32: 'img/icon_32_32.png',
      48: 'img/icon_48_48.png',
      128: 'img/icon_128_128.png',
    },
  },
});
