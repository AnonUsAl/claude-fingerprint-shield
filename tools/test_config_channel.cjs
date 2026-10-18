/* 配置通道 + UA 真源的回归测试（纯 Node，不需要浏览器）
 *
 * 用一个「迷你扩展运行时」桩同时加载 ua-patterns.js / spoof.js / bridge.js：
 *   - document.documentElement 带属性存取
 *   - window.postMessage 进队列，flush() 时按浏览器语义派发给 message 监听
 *   - inject() 同步派发，模拟页面脚本用 MessageEvent 构造函数抢先伪造
 *
 * 覆盖 issue #1 / #3 的修复点：
 *   1. 重复注入守卫是不可枚举 Symbol，window.__FP_GUARD__ 不复存在
 *   2. 合法配置消息（nonce 匹配）正常生效，且通道随即一次性关闭
 *   3. 无 nonce / 错 nonce / 通道关闭后连真 nonce 也送不进伪造配置
 *   4. 非法时区 / 非法语言 / 非布尔开关被忽略，不会让 Intl 抛异常
 *   5. UA 真源取并集：wxwork 等 spoof.js 原缺失项现在能触发净化；
 *      设备品牌只判「国产设备」，不误判成「国产浏览器」
 *
 * 运行： node tools/test_config_channel.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const nodeCrypto = require('crypto');

const SRC = path.join(__dirname, '..', 'src');
const PATTERNS_KEY = 'Symbol.for("claude-fp-shield.ua-patterns.v1")';

/* ---------- 迷你扩展运行时桩 ---------- */

function makeWorld(opts) {
  opts = opts || {};
  const attrs = {};
  const messageListeners = [];
  const messageQueue = [];

  const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

  class Navigator {}
  for (const [k, v] of [
    ['language', opts.language || 'zh-CN'],
    ['languages', opts.languages || ['zh-CN', 'zh']],
    ['userAgent', opts.userAgent || DEFAULT_UA],
    ['appVersion', '5.0 (Macintosh; Intel Mac OS X 10_15_7)'],
    ['platform', 'MacIntel']
  ]) {
    Object.defineProperty(Navigator.prototype, k, { get: () => v, configurable: true, enumerable: true });
  }

  class CanvasRenderingContext2D {}

  const sandbox = {
    console,
    CanvasRenderingContext2D,
    Navigator,
    navigator: Object.create(Navigator.prototype),
    // vm realm 里没有 Node 的全局 crypto，补一个真的随机源，
    // 让 bridge.js 走到 crypto.getRandomValues 的正式分支
    crypto: {
      getRandomValues: (arr) => {
        const b = nodeCrypto.randomBytes(arr.length);
        for (let i = 0; i < arr.length; i++) arr[i] = b[i];
        return arr;
      }
    },
    addEventListener: (type, fn) => { if (type === 'message') messageListeners.push(fn); },
    removeEventListener: (type, fn) => {
      if (type !== 'message') return;
      const i = messageListeners.indexOf(fn);
      if (i !== -1) messageListeners.splice(i, 1);
    },
    postMessage: (data) => { messageQueue.push(data); },
    document: {
      documentElement: {
        getAttribute: (k) => (Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null),
        setAttribute: (k, v) => { attrs[k] = String(v); },
        removeAttribute: (k) => { delete attrs[k]; }
      },
      fonts: null,
      createElement: () => ({ getContext: () => new CanvasRenderingContext2D() })
    },
    chrome: {
      storage: {
        local: {
          // 同步回调：让「配置何时送达」在测试里完全可控
          get: (key, cb) => cb({ settings: opts.stored === undefined ? null : opts.stored }),
          set: () => {}
        }
      }
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);

  // 注意：vm 里 `window` 解析到的是该 context 的全局对象（代理），
  // 与宿主的 sandbox 对象不是同一个身份 —— 派发消息时 ev.source 必须用它，
  // 否则 spoof.js 的 `ev.source !== window` 会误判。
  const vmWindow = vm.runInContext('globalThis', sandbox);

  const run = (file) => vm.runInContext(
    fs.readFileSync(path.join(SRC, file), 'utf8'), sandbox, { filename: file });

  return {
    sandbox,
    attrs,
    run,
    messageListeners,
    // 浏览器语义：postMessage 的消息排队后异步派发
    flush: () => {
      const batch = messageQueue.splice(0, messageQueue.length);
      for (const data of batch) {
        for (const fn of messageListeners.slice()) fn({ source: vmWindow, data });
      }
    },
    // 页面脚本视角：同步派发一条「消息」（对应 new MessageEvent + dispatchEvent 抢先伪造）
    inject: (data) => {
      for (const fn of messageListeners.slice()) fn({ source: vmWindow, data });
    },
    probe: (expr) => vm.runInContext(expr, sandbox)
  };
}

/* ---------- 断言 ---------- */

let failures = 0;
function check(name, cond) {
  console.log((cond ? '  ok   ' : '  FAIL ') + name);
  if (!cond) failures++;
}

/* ---------- 1. 重复注入守卫（issue #1） ---------- */
{
  const w = makeWorld();
  w.run('ua-patterns.js');
  w.run('spoof.js');
  const desc = w.probe('Object.getOwnPropertyDescriptor(globalThis, Symbol.for("claude-fp-shield.guard.v1"))');
  check('guard symbol 存在、值为 true、不可枚举', !!desc && desc.value === true && desc.enumerable === false);
  check('window.__FP_GUARD__ 不再存在（配置不再挂 window）', !w.probe('"__FP_GUARD__" in globalThis'));
  w.run('spoof.js');
  check('重复注入被 Symbol 守卫拦截（监听数不翻倍）', w.messageListeners.length === 1);
}

/* ---------- 2. 合法配置消息 + 一次性通道 ---------- */
{
  const w = makeWorld({
    stored: { enabled: true, timeZone: 'Asia/Tokyo', language: 'ja-JP', blockFonts: false, blockWebRTC: true, sanitizeUA: true }
  });
  w.run('ua-patterns.js');
  w.run('spoof.js');
  w.run('bridge.js');
  const nonce = w.attrs['data-fp-n'];
  check('bridge 在 document_start 同步写入 32 位 nonce', typeof nonce === 'string' && /^[0-9a-f]{32}$/.test(nonce));

  w.flush();
  check('收下有效配置后 nonce 被擦除', w.attrs['data-fp-n'] === undefined);
  check('消息监听已摘除（一次性通道）', w.messageListeners.length === 0);
  check('时区配置生效（Asia/Tokyo = -540）', w.probe('new Date().getTimezoneOffset()') === -540);
  check('语言配置生效', w.sandbox.navigator.language === 'ja-JP');
  check('languages 列表被改写', JSON.stringify(w.sandbox.navigator.languages) === '["ja-JP","en"]');

  // 通道已关：就算拿着刚才那条真 nonce 也送不进去了
  w.inject({ __fpGuard: true, nonce: nonce, settings: { enabled: false, timeZone: 'America/New_York' } });
  check('通道关闭后，真 nonce 的伪造消息也无效', w.probe('new Date().getTimezoneOffset()') === -540);
}

/* ---------- 3. 伪造消息（配置送达前抢先） ---------- */
{
  const w = makeWorld({ stored: { timeZone: 'Asia/Tokyo', language: 'ja-JP' } });
  w.run('ua-patterns.js');
  w.run('spoof.js');
  w.run('bridge.js');
  // 先不 flush：模拟页面脚本赶在 storage 回调前动手
  w.inject({ __fpGuard: true, settings: { enabled: false } });
  check('无 nonce 的伪造消息被丢弃（默认伪装仍生效）', w.sandbox.navigator.language === 'en-US');
  w.inject({ __fpGuard: true, nonce: '0'.repeat(32), settings: { enabled: false } });
  check('nonce 不匹配的伪造消息被丢弃', w.sandbox.navigator.language === 'en-US');
  w.flush();
  check('抢先伪造不影响随后到达的合法配置', w.probe('new Date().getTimezoneOffset()') === -540);
}

/* ---------- 4. 非法配置值 ---------- */
{
  const w = makeWorld({
    stored: { timeZone: 'Not/AZone', language: 'bad locale!!', blockFonts: 'yes', blockWebRTC: 1 }
  });
  w.run('ua-patterns.js');
  w.run('spoof.js');
  w.run('bridge.js');
  let threw = null;
  try { w.flush(); } catch (e) { threw = e; }
  check('非法配置不会让 hook 抛异常', threw === null);
  check('非法时区被忽略，保持默认 America/New_York',
    w.probe('Intl.DateTimeFormat().resolvedOptions().timeZone') === 'America/New_York');
  check('非法语言被忽略，保持默认 en-US', w.sandbox.navigator.language === 'en-US');
}

/* ---------- 5. UA 真源（issue #3） ---------- */
{
  const w = makeWorld({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 '
      + '(KHTML, like Gecko) Mobile/15E148 wxwork/4.1.8 MicroMessenger/8.0.49 Language/zh-Hans'
  });
  w.run('ua-patterns.js');
  w.run('spoof.js');
  const P = 'globalThis[' + PATTERNS_KEY + ']';
  check('wxwork 命中 CN_BROWSER_RE（此前只有 popup.js 有）',
    w.probe(P + '.CN_BROWSER_RE.test("wxwork/4.1.8")'));
  check('HarmonyOS / ArkWeb 等 spoof.js 原专属条目并入真源',
    w.probe(P + '.CN_UA_RE.test("ArkWeb/4.0")') && w.probe(P + '.CN_UA_RE.test("HarmonyOS 4.0")'));
  check('企业微信 UA 被整体净化（此前 spoof.js 不含 wxwork，面板骗人）',
    w.sandbox.navigator.userAgent.indexOf('wxwork') === -1
    && /Chrome\/126\.0\.0\.0/.test(w.sandbox.navigator.userAgent));
  check('设备品牌不误判成「国产浏览器」',
    !w.probe(P + '.CN_BROWSER_RE.test("HUAWEI MLA-AL10")'));
  check('设备品牌命中 CN_DEVICE_RE',
    w.probe(P + '.CN_DEVICE_RE.test("HUAWEI MLA-AL10")') && w.probe(P + '.CN_DEVICE_RE.test("Xiaomi 14")'));

  const clean = makeWorld();
  clean.run('ua-patterns.js');
  clean.run('spoof.js');
  check('干净桌面 UA 不触发净化（无误伤）',
    clean.sandbox.navigator.userAgent.indexOf('Macintosh') !== -1
    && clean.sandbox.navigator.userAgent === clean.sandbox.navigator.userAgent);
}

console.log('\n结论：', failures === 0 ? '✅ 全部通过' : '❌ ' + failures + ' 个失败项');
process.exit(failures === 0 ? 0 : 1);
