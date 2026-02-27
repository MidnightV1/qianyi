import { defineConfig } from 'wxt';

export default defineConfig({
  modules: [],
  manifest: {
    name: 'GhostContext',
    description: '非侵入式 LLM 记忆增强系统',
    version: '0.1.0',
    permissions: ['storage'],
    host_permissions: ['*://chat.deepseek.com/*'],
  },
});
