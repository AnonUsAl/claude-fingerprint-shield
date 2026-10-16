/* Claude 低风险指纹 —— ISOLATED world 配置桥（document_start）
 * MAIN world 里拿不到 chrome.* API，所以由这里读 storage，
 * 再用 window.postMessage 把配置推给 src/spoof.js。
 * spoof.js 的所有 hook 都是「调用时读配置」，因此配置晚到也能立刻生效。
 */
(() => {
  'use strict';

  let last = null;

  function push(settings) {
    if (!settings || typeof settings !== 'object') return;
    last = JSON.stringify(settings);
    try {
      window.postMessage({ __fpGuard: true, settings }, '*');
    } catch (e) { /* ignore */ }
  }

  function readAndPush() {
    try {
      chrome.storage.local.get('settings', (res) => {
        if (res && res.settings) push(res.settings);
      });
    } catch (e) { /* ignore */ }
  }

  readAndPush();

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.settings) return;
      const v = changes.settings.newValue;
      if (JSON.stringify(v) === last) return;
      push(v);
    });
  } catch (e) { /* ignore */ }

  // 兜底：DOM 就绪后再补一次，覆盖 storage 极慢的情况
  try {
    window.addEventListener('DOMContentLoaded', readAndPush, { once: true });
  } catch (e) { /* ignore */ }
})();
