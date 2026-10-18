#!/usr/bin/env node
/* 域名单一真源同步工具
 * ------------------------------------------------------------------
 * domains.json 是扩展生效域名的唯一来源。本工具把它同步到三处：
 *   1. manifest.json 的 host_permissions
 *   2. manifest.json 里各 content_scripts[].matches
 *   3. src/background.js 的 SCOPED_DOMAINS（declarativeNetRequest 的
 *      requestDomains 只认裸域名，所以直接放 domains.json 里的条目）
 *
 * 用法：
 *   node tools/sync_domains.cjs           # 写入
 *   node tools/sync_domains.cjs --check   # 只校验，不一致时退出码 1
 *                                        # （可挂 CI / pre-commit 防分叉）
 *
 * 注意：Chrome MV3 的 match pattern 与 declarativeNetRequest.requestDomains
 * 都只接受域名，不支持 ASN / CIDR —— 想按 IP 段固定出口节点请用
 * Clash / Surge 规则集，不要写进这里。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOMAINS_FILE = path.join(ROOT, 'domains.json');
const MANIFEST_FILE = path.join(ROOT, 'manifest.json');
const BACKGROUND_FILE = path.join(ROOT, 'src', 'background.js');

const CHECK = process.argv.includes('--check');

const GENERATED_NOTE = '// 由 tools/sync_domains.cjs 从 domains.json 生成，请勿手改；加域名请改 domains.json';

function escRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 连上一轮生成的注释行一起匹配，保证重复执行是幂等的
const SCOPED_RE = new RegExp(
  '(?:' + escRe(GENERATED_NOTE) + '\\n)?const SCOPED_DOMAINS = \\[[\\s\\S]*?\\];'
);

// 一个像样儿的域名：若干标签 + 字母顶级域，总长 <= 253
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

function fail(msg) {
  console.error('x ' + msg);
  process.exit(1);
}

function loadDomains() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(DOMAINS_FILE, 'utf8'));
  } catch (e) {
    fail('domains.json 解析失败: ' + e.message);
  }

  const list = Array.isArray(raw) ? raw : raw.domains;
  if (!Array.isArray(list) || !list.length) fail('domains.json 里没有 domains 数组');

  const seen = new Set();
  const out = [];
  for (const item of list) {
    const domain = typeof item === 'string' ? item : item && item.domain;
    if (typeof domain !== 'string' || !DOMAIN_RE.test(domain)) {
      fail('非法域名条目: ' + JSON.stringify(item));
    }
    if (seen.has(domain)) fail('重复域名: ' + domain);
    seen.add(domain);
    // 字符串条目 / 未显式写 includeSubdomains 的条目 → 默认带通配子域
    const includeSubdomains = !(typeof item === 'object' && item && item.includeSubdomains === false);
    out.push({ domain, includeSubdomains });
  }
  return out;
}

/** Chrome match pattern：裸域 + （可选）通配子域 */
function matchPatterns(entry) {
  const p = ['*://' + entry.domain + '/*'];
  if (entry.includeSubdomains) p.push('*://*.' + entry.domain + '/*');
  return p;
}

function allPatterns(entries) {
  const out = [];
  for (const e of entries) for (const p of matchPatterns(e)) out.push(p);
  return out;
}

/* ---------- manifest.json ---------- */

function syncManifest(entries) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  } catch (e) {
    fail('manifest.json 解析失败: ' + e.message);
  }

  const patterns = allPatterns(entries);
  manifest.host_permissions = patterns;

  if (!Array.isArray(manifest.content_scripts) || !manifest.content_scripts.length) {
    fail('manifest.json 缺少 content_scripts');
  }
  let withMatches = 0;
  for (const cs of manifest.content_scripts) {
    if (!Array.isArray(cs.matches)) continue;
    cs.matches = patterns.slice();
    withMatches++;
  }
  if (withMatches < 2) {
    fail('manifest.json 里应有至少 2 个带 matches 的 content_scripts，实际 ' + withMatches);
  }

  // 附带校验：ua-patterns.js 必须排在 spoof.js 之前
  // （同为 MAIN world，同一 run_at，按 js 数组顺序执行）
  for (const cs of manifest.content_scripts) {
    if (cs.world !== 'MAIN' || !Array.isArray(cs.js)) continue;
    const iPat = cs.js.indexOf('src/ua-patterns.js');
    const iSpoof = cs.js.indexOf('src/spoof.js');
    if (iSpoof !== -1 && (iPat === -1 || iPat > iSpoof)) {
      fail('manifest.json: src/ua-patterns.js 必须排在 src/spoof.js 之前注入');
    }
  }

  // cosmetic：单元素数组压回一行，避免 JSON.stringify 展开造成的无意义 diff
  const text = JSON.stringify(manifest, null, 2)
    .replace(/\[\s*\n\s*("(?:[^"\\]|\\.)*")\s*\n\s*\]/g, '[$1]') + '\n';
  return text;
}

/* ---------- src/background.js ---------- */

function syncBackground(entries) {
  let src;
  try {
    src = fs.readFileSync(BACKGROUND_FILE, 'utf8');
  } catch (e) {
    fail('src/background.js 读取失败: ' + e.message);
  }

  const re = SCOPED_RE;
  if (!re.test(src)) fail('src/background.js 里找不到 SCOPED_DOMAINS 定义');

  const domains = entries.map((e) => e.domain);
  const oneLine = "const SCOPED_DOMAINS = ['" + domains.join("', '") + "'];";
  const block = oneLine.length <= 110
    ? oneLine
    : 'const SCOPED_DOMAINS = [\n' + domains.map((d) => "  '" + d + "'").join(',\n') + '\n];';

  const generated = GENERATED_NOTE + '\n' + block;

  // 函数式替换，避免域名里万一出现 $ 特殊序列被当成替换引用
  return src.replace(re, () => generated);
}

/* ---------- main ---------- */

function main() {
  const entries = loadDomains();
  const manifestText = syncManifest(entries);
  const backgroundText = syncBackground(entries);

  if (CHECK) {
    const problems = [];
    if (fs.readFileSync(MANIFEST_FILE, 'utf8') !== manifestText) problems.push('manifest.json');
    if (fs.readFileSync(BACKGROUND_FILE, 'utf8') !== backgroundText) problems.push('src/background.js');
    if (problems.length) {
      console.error('x 以下文件与 domains.json 不一致: ' + problems.join(', '));
      console.error('  跑 node tools/sync_domains.cjs 重新生成');
      process.exit(1);
    }
    console.log('ok domains.json -> manifest.json / src/background.js 一致（' +
      entries.length + ' 个域名）');
    return;
  }

  fs.writeFileSync(MANIFEST_FILE, manifestText);
  fs.writeFileSync(BACKGROUND_FILE, backgroundText);
  console.log('ok 已同步 ' + entries.length + ' 个域名 -> manifest.json / src/background.js');
  for (const e of entries) {
    console.log('    ' + e.domain + (e.includeSubdomains ? '' : '  （仅精确域，不含子域）'));
  }
}

main();
