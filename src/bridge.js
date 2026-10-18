/* Claude 低风险指纹 —— ISOLATED world 配置桥（document_start）
 * MAIN world 里拿不到 chrome.* API，所以由这里读 storage，
 * 再用 window.postMessage 把配置推给 src/spoof.js。
 * spoof.js 的所有 hook 都是「调用时读配置」，因此配置晚到也能立刻生效。
 *
 * 安全模型（issue #1）：
 *  - nonce 在 document_start 同步生成，与配置消息在同一个同步块里发出
 *    （先写 documentElement[data-fp-n]，再 postMessage，中间没有任务边界，
 *    页面脚本插不进来）。spoof.js 只接受 nonce 与当前属性一致的消息。
 *  - spoof.js 收下第一条有效配置后会立即摘监听、擦除属性，通道是一次性的；
 *    之后页面脚本照抄 {__fpGuard:true} 的伪造消息没有 nonce，会被直接丢弃。
 *  - 配置改动的生效时机是「下次页面加载」（面板里也是这么提示的），
 *    不再监听 storage.onChanged 实时推送 —— 那会让通道永远敞开。
 *  - 残余风险：MAIN world 与页面脚本同一个 realm，页面若能赶在首条配置送达前
 *    读到 nonce 并同步派发伪造的 MessageEvent，仍可改写这一次的配置。
 *    这是 MV3 MAIN world 注入的固有极限，没有页面读不到而 spoof.js 读得到的通道。
 */
(() => {
  'use strict';

  const NONCE_ATTR = 'data-fp-n';

  function makeNonce() {
    try {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {
      return 'f' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    }
  }

  const NONCE = makeNonce();
  let last = null;

  function push(settings, force) {
    if (!settings || typeof settings !== 'object') return;
    const json = JSON.stringify(settings);
    if (!force && json === last) return;
    last = json;
    try {
      document.documentElement.setAttribute(NONCE_ATTR, NONCE);
    } catch (e) { /* ignore */ }
    try {
      window.postMessage({ __fpGuard: true, nonce: NONCE, settings }, '*');
    } catch (e) { /* ignore */ }
  }

  function readAndPush(force) {
    try {
      chrome.storage.local.get('settings', (res) => {
        if (res && res.settings) push(res.settings, force);
      });
    } catch (e) { /* ignore */ }
  }

  readAndPush(false);

  // 兜底：DOM 就绪后再补一次（force 绕过 last 去重），覆盖 storage 极慢、
  // 或 spoof.js 监听挂上来得更晚、首条消息没人受理的情况
  try {
    window.addEventListener('DOMContentLoaded', () => readAndPush(true), { once: true });
  } catch (e) { /* ignore */ }
})();
