/**
 * Ultra-early CSS injection — runs at document_start to hide ghost-ml
 * custom elements before the browser ever paints them.
 *
 * Separate from main content.ts (document_idle) to ensure zero-flash.
 */

export default defineContentScript({
  matches: [
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
  ],
  runAt: 'document_start',

  main() {
    const style = document.createElement('style');
    style.id = 'ghost-context-styles';
    style.textContent = [
      'main-ghost-ml,',
      'info-control-ghost-ml,',
      'need-update-ghost-ml,',
      'updated-user-bio-ghost-ml,',
      'need-update-soul-ghost-ml,',
      'updated-ai-soul-ghost-ml { display: none !important; height: 0 !important; margin: 0 !important; padding: 0 !important; overflow: hidden !important; line-height: 0 !important; font-size: 0 !important; }',
      'model-response-ghost-ml,',
      'origin-user-input-ghost-ml { display: contents !important; }',
    ].join('\n');
    (document.head || document.documentElement).appendChild(style);
  },
});
