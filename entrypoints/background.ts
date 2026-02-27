export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(() => {
    console.log('[GhostContext] Extension installed');
  });
});
