/* Claude 低风险指纹 —— 控制面板
 *
 * 打分模型按 fuck-claude 检测脚本的实际实现复刻：
 *   权重  timezone 24 / language 18 / fonts 14 / vendorFonts 10 / webrtcLeak 10 /
 *         cnBrowser 8 / deviceVendor 6 / intlLocale 4 / timezoneOffset 3 / emoji 3
 *   每一项算出 0~1 的 score，贡献 = round(权重 × score)
 *
 * 注意：本页面是扩展页面，content script 不会注入到这里，
 * 所以这里读到的是未伪装的原生环境。
 */

const DEFAULTS = {
  enabled: true,
  timeZone: 'America/New_York',
  language: 'en-US',
  blockFonts: true,
  blockWebRTC: true,
  sanitizeUA: true,
  spoofAcceptLanguage: true
};

const WEIGHTS = [
  { key: 'timezone', name: '系统时区', w: 24 },
  { key: 'language', name: '浏览器语言', w: 18 },
  { key: 'fonts', name: '已安装中文字体', w: 14 },
  { key: 'vendorFonts', name: '国产厂商字体', w: 10 },
  { key: 'webrtcLeak', name: 'WebRTC IP 泄露', w: 10 },
  { key: 'cnBrowser', name: '国产浏览器 / WebView', w: 8 },
  { key: 'deviceVendor', name: '国产品牌设备', w: 6 },
  { key: 'intlLocale', name: 'Intl 区域设置', w: 4 },
  { key: 'timezoneOffset', name: '时区偏移', w: 3 },
  { key: 'emoji', name: 'Emoji 渲染风格', w: 3 }
];

// 检测站的中国大陆时区名单（另有港澳为部分分）
const CN_TIMEZONES = ['Asia/Shanghai', 'Asia/Urumqi', 'Asia/Chongqing', 'Asia/Chungking', 'Asia/Harbin', 'Asia/Kashgar'];
const CN_PARTIAL_TIMEZONES = ['Asia/Hong_Kong', 'Asia/Macau'];

// 检测站实际探测的三张字体名单（逐字对齐）
const CJK_SIMPLIFIED = ['Microsoft YaHei', 'Microsoft YaHei UI', 'SimSun', 'NSimSun', 'SimHei',
  'KaiTi', 'FangSong', 'DengXian', 'PingFang SC', 'Hiragino Sans GB', 'STHeiti', 'STSong',
  'Songti SC', 'Source Han Sans CN', 'Source Han Sans SC', 'Noto Sans CJK SC',
  'Noto Serif CJK SC', 'WenQuanYi Micro Hei', 'WenQuanYi Zen Hei'];
const CJK_TRADITIONAL = ['Microsoft JhengHei', 'PMingLiU', 'MingLiU', 'DFKai-SB',
  'PingFang TC', 'PingFang HK', 'Source Han Sans TW', 'Noto Sans CJK TC'];
const VENDOR_FONTS = ['MiSans', 'MIUI', 'HarmonyOS Sans SC', 'HarmonyOS Sans', 'HONOR Sans',
  'OPPO Sans', 'vivo Sans', 'Alibaba PuHuiTi', 'Alibaba Sans', 'DingTalk JinBuTi', 'Douyin Sans',
  'HYQiHei', 'FZShuSong-Z01S', 'FZKai-Z03S', 'FZHei-B01S', 'FZFangSong-Z02S'];

// UA 国产标识正则与 spoof.js 共用同一份真源（src/ua-patterns.js，由 popup.html 引入）。
// 浏览器标识与设备品牌分开判断：Huawei / OPPO 这类词在 UA 里是设备品牌，
// 拿来判「国产浏览器」会误伤。拿不到真源时用永不命中的正则兜底，面板照常渲染。
const PATTERNS = window[Symbol.for('claude-fp-shield.ua-patterns.v1')] || null;
const CN_BROWSER_RE = PATTERNS ? PATTERNS.CN_BROWSER_RE : /(?!)/;
const CN_DEVICE_RE = PATTERNS ? PATTERNS.CN_DEVICE_RE : /(?!)/;

let settings = Object.assign({}, DEFAULTS);
let webrtcState = 'unknown';

/* ---------------- 字体探测 ---------------- */

let probeCtx = null;
function ctx() {
  if (!probeCtx) probeCtx = document.createElement('canvas').getContext('2d');
  return probeCtx;
}
const BASELINES = ['monospace', 'sans-serif', 'serif'];
const PROBE_TEXT = '\u4e2d\u6587\u5b57\u4f53\u68c0\u6d4bABCabc012';

// 与检测站同款算法：候选字体 + 通用族，和纯通用族的宽度比对
function fontAvailable(name) {
  try {
    const c = ctx();
    return BASELINES.some((b) => {
      c.font = '72px ' + b;
      const a = c.measureText(PROBE_TEXT).width;
      c.font = '72px "' + name + '", ' + b;
      const o = c.measureText(PROBE_TEXT).width;
      return Math.abs(o - a) > 0.5;
    });
  } catch (e) {
    return false;
  }
}

function countFonts(list) {
  let n = 0;
  for (const f of list) if (fontAvailable(f)) n++;
  return n;
}

/* ---------------- WebRTC 真实泄露检测 ---------------- */

function webrtcLeakTest(timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    let pc = null;
    const ips = new Set();
    const finish = (v) => {
      if (done) return;
      done = true;
      try { if (pc) pc.close(); } catch (e) { /* ignore */ }
      resolve(v);
    };
    try {
      pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun.cloudflare.com:3478' }
        ]
      });
    } catch (e) {
      return finish('unknown');
    }
    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return finish(ips.size ? 'leak' : 'clean');
      const c = ev.candidate.candidate || '';
      const m = c.match(/(\d{1,3}\.){3}\d{1,3}|[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,}/i);
      if (m && !/\.local/i.test(c)) ips.add(m[0]);
    };
    try {
      pc.createDataChannel('fp-guard');
      pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => finish('unknown'));
    } catch (e) {
      finish('unknown');
    }
    setTimeout(() => finish(ips.size ? 'leak' : 'clean'), timeoutMs || 3000);
  });
}

/* ---------------- 各项打分（复刻检测站公式） ---------------- */

function languageScore() {
  const langs = (navigator.languages && navigator.languages.length
    ? navigator.languages : [navigator.language || '']).map((x) => String(x).toLowerCase());
  const first = langs[0] || '';
  const trad = langs.findIndex((x) => x.startsWith('zh-tw') || x.startsWith('zh-hk')
    || x.startsWith('zh-mo') || x.includes('hant'));
  if (first.startsWith('zh-cn') || first.includes('hans') || (first === 'zh' && trad === -1)) return 1;
  if (first.startsWith('zh') && trad !== -1) return 0.5;
  if (langs.some((x) => x.startsWith('zh'))) return 0.4;
  return 0;
}

function emojiInfo() {
  const t = ((navigator.platform || '') + ' ' + (navigator.userAgent || '')).toLowerCase();
  let vendor = 'Unknown';
  if (/iphone|ipad|ipod|mac/.test(t)) vendor = 'Apple';
  else if (/android/.test(t)) vendor = 'Google';
  else if (/win/.test(t)) vendor = 'Microsoft';
  else if (/cros/.test(t)) vendor = 'Google';
  else if (/linux/.test(t)) vendor = 'Linux / Other';
  const table = { Apple: 0.25, Microsoft: 0.4, Google: 0.35, 'Linux / Other': 0.5, Unknown: 0.4 };
  return { vendor, score: table[vendor] !== undefined ? table[vendor] : 0.4 };
}

function detectNow() {
  const ua = navigator.userAgent || '';
  const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; } })();
  const locale = (() => { try { return Intl.DateTimeFormat().resolvedOptions().locale || ''; } catch (e) { return ''; } })();

  const sl = countFonts(CJK_SIMPLIFIED);
  const tl = countFonts(CJK_TRADITIONAL);
  const vf = countFonts(VENDOR_FONTS);

  const fontsScore = sl >= 1 ? Math.min(1, 0.75 + 0.08 * sl) : (tl >= 1 ? 0.2 : 0);
  const vendorScore = vf >= 2 ? 1 : (vf === 1 ? 0.8 : 0);

  let tzScore = 0;
  if (CN_TIMEZONES.indexOf(tz) !== -1) tzScore = 1;
  else if (CN_PARTIAL_TIMEZONES.indexOf(tz) !== -1) tzScore = 0.5;

  const lo = locale.toLowerCase();
  const intlScore = (lo.startsWith('zh-cn') || lo.includes('hans') || lo === 'zh')
    ? 1 : (lo.startsWith('zh') ? 0.5 : 0);

  const brands = (() => { try { return JSON.stringify((navigator.userAgentData && navigator.userAgentData.brands) || []); } catch (e) { return ''; } })();
  const model = (() => { try { return (navigator.userAgentData && navigator.userAgentData.model) || ''; } catch (e) { return ''; } })();
  const cnBrowserHit = CN_BROWSER_RE.test(ua + ' ' + brands);
  const deviceHit = CN_DEVICE_RE.test(ua + ' ' + model + ' ' + brands);
  const em = emojiInfo();
  const off = new Date().getTimezoneOffset();

  return {
    timezone: { score: tzScore, raw: tz || 'unknown' },
    language: { score: languageScore(), raw: (navigator.languages || []).slice(0, 3).join(', ') || 'unknown' },
    fonts: { score: fontsScore, raw: '简体 ' + sl + ' 个 / 繁体 ' + tl + ' 个' },
    vendorFonts: { score: vendorScore, raw: vf + ' 个' },
    webrtcLeak: { score: webrtcState === 'leak' ? 1 : 0, raw: webrtcState, unknown: webrtcState === 'unknown' },
    cnBrowser: { score: cnBrowserHit ? 1 : 0, raw: cnBrowserHit ? '命中国产标识' : '未命中' },
    deviceVendor: { score: deviceHit ? 1 : 0, raw: model || '未命中' },
    intlLocale: { score: intlScore, raw: locale || 'unknown' },
    timezoneOffset: { score: off === -480 ? 1 : 0, raw: 'UTC' + (off <= 0 ? '+' : '-') + Math.abs(off / 60) },
    emoji: { score: em.score, raw: em.vendor + ' style' }
  };
}

function projectAfter(now) {
  if (!settings.enabled) {
    const o = {};
    for (const k of WEIGHTS) o[k.key] = now[k.key];
    return o;
  }
  const o = {};
  for (const k of WEIGHTS) {
    o[k.key] = { score: now[k.key].score, raw: now[k.key].raw, unknown: now[k.key].unknown };
  }
  o.timezone.score = 0;
  o.language.score = 0;
  o.intlLocale.score = 0;
  o.timezoneOffset.score = 0;
  if (settings.blockFonts) { o.fonts.score = 0; o.vendorFonts.score = 0; }
  if (settings.blockWebRTC) o.webrtcLeak.score = 0;
  if (settings.sanitizeUA) { o.cnBrowser.score = 0; o.deviceVendor.score = 0; }
  // emoji 由系统厂商决定 —— 检测方给 Apple 的 0.25 已是全表最低档，改不动
  return o;
}

function contribution(entry, weight) {
  if (!entry || entry.unknown) return null;
  return Math.round(weight * entry.score);
}

/* ---------------- 渲染 ---------------- */

function bandOf(score) {
  if (score <= 30) return { label: '低风险', cls: 'tok' };
  if (score <= 60) return { label: '中风险', cls: 'tmid' };
  return { label: '高风险', cls: 'tbad' };
}

function render() {
  const now = detectNow();
  const after = projectAfter(now);

  let totalNow = 0;
  let totalAfter = 0;
  let hasUnknown = false;
  for (const k of WEIGHTS) {
    const a = contribution(now[k.key], k.w);
    const b = contribution(after[k.key], k.w);
    if (a === null || b === null) hasUnknown = true;
    totalNow += a || 0;
    totalAfter += b || 0;
  }

  document.getElementById('scoreNow').textContent = String(totalNow) + (hasUnknown ? '+' : '');
  document.getElementById('scoreAfter').textContent = String(totalAfter) + (hasUnknown ? '+' : '');

  const bNow = bandOf(totalNow);
  const bAfter = bandOf(totalAfter);
  const elNow = document.getElementById('tagNow');
  const elAfter = document.getElementById('tagAfter');
  elNow.textContent = bNow.label;
  elNow.className = 'score-tag ' + bNow.cls;
  elAfter.textContent = bAfter.label + (totalAfter <= 1 ? '（已到底）' : '');
  elAfter.className = 'score-tag ' + bAfter.cls;
  document.getElementById('cardAfter').classList.toggle('after', totalAfter < totalNow);

  const tbody = document.getElementById('signalRows');
  tbody.textContent = '';
  for (const k of WEIGHTS) {
    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    tdName.className = 'nm';
    tdName.textContent = k.name;
    if (now[k.key].raw) tdName.title = String(now[k.key].raw);

    const tdW = document.createElement('td');
    tdW.className = 'w';
    tdW.textContent = String(k.w);

    const mk = (val) => {
      const td = document.createElement('td');
      td.className = 'st';
      const s = document.createElement('span');
      if (val === null) {
        s.className = 'pill unknown';
        s.textContent = '?';
      } else if (val === 0) {
        s.className = 'pill clean';
        s.textContent = '0';
      } else {
        s.className = 'pill hit';
        s.textContent = '+' + val;
      }
      td.appendChild(s);
      return td;
    };

    tr.append(tdName, tdW, mk(contribution(now[k.key], k.w)), mk(contribution(after[k.key], k.w)));
    tbody.appendChild(tr);
  }
}

/* ---------------- 绑定 ---------------- */

function syncBodyClass() {
  document.body.classList.toggle('disabled', !settings.enabled);
  document.getElementById('dot').classList.toggle('on', !!settings.enabled);
}

function save() {
  try { chrome.storage.local.set({ settings }); } catch (e) { /* ignore */ }
  render();
}

function bind() {
  const el = (id) => document.getElementById(id);

  el('enabled').checked = !!settings.enabled;
  el('timeZone').value = settings.timeZone;
  el('language').value = settings.language;
  el('blockFonts').checked = !!settings.blockFonts;
  el('blockWebRTC').checked = !!settings.blockWebRTC;
  el('sanitizeUA').checked = !!settings.sanitizeUA;
  el('spoofAcceptLanguage').checked = !!settings.spoofAcceptLanguage;
  syncBodyClass();

  el('enabled').addEventListener('change', (e) => { settings.enabled = e.target.checked; syncBodyClass(); save(); });
  el('timeZone').addEventListener('change', (e) => { settings.timeZone = e.target.value; save(); });
  el('language').addEventListener('change', (e) => { settings.language = e.target.value; save(); });
  for (const id of ['blockFonts', 'blockWebRTC', 'sanitizeUA', 'spoofAcceptLanguage']) {
    el(id).addEventListener('change', (e) => { settings[id] = e.target.checked; save(); });
  }
  el('rescan').addEventListener('click', () => {
    webrtcState = 'unknown';
    render();
    webrtcLeakTest(3000).then((v) => { webrtcState = v; render(); });
  });
}

function init() {
  try {
    chrome.storage.local.get('settings', (res) => {
      settings = Object.assign({}, DEFAULTS, (res && res.settings) || {});
      bind();
      render();
      webrtcLeakTest(3000).then((v) => { webrtcState = v; render(); });
    });
  } catch (e) {
    bind();
    render();
  }
}

init();
