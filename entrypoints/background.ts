export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(() => {
    console.log('[Qianyi] Extension installed');
  });
});
