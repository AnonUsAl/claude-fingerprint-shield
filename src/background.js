/* Claude 低风险指纹 —— Service Worker
 * 职责：
 *  1. 维护默认设置
 *  2. 按设置同步 declarativeNetRequest 动态规则（重写 accept-language 请求头）
 */

const DEFAULT_SETTINGS = {
  enabled: true,
  timeZone: 'America/New_York',
  language: 'en-US',
  blockFonts: true,
  blockWebRTC: true,
  sanitizeUA: true,
  spoofAcceptLanguage: true
};

const SCOPED_DOMAINS = ['claude.ai', 'claude.com', 'anthropic.com', 'fuck-claude.vercel.app'];

const ALL_RESOURCE_TYPES = [
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font',
  'object', 'xmlhttprequest', 'ping', 'csp_report', 'media',
  'websocket', 'webtransport', 'webbundle', 'other'
];

const RULE_ID_ACCEPT_LANGUAGE = 1;

function normalizeSettings(raw) {
  const s = Object.assign({}, DEFAULT_SETTINGS, raw || {});
  if (typeof s.timeZone !== 'string' || !s.timeZone) s.timeZone = DEFAULT_SETTINGS.timeZone;
  if (typeof s.language !== 'string' || !s.language) s.language = DEFAULT_SETTINGS.language;
  return s;
}

async function getSettings() {
  try {
    const res = await chrome.storage.local.get('settings');
    return normalizeSettings(res && res.settings);
  } catch (e) {
    return normalizeSettings(null);
  }
}

async function syncRules(settings) {
  const removeRuleIds = [RULE_ID_ACCEPT_LANGUAGE];
  const addRules = [];

  if (settings.enabled && settings.spoofAcceptLanguage) {
    addRules.push({
      id: RULE_ID_ACCEPT_LANGUAGE,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          {
            header: 'accept-language',
            operation: 'set',
            value: settings.language + ',en;q=0.9'
          }
        ]
      },
      condition: {
        requestDomains: SCOPED_DOMAINS,
        resourceTypes: ALL_RESOURCE_TYPES
      }
    });
  }

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  } catch (e) {
    console.warn('[FP Guard] 同步 DNR 规则失败（不影响页面内伪装）：', e);
  }
}

async function bootstrap() {
  const settings = await getSettings();
  try {
    await chrome.storage.local.set({ settings });
  } catch (e) { /* ignore */ }
  await syncRules(settings);
}

chrome.runtime.onInstalled.addListener(() => { bootstrap(); });
chrome.runtime.onStartup.addListener(() => { bootstrap(); });

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  syncRules(normalizeSettings(changes.settings.newValue));
});
