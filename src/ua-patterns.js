/* Claude 低风险指纹 —— UA 国产标识正则（单一真源）
 * ------------------------------------------------------------------
 * spoof.js（MAIN world）和 popup.js（扩展页面）共用这里的正则，两边不再各写一份：
 *   - manifest.json 里本文件排在 spoof.js 之前注入（同 world、同 run_at，按 js 数组顺序执行）
 *   - popup.html 用 <script src="ua-patterns.js"></script> 引入
 *
 * 语义拆成两组（取两边原列表的并集）：
 *   CN_BROWSER_RE  国产浏览器 / WebView / App 内置浏览器标识
 *                  —— 面板「国产浏览器 / WebView」一项的判断依据
 *   CN_DEVICE_RE   国产厂商设备品牌 / OS 标识
 *                  —— 面板「国产品牌设备」一项的判断依据
 *   CN_UA_RE       以上并集 —— spoof.js 用它判断「要不要整条替换 UA」
 *
 * 为什么拆开：Huawei / OPPO / XiaoMi 这些词在 UA 里是设备品牌，拿来判断
 * 「国产浏览器」会误伤；而 spoof.js 触发 UA 净化时，浏览器和设备标识都该命中。
 *
 * 通过 Symbol.for('claude-fp-shield.ua-patterns.v1') 挂到 window：Symbol 键不会被
 * Object.keys / JSON.stringify / for...in 枚举到。这里只有静态正则、不含任何配置，
 * 页面脚本就算拿到也没有可操作的价值。
 */
(function () {
  'use strict';

  const KEY = Symbol.for('claude-fp-shield.ua-patterns.v1');
  if (Object.prototype.hasOwnProperty.call(window, KEY)) return;

  /* ---- 国产浏览器 / WebView / App 内置浏览器 ---- */
  const BROWSER_TOKENS = [
    // 社交 / 办公 App 内置浏览器
    'micromessenger',             // 微信内置浏览器
    'weixin',                     // 微信（旧版 UA 标识）
    'wxwork',                     // 企业微信
    'mqqbrowser', 'qqbrowser',    // QQ 浏览器
    '\\bqq\\/',                   // 手机 QQ 内嵌 WebView
    'alipayclient',               // 支付宝
    'dingtalk',                   // 钉钉
    'weibo',                      // 微博
    'xiaohongshu', 'xhsminiapp',  // 小红书
    'bilibili',                   // 哔哩哔哩
    // 字节系
    'aweme',                      // 抖音
    'bytedancewebview',
    'toutiaomicroapp', 'newsarticle', // 今日头条
    // 手机浏览器
    'quark',                      // 夸克
    'ucbrowser', 'ucweb', 'ubrowser', // UC 系
    'baiduboxapp',                // 百度 App
    'bidubrowser', 'baidubrowser',    // 百度浏览器
    'baiduspider',                // 百度爬虫（spoof.js 原有条目，并集保留）
    'miuibrowser', 'mibrowser', '\\bxiaomi\\/', 'mibro', // 小米浏览器
    'sogoumobilebrowser', 'sogou',      // 搜狗
    'metasr',                     // 神马搜索
    'maxthon',                    // 傲游
    'theworld',                   // 世界之窗
    'lbbrowser', 'liebao',        // 猎豹
    'huaweibrowser', 'hbpc', 'arkweb',  // 华为浏览器 / ArkWeb 引擎
    'heytapbrowser', 'oppobrowser', 'heytap', // OPPO / 一加
    'vivobrowser',                // vivo
    'mzbrowser', 'flysilk',       // 魅族
    // 360 系
    '360se', '360ee', '360browser', 'qihoobrowser', 'qihu', 'qhbrowser',
    // 2345
    '2345explorer', '2345browser'
  ];

  /* ---- 国产厂商设备品牌 / OS ---- */
  const DEVICE_TOKENS = [
    'huawei', 'honor', 'harmonyos',           // 华为 / 荣耀 / 鸿蒙
    'xiaomi', 'redmi', 'poco',                // 小米系
    'oppo', 'vivo', 'iqoo', 'oneplus', 'realme', // OPPO 系
    'meizu', 'smartisan',                     // 魅族 / 锤子
    'zte', 'lenovo', 'gionee'                 // 中兴 / 联想 / 金立
  ];

  const PATTERNS = {
    CN_BROWSER_RE: new RegExp(BROWSER_TOKENS.join('|'), 'i'),
    CN_DEVICE_RE: new RegExp(DEVICE_TOKENS.join('|'), 'i'),
    CN_UA_RE: new RegExp(BROWSER_TOKENS.concat(DEVICE_TOKENS).join('|'), 'i')
  };

  Object.defineProperty(window, KEY, {
    value: PATTERNS,
    writable: false,
    enumerable: false,
    configurable: true
  });
})();
