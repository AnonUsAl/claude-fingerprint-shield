/* Claude 低风险指纹 —— MAIN world 注入脚本（document_start）
 * ------------------------------------------------------------------
 * 针对「中国用户风险分」模型里的 10 项浏览器可见指纹做伪装：
 *   1  系统时区           24
 *   2  浏览器语言         18
 *   3  已安装中文字体     14
 *   4  国产厂商字体       10
 *   5  WebRTC IP 泄露     10
 *   6  国产浏览器/WebView  8
 *   7  国产品牌设备        6
 *   8  Intl 区域设置       4
 *   9  时区偏移            3
 *  10  Emoji 渲染风格      3   （由 UA 推断，非中国 OS 天然 0 分）
 *
 * 设计要点：
 *  - 所有 hook 在调用时读取 CFG 的实时值，因此配置可以「晚到」
 *    （由 bridge.js 在 ISOLATED world 读取 storage 后 postMessage 注入），
 *    晚到的配置会立即对之后的调用生效。
 *  - 所有 hook 都做了 try/catch 与「原函数透传」兜底，关闭开关即完全等于原生。
 *  - 用 Function.prototype.toString 代理掩盖被 hook 函数的源码，避免 toString 反查。
 */
(() => {
  'use strict';

  if (window.__FP_GUARD__) return;

  const DEFAULTS = {
    enabled: true,
    timeZone: 'America/New_York',
    language: 'en-US',
    blockFonts: true,
    blockWebRTC: true,
    sanitizeUA: true
  };

  const CFG = Object.assign({}, DEFAULTS);
  window.__FP_GUARD__ = CFG;

  /* ================= 通用 hook 工具 ================= */

  const hooked = new WeakMap();
  const nativeFnToString = Function.prototype.toString;

  function hookValue(obj, prop, value) {
    if (!obj) return false;
    try {
      const d = Object.getOwnPropertyDescriptor(obj, prop);
      if (d) hooked.set(value, typeof d.value === 'function' ? d.value : (d.get || d.set || d.value));
      Object.defineProperty(obj, prop, {
        value,
        writable: true,
        enumerable: d ? d.enumerable : false,
        configurable: true
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  function hookGetter(obj, prop, getter) {
    if (!obj) return false;
    try {
      const d = Object.getOwnPropertyDescriptor(obj, prop);
      if (d && d.get) hooked.set(getter, d.get);
      Object.defineProperty(obj, prop, {
        get: getter,
        set: d && d.set ? d.set : undefined,
        enumerable: d ? d.enumerable : false,
        configurable: true
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  // 让被 hook 的函数在 toString() 时仍然报告原生源码
  try {
    Function.prototype.toString = new Proxy(nativeFnToString, {
      apply(target, thisArg, args) {
        if (hooked.has(thisArg)) {
          const orig = hooked.get(thisArg);
          if (typeof orig === 'function') return nativeFnToString.call(orig);
        }
        return Reflect.apply(target, thisArg, args);
      }
    });
  } catch (e) { /* ignore */ }

  /* ================= 时区工具 ================= */

  const OrigDTF = Intl.DateTimeFormat;

  function zoneNameAt(date, tz) {
    try {
      const parts = new OrigDTF('en-US', { timeZone: tz, timeZoneName: 'long' }).formatToParts(date);
      const p = parts.find((x) => x.type === 'timeZoneName');
      return p ? p.value : tz;
    } catch (e) {
      return tz;
    }
  }

  /** 返回与 Date.prototype.getTimezoneOffset 同语义的分钟数（东八区 = -480） */
  function offsetFromTZ(date, tz) {
    try {
      const parts = new OrigDTF('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      }).formatToParts(date);
      const m = {};
      for (const p of parts) if (p.type !== 'literal') m[p.type] = p.value;
      let hour = parseInt(m.hour, 10);
      if (hour === 24) hour = 0;
      const asUTC = Date.UTC(+m.year, +m.month - 1, +m.day, hour, +m.minute, +m.second);
      return -Math.round((asUTC - date.getTime()) / 60000);
    } catch (e) {
      return 0;
    }
  }

  function fmtGMT(offsetMinutes) {
    const sign = offsetMinutes <= 0 ? '+' : '-';
    const abs = Math.abs(offsetMinutes);
    return 'GMT' + sign + String(Math.floor(abs / 60)).padStart(2, '0') + String(abs % 60).padStart(2, '0');
  }

  /* ================= 1 + 9. 系统时区 / 时区偏移 ================= */

  const origGetTimezoneOffset = Date.prototype.getTimezoneOffset;
  hookValue(Date.prototype, 'getTimezoneOffset', function getTimezoneOffset() {
    const t = this.getTime();
    if (!CFG.enabled || !isFinite(t)) return origGetTimezoneOffset.call(this);
    return offsetFromTZ(this, CFG.timeZone);
  });

  function rewriteTzSuffix(str, date) {
    if (!str || str.indexOf('GMT') === -1) return str;
    return str.replace(
      /GMT[+-]\d{4}(\s*\([^)]*\))?/,
      fmtGMT(offsetFromTZ(date, CFG.timeZone)) + ' (' + zoneNameAt(date, CFG.timeZone) + ')'
    );
  }

  const origDateToString = Date.prototype.toString;
  hookValue(Date.prototype, 'toString', function toString() {
    const s = origDateToString.call(this);
    if (!CFG.enabled || !isFinite(this.getTime())) return s;
    try { return rewriteTzSuffix(s, this); } catch (e) { return s; }
  });

  const origToTimeString = Date.prototype.toTimeString;
  hookValue(Date.prototype, 'toTimeString', function toTimeString() {
    const s = origToTimeString.call(this);
    if (!CFG.enabled || !isFinite(this.getTime())) return s;
    try { return rewriteTzSuffix(s, this); } catch (e) { return s; }
  });

  for (const name of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']) {
    const orig = Date.prototype[name];
    if (typeof orig !== 'function') continue;
    hookValue(Date.prototype, name, function (locales, options) {
      if (!CFG.enabled || !isFinite(this.getTime())) return orig.apply(this, arguments);
      const o = Object.assign({}, options || {});
      if (!o.timeZone) o.timeZone = CFG.timeZone;
      const loc = (locales === undefined || locales === null) ? CFG.language : locales;
      try { return orig.call(this, loc, o); } catch (e) { return orig.call(this, loc); }
    });
  }

  /* ================= 8. Intl 区域设置 / 时区 ================= */

  function withTimeZone(options) {
    if (!CFG.enabled) return options;
    const o = Object.assign({}, options || {});
    if (!o.timeZone) o.timeZone = CFG.timeZone;
    return o;
  }

  try {
    const PatchedDTF = new Proxy(OrigDTF, {
      construct(target, args) {
        const locales = args.length > 0 ? args[0] : undefined;
        const options = args.length > 1 ? args[1] : undefined;
        const loc = (locales === undefined || locales === null) ? CFG.language : locales;
        return Reflect.construct(target, [loc, withTimeZone(options)]);
      },
      apply(target, thisArg, args) {
        const locales = args.length > 0 ? args[0] : undefined;
        const options = args.length > 1 ? args[1] : undefined;
        const loc = (locales === undefined || locales === null) ? CFG.language : locales;
        return Reflect.construct(target, [loc, withTimeZone(options)]);
      }
    });
    hookValue(Intl, 'DateTimeFormat', PatchedDTF);
  } catch (e) { /* ignore */ }

  const INTL_NAMES = [
    'DateTimeFormat', 'NumberFormat', 'Collator', 'RelativeTimeFormat',
    'ListFormat', 'DisplayNames', 'PluralRules', 'Segmenter', 'DurationFormat'
  ];
  for (const nm of INTL_NAMES) {
    const C = Intl[nm];
    if (!C || !C.prototype || typeof C.prototype.resolvedOptions !== 'function') continue;
    const origRO = C.prototype.resolvedOptions;
    hookValue(C.prototype, 'resolvedOptions', function resolvedOptions() {
      const o = origRO.call(this);
      if (!CFG.enabled) return o;
      try {
        if (nm === 'DateTimeFormat') o.timeZone = CFG.timeZone;
        if (o.locale && /^zh/i.test(String(o.locale))) o.locale = CFG.language;
      } catch (e) { /* ignore */ }
      return o;
    });
  }

  /* ================= 2. 浏览器语言 ================= */

  const langDesc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'language');
  if (langDesc && langDesc.get) {
    const orig = langDesc.get;
    hookGetter(Navigator.prototype, 'language', function () {
      return CFG.enabled ? CFG.language : orig.call(this);
    });
  }

  const langsDesc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'languages');
  if (langsDesc && langsDesc.get) {
    const orig = langsDesc.get;
    hookGetter(Navigator.prototype, 'languages', function () {
      if (!CFG.enabled) return orig.call(this);
      const list = [CFG.language];
      if (!/^en/i.test(CFG.language)) list.push('en');
      return Object.freeze(list);
    });
  }

  /* ================= 3 + 4. 中文字体 / 国产厂商字体 ================= */

  // 按「中文字体 / 中文（繁体）字体 / 国产厂商字体」三张名单覆盖。
  // 名单与 fuck-claude 检测脚本里实际探测的字体逐一对齐，额外的常见变体一并保留。
  const BLOCKED_FONT_RE = new RegExp(
    [
      // ---- 中文（简体）----
      'microsoft yahei', 'yahei', '微软雅黑', 'simsun', 'nsimsun', '宋体',
      'simhei', '黑体', 'kaiti', '楷体', 'fangsong', '仿宋', 'dengxian', '等线',
      'pingfang', '苹方', 'hiragino sans gb',
      'stheiti', 'stsong', 'stkaiti', 'stfangsong', 'stxihei', '华文',
      'songti', 'heiti',
      'source han', '思源',
      'noto sans cjk', 'noto serif cjk',
      'noto sans (sc|tc|hans|hant)', 'noto serif (sc|tc|hans|hant)',
      'wenquanyi', '文泉驿',
      // ---- 中文（繁体）----
      'microsoft jhenghei', 'jhenghei', 'pmingliu', 'mingliu', '细明体', 'msjh',
      'dfkai', 'lantinghei', '兰亭', 'yuanti', '圆体', 'lisu', '隶书',
      'youyuan', '幼圆', 'libian', '隶变', 'xingkai', 'wawati', '娃娃体',
      'weibei', '魏碑', 'hanzipen',
      // ---- 国产厂商 / 软件字体 ----
      'misans', 'mi sans', 'miui', 'xiaomi', '小米兰亭',
      'harmonyos', '鸿蒙', 'honor sans', 'oppo sans', 'vivo sans', 'huawei',
      'alibaba', '阿里巴巴', 'dingtalk', 'jinbuti',
      'douyin sans', '抖音', 'hyqihei',
      'hanyi', '汉仪', '\\bfz[a-z]', '方正',
      'smiley sans', '得意黑', 'lxgw', '霞鹜', 'sarasa', '更纱',
      'wps', 'kingsoft', '金山', 'zhuque', '朱雀', 'handianti', '汉典'
    ].join('|'),
    'i'
  );

  // 关键：把简写里「被禁用的族」整段**删掉**，而不是替换成 sans-serif。
  // 探测方的套路是：先量 `72px monospace` 得基线，再量 `72px "某字体", monospace`。
  // 若把被禁族换成 sans-serif，得到的是 sans-serif 的宽度，反而和 monospace 基线不同
  // → 会被判定成「该字体存在」。删掉之后剩下的族与基线完全一致，宽度差为 0。
  function stripBlockedFamilies(font) {
    const s = String(font);
    const m = s.match(
      /^([\s\S]*?[\d.]+(?:px|pt|pc|em|rem|ex|ch|vh|vw|%)(?:\s*\/\s*[\d.]+(?:px|pt|em|rem|%)?)?)([\s\S]*)$/i
    );
    if (!m) return '';
    const prefix = m[1];
    const kept = m[2]
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
      .filter((f) => !BLOCKED_FONT_RE.test(f));
    return kept.length ? prefix + ' ' + kept.join(', ') : '';
  }

  // 每个 canvas 上下文最近一次用过的「干净」字体，作为只剩被禁族时的兜底基线
  const lastCleanFont = new WeakMap();

  function patchCanvasMeasureText(proto) {
    if (!proto || typeof proto.measureText !== 'function') return;
    const orig = proto.measureText;
    hookValue(proto, 'measureText', function measureText(text) {
      if (!CFG.enabled || !CFG.blockFonts) return orig.call(this, text);
      let font = null;
      try { font = this.font; } catch (e) { /* ignore */ }
      if (typeof font !== 'string' || !font) return orig.call(this, text);
      if (!BLOCKED_FONT_RE.test(font)) {
        lastCleanFont.set(this, font);
        return orig.call(this, text);
      }
      const clean = stripBlockedFamilies(font) || lastCleanFont.get(this) || 'sans-serif';
      if (clean === font) return orig.call(this, text);
      try {
        this.font = clean;
        const r = orig.call(this, text);
        this.font = font;
        return r;
      } catch (e) {
        return orig.call(this, text);
      }
    });
  }

  patchCanvasMeasureText(CanvasRenderingContext2D.prototype);
  try {
    if (typeof OffscreenCanvasRenderingContext2D !== 'undefined') {
      patchCanvasMeasureText(OffscreenCanvasRenderingContext2D.prototype);
    }
  } catch (e) { /* ignore */ }

  // document.fonts.check()
  try {
    if (document.fonts) {
      let proto = Object.getPrototypeOf(document.fonts);
      while (proto && typeof proto.check !== 'function') proto = Object.getPrototypeOf(proto);
      if (proto) {
        const origCheck = proto.check;
        hookValue(proto, 'check', function check(font, text) {
          if (CFG.enabled && CFG.blockFonts && BLOCKED_FONT_RE.test(String(font))) return false;
          return origCheck.call(this, font, text);
        });
      }
    }
  } catch (e) { /* ignore */ }

  // Local Font Access API
  try {
    if (navigator.fonts && typeof navigator.fonts.queryLocalFonts === 'function') {
      const origQuery = navigator.fonts.queryLocalFonts;
      hookValue(navigator.fonts, 'queryLocalFonts', function queryLocalFonts() {
        return Promise.resolve(origQuery.apply(this, arguments)).then((list) => {
          if (!CFG.enabled || !CFG.blockFonts || !Array.isArray(list)) return list;
          return list.filter((f) => !BLOCKED_FONT_RE.test(String((f && f.family) || '')));
        });
      });
    }
  } catch (e) { /* ignore */ }

  /* ================= 5. WebRTC IP 泄露 ================= */

  const OrigRTC = window.RTCPeerConnection;
  if (typeof OrigRTC === 'function') {
    const hasRealIP = (s) =>
      /(\d{1,3}\.){3}\d{1,3}|[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,}/i.test(s) && !/\.local/i.test(s);

    const PatchedRTC = function RTCPeerConnection(config, constraints) {
      let effective = config;
      const active = CFG.enabled && CFG.blockWebRTC;
      if (active) {
        effective = Object.assign({}, config || {});
        effective.iceServers = [];
        effective.iceCandidatePoolSize = 0;
      }
      const pc = new OrigRTC(effective, constraints);

      if (active) {
        try {
          const origAdd = pc.addEventListener;
          pc.addEventListener = function (type, listener, opts) {
            if (type === 'icecandidate' && typeof listener === 'function') {
              const wrapped = function (ev) {
                const c = ev && ev.candidate && ev.candidate.candidate;
                if (c && hasRealIP(c)) return;
                return listener.call(this, ev);
              };
              hooked.set(wrapped, listener);
              return origAdd.call(this, type, wrapped, opts);
            }
            return origAdd.call(this, type, listener, opts);
          };
        } catch (e) { /* ignore */ }

        try {
          if (config) {
            const origGetCfg = pc.getConfiguration.bind(pc);
            hookValue(pc, 'getConfiguration', function getConfiguration() {
              if (CFG.enabled && CFG.blockWebRTC) return Object.assign({}, config);
              return origGetCfg();
            });
          }
        } catch (e) { /* ignore */ }
      }

      return pc;
    };

    try { Object.defineProperty(PatchedRTC, 'name', { value: 'RTCPeerConnection', configurable: true }); } catch (e) { /* ignore */ }
    try { PatchedRTC.prototype = OrigRTC.prototype; } catch (e) { /* ignore */ }

    hookValue(window, 'RTCPeerConnection', PatchedRTC);
    if (window.webkitRTCPeerConnection === OrigRTC) {
      hookValue(window, 'webkitRTCPeerConnection', PatchedRTC);
    }
  }

  /* ================= 6 + 7. 国产浏览器 / 国产品牌设备（UA / UA-CH） ================= */

  const CN_UA_RE = /(MicroMessenger|Weixin|QQBrowser|MQQBrowser|Quark|UCBrowser|UBrowser|BIDUBrowser|Baiduspider|Maxthon|TheWorld|2345Explorer|Sogou|LieBao|LBBROWSER|HuaweiBrowser|HBPC|HarmonyOS|ArkWeb|VivoBrowser|HeyTapBrowser|MiuiBrowser|XiaoMi|MiBro|OppoBrowser|HeyTap|HonorBrowser|AlipayClient|DingTalk|Weibo|ToutiaoMicroApp|ByteDance|NewsArticle|MZBrowser|Flysilk|Huawei|OPPO|VIVO|Xiaomi|Redmi|Realme|OnePlus|Meizu|Gionee|Smartisan|360Browser|QIHU)/i;

  function buildCleanUA(realUA) {
    const major = (realUA.match(/Chrome\/(\d+)/) || [])[1] || '126';
    const v = major + '.0.0.0';
    let platform = 'X11; Linux x86_64';
    let uaPlatform = 'Linux';
    if (/Windows/i.test(realUA)) { platform = 'Windows NT 10.0; Win64; x64'; uaPlatform = 'Windows'; }
    else if (/Macintosh|Mac OS X/i.test(realUA)) { platform = 'Macintosh; Intel Mac OS X 10_15_7'; uaPlatform = 'macOS'; }
    else if (/Android/i.test(realUA)) { platform = 'Linux; Android 13; Pixel 7'; uaPlatform = 'Android'; }
    else if (/iPhone|iPad/i.test(realUA)) { platform = 'iPhone; CPU iPhone OS 17_5 like Mac OS X'; uaPlatform = 'iOS'; }
    return {
      ua: `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36`,
      uaPlatform,
      fullVersion: v
    };
  }

  try {
    const realUA = navigator.userAgent;
    if (CN_UA_RE.test(realUA)) {
      const clean = buildCleanUA(realUA);
      const uaDesc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent')
        || Object.getOwnPropertyDescriptor(navigator, 'userAgent');
      if (uaDesc && uaDesc.get) {
        const orig = uaDesc.get;
        hookGetter(Navigator.prototype, 'userAgent', function () {
          return (CFG.enabled && CFG.sanitizeUA) ? clean.ua : orig.call(this);
        });
      }
      try {
        const avDesc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'appVersion');
        if (avDesc && avDesc.get) {
          const origAv = avDesc.get;
          hookGetter(Navigator.prototype, 'appVersion', function () {
            return (CFG.enabled && CFG.sanitizeUA) ? clean.ua.replace(/^Mozilla\//, '') : origAv.call(this);
          });
        }
      } catch (e) { /* ignore */ }

      const realUAD = navigator.userAgentData;
      if (realUAD) {
        const brands = [
          { brand: 'Not)A;Brand', version: '99' },
          { brand: 'Chromium', version: clean.fullVersion.split('.')[0] },
          { brand: 'Google Chrome', version: clean.fullVersion.split('.')[0] }
        ];
        const fakeUAD = {
          brands,
          mobile: false,
          platform: clean.uaPlatform,
          getHighEntropyValues() {
            return Promise.resolve({
              architecture: 'x86',
              bitness: '64',
              brands,
              fullVersionList: brands.map((b) => ({ brand: b.brand, version: clean.fullVersion })),
              mobile: false,
              model: '',
              platform: clean.uaPlatform,
              platformVersion: '10.15.7',
              uaFullVersion: clean.fullVersion,
              wow64: false
            });
          },
          toJSON() {
            return { brands, mobile: false, platform: clean.uaPlatform };
          }
        };
        const uadDesc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgentData');
        if (uadDesc && uadDesc.get) {
          const origUAD = uadDesc.get;
          hookGetter(Navigator.prototype, 'userAgentData', function () {
            return (CFG.enabled && CFG.sanitizeUA) ? fakeUAD : origUAD.call(this);
          });
        }
      }
    }
  } catch (e) { /* ignore */ }

  /* ================= 配置注入通道（来自 bridge.js） ================= */

  const ALLOW_KEYS = Object.keys(DEFAULTS);
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const data = ev.data;
    if (!data || data.__fpGuard !== true || !data.settings || typeof data.settings !== 'object') return;
    for (const k of ALLOW_KEYS) {
      if (Object.prototype.hasOwnProperty.call(data.settings, k) && data.settings[k] !== undefined) {
        CFG[k] = data.settings[k];
      }
    }
  }, false);
})();
