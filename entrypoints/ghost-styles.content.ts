/**
 * Ultra-early CSS injection — runs at document_start to hide ghost-ml
 * custom elements before the browser ever paints them.
 *
 * Separate from main content.ts (document_idle) to ensure zero-flash.
 */

export default defineContentScript({
  matches: ['*://chat.deepseek.com/*'],
  runAt: 'document_start',

  main() {
    const style = document.createElement('style');
    style.id = 'ghost-context-styles';
    style.textContent = [
      'info-control-ghost-ml,',
      'need-update-ghost-ml,',
      'updated-user-bio-ghost-ml { display: none !important; }',
      'model-response-ghost-ml { display: contents !important; }',
    ].join('\n');
    (document.head || document.documentElement).appendChild(style);
  },
});
