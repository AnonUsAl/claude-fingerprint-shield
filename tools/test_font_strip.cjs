/* 字体拦截的回归测试（纯 Node，不需要浏览器）
 *
 * 思路：造一个「假 canvas」——measureText 按当前 font 里第一个可用族返回宽度，
 * 然后把 fuck-claude 检测脚本里的 m() 探测函数原样搬进来跑，
 * 对比「未打补丁 / 打了 spoof.js 补丁」两次的判定结果。
 *
 * 运行： node tools/test_font_strip.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* ---------- 1. 模拟这台机器装了哪些字体 + 每种字体的度量宽度 ---------- */

const INSTALLED = new Set([
  // 中文字体（简体）
  'PingFang SC', 'Hiragino Sans GB', 'Songti SC', 'STHeiti', 'SimSun',
  // 中文字体（繁体）
  'Microsoft JhengHei', 'PingFang HK', 'DFKai-SB',
  // 国产厂商字体
  'MiSans', 'HarmonyOS Sans SC', 'Alibaba PuHuiTi', 'HYQiHei', 'DingTalk JinBuTi',
  // 与检测无关的正常字体（对照组，不该被误伤）
  'Arial'
]);

const GENERIC_W = { monospace: 130, 'sans-serif': 100, serif: 112 };
const FONT_W = {
  'PingFang SC': 88, 'Hiragino Sans GB': 90, 'Songti SC': 92, 'STHeiti': 87, SimSun: 86,
  'Microsoft JhengHei': 89, 'PingFang HK': 88, 'DFKai-SB': 91,
  MiSans: 84, 'HarmonyOS Sans SC': 83, 'Alibaba PuHuiTi': 85, HYQiHei: 82, 'DingTalk JinBuTi': 81,
  Arial: 101
};

function parseFamilies(font) {
  const m = String(font).match(/^[\s\S]*?[\d.]+(?:px|pt|em|rem)(?:\s*\/\s*[\d.]+(?:px|pt|em|rem)?)?\s+([\s\S]*)$/i);
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

function resolveFamily(font) {
  for (const f of parseFamilies(font)) {
    if (INSTALLED.has(f)) return f;
    if (GENERIC_W[f] !== undefined) return f;
  }
  return 'sans-serif';
}

function glyphWidth(text, fam) {
  const base = FONT_W[fam] !== undefined ? FONT_W[fam] : (GENERIC_W[fam] || 100);
  return text.length * base * 0.6 + base;
}

// 假 canvas：font 的 setter/getter 行为与真实 canvas 一致（原样返回）
class Ctx2D {
  constructor() { this._f = '10px sans-serif'; }
  get font() { return this._f; }
  set font(v) { this._f = String(v); }
  measureText(text) { return { width: glyphWidth(text, resolveFamily(this._f)) }; }
}
globalThis.CanvasRenderingContext2D = Ctx2D;

/* ---------- 2. 检测站里原样搬过来的探测函数 ---------- */
// function m(e,t){let n=`中文字体检测ABCabc012`,r=`72px`;
//   return [`monospace`,`sans-serif`,`serif`].some(i=>{ ... Math.abs(o-a)>.5 })}
function m(name, t) {
  const n = '中文字体检测ABCabc012';
  const r = '72px';
  return ['monospace', 'sans-serif', 'serif'].some((i) => {
    t.font = `${r} ${i}`;
    const a = t.measureText(n).width;
    t.font = `${r} "${name}", ${i}`;
    const o = t.measureText(n).width;
    return Math.abs(o - a) > 0.5;
  });
}

// 检测站实际探测的三张名单
const FONTS_SIMPLIFIED = ['Microsoft YaHei', 'Microsoft YaHei UI', 'SimSun', 'NSimSun', 'SimHei',
  'KaiTi', 'FangSong', 'DengXian', 'PingFang SC', 'Hiragino Sans GB', 'STHeiti', 'STSong',
  'Songti SC', 'Source Han Sans CN', 'Source Han Sans SC', 'Noto Sans CJK SC',
  'Noto Serif CJK SC', 'WenQuanYi Micro Hei', 'WenQuanYi Zen Hei'];
const FONTS_TRADITIONAL = ['Microsoft JhengHei', 'PMingLiU', 'MingLiU', 'DFKai-SB',
  'PingFang TC', 'PingFang HK', 'Source Han Sans TW', 'Noto Sans CJK TC'];
const FONTS_VENDOR = ['MiSans', 'MIUI', 'HarmonyOS Sans SC', 'HarmonyOS Sans', 'HONOR Sans',
  'OPPO Sans', 'vivo Sans', 'Alibaba PuHuiTi', 'Alibaba Sans', 'DingTalk JinBuTi', 'Douyin Sans',
  'HYQiHei', 'FZShuSong-Z01S', 'FZKai-Z03S', 'FZHei-B01S', 'FZFangSong-Z02S'];

function scan(list) {
  const t = new Ctx2D();
  return list.filter((f) => m(f, t));
}

/* ---------- 3. 第一次：未打补丁（复现线上「明明装了拦截却仍被判命中」） ---------- */

const before = {
  simplified: scan(FONTS_SIMPLIFIED),
  traditional: scan(FONTS_TRADITIONAL),
  vendor: scan(FONTS_VENDOR),
  controlArial: m('Arial', new Ctx2D())
};

/* ---------- 4. 加载 spoof.js（在独立 vm 上下文里，喂 DOM 桩） ---------- */

const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'spoof.js'), 'utf8');

class Navigator {}
for (const [k, v] of [['language', 'zh-CN'], ['languages', ['zh-CN', 'zh']]]) {
  Object.defineProperty(Navigator.prototype, k, { get: () => v, configurable: true, enumerable: true });
}

const sandbox = {
  console,
  OffscreenCanvasRenderingContext2D: undefined,
  Navigator,
  CanvasRenderingContext2D: Ctx2D,
  addEventListener: () => {},
  document: { fonts: null, createElement: () => ({ getContext: () => new Ctx2D() }) },
  navigator: {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    language: 'zh-CN',
    languages: ['zh-CN', 'zh'],
    platform: 'MacIntel'
  }
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

const CFG = sandbox.window.__FP_GUARD__;
console.log('spoof.js 已加载，CFG =', JSON.stringify(CFG), '\n');

/* ---------- 5. 第二次：打了补丁 ---------- */

const after = {
  simplified: scan(FONTS_SIMPLIFIED),
  traditional: scan(FONTS_TRADITIONAL),
  vendor: scan(FONTS_VENDOR),
  controlArial: m('Arial', new Ctx2D())
};

/* ---------- 6. 复刻检测站的两个打分公式 ---------- */

function scoreFonts(simplified, traditional) {
  if (simplified.length >= 1) return Math.min(1, 0.75 + 0.08 * simplified.length);
  if (traditional.length >= 1) return 0.2;
  return 0;
}
function scoreVendor(vendor) {
  return vendor.length >= 2 ? 1 : vendor.length === 1 ? 0.8 : 0;
}

const rows = [
  ['中文字体', 14, before, after, (r) => scoreFonts(r.simplified, r.traditional)],
  ['国产厂商字体', 10, before, after, (r) => scoreVendor(r.vendor)]
];

const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));
console.log(pad('信号', 14) + pad('权重', 6) + pad('补丁前得分', 12) + pad('补丁前贡献', 12) + '补丁后得分/贡献');
console.log('-'.repeat(78));
for (const [name, w, b, a, fn] of rows) {
  const sb = fn(b), sa = fn(a);
  console.log(pad(name, 14) + pad(w, 6) + pad(sb.toFixed(2), 12) +
    pad('+' + Math.round(w * sb), 12) + sa.toFixed(2) + '  →  +' + Math.round(w * sa));
}

console.log('\n补丁前命中的字体：');
console.log('  简体 :', before.simplified.join(', ') || '(无)');
console.log('  繁体 :', before.traditional.join(', ') || '(无)');
console.log('  厂商 :', before.vendor.join(', ') || '(无)');
console.log('\n补丁后命中的字体：');
console.log('  简体 :', after.simplified.join(', ') || '(无) ✅');
console.log('  繁体 :', after.traditional.join(', ') || '(无) ✅');
console.log('  厂商 :', after.vendor.join(', ') || '(无) ✅');
console.log('\n对照组（不该被误伤）：');
console.log('  Arial 装没装？ 补丁前 =', before.controlArial, ' 补丁后 =', after.controlArial,
  after.controlArial === true ? '✅ 仍能正确识别' : '❌ 被误伤');

console.log('\n--- 边界：字体串里只剩被禁族（无通用族兜底）---');
const ctxEdge = new Ctx2D();
ctxEdge.font = '72px monospace';
const baseW = ctxEdge.measureText('中文字体检测ABCabc012').width;
ctxEdge.font = '72px "PingFang SC"';
const edgeW = ctxEdge.measureText('中文字体检测ABCabc012').width;
console.log('  基线 72px monospace =', baseW.toFixed(2), ' 仅 PingFang SC =', edgeW.toFixed(2),
  Math.abs(edgeW - baseW) <= 0.5 ? '✅ 与基线一致，不被识破' : '❌ 与基线不同');

console.log('\n--- 根因对照：旧实现「替换成 sans-serif」为什么会被识破 ---');
const oldSanitize = (font) =>
  String(font).replace(/("([^"]*)"|'([^']*)'|([^,\s"']+))/g, (mm, _a, dq, sq, unq) => {
    const name = dq !== undefined ? dq : (sq !== undefined ? sq : unq);
    return /pingfang|yahei|misans/i.test(name) ? 'sans-serif' : mm;
  });
{
  const c = new Ctx2D();
  const n = '中文字体检测ABCabc012';
  c.font = '72px monospace';
  const baseline = c.measureText(n).width;
  const candidate = '72px "PingFang SC", monospace';
  const oldFont = oldSanitize(candidate);
  c.font = oldFont;
  const oldW = c.measureText(n).width;
  c.font = candidate;
  const newW = c.measureText(n).width;
  console.log('  基线                   : 72px monospace      →', baseline.toFixed(2));
  console.log('  旧实现改写成           :', oldFont.padEnd(30), '→', oldW.toFixed(2),
    Math.abs(oldW - baseline) > 0.5 ? '❌ 与基线不同 ⇒ 判为「字体存在」' : 'ok');
  console.log('  新实现改写成           :', '72px monospace'.padEnd(30), '→', newW.toFixed(2),
    Math.abs(newW - baseline) <= 0.5 ? '✅ 与基线一致 ⇒ 判为「字体不存在」' : 'fail');
}

const ok = after.simplified.length === 0 && after.traditional.length === 0 &&
  after.vendor.length === 0 && after.controlArial === true &&
  Math.abs(edgeW - baseW) <= 0.5;
console.log('\n结论：', ok ? '✅ 全部通过' : '❌ 存在失败项');
process.exit(ok ? 0 : 1);
