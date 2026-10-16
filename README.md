# Claude 低风险指纹 · claude-fingerprint-shield

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue.svg)](manifest.json)
[![Chromium 111+](https://img.shields.io/badge/Chromium-111%2B-4285F4.svg)](#3-安装)

一个 Chrome / Edge / Brave（Chromium 111+）MV3 扩展：**只在 Claude 相关站点上**，把浏览器暴露出去的
「中国大陆环境」区域指纹伪装成非中国环境，从而在
[fuck-claude.vercel.app](https://fuck-claude.vercel.app/zh/) 那套 10 项加权模型里把风险分打下来。

> 它不改变你的 IP，也不碰账号——只是把浏览器最容易被抓的那几个破绽抹平。
> **风险分低 ≠ 不会被封**，务必先读 [第 5 节](#5-降不了的东西重要)。

---

## 1. 它伪装哪 10 项

| # | 信号 | 权重 | 本扩展的做法 |
|---|------|:---:|------|
| 1 | 系统时区 | **24** | 代理 `Intl.DateTimeFormat`（含 `resolvedOptions().timeZone`），默认 `America/New_York` |
| 2 | 浏览器语言 | **18** | 覆写 `navigator.language` / `navigator.languages`，默认 `en-US` |
| 3 | 已安装中文字体 | **14** | 让 canvas 字体探测对中文/繁中/CJK 开源字体一律量出「基线宽度」，判定为不存在 |
| 4 | 国产厂商字体 | **10** | 同上，覆盖 MiSans / MIUI / HarmonyOS Sans / OPPO Sans / vivo Sans / Alibaba Sans / DingTalk JinBuTi / HYQiHei / 汉仪 / 方正 等 |
| 5 | WebRTC IP 泄露 | **10** | 构造 `RTCPeerConnection` 时清空 `iceServers`，并过滤掉携带真实 IP 的 `icecandidate` |
| 6 | 国产浏览器 / WebView | **8** | UA 命中微信/QQ/夸克/UC/搜狗/360/华为/小米/OPPO/vivo 等标识时，替换为干净 Chromium UA |
| 7 | 国产品牌设备 | **6** | 同上，一并净化 `navigator.userAgentData`（brands / platform / getHighEntropyValues） |
| 8 | Intl 区域设置 | **4** | 所有 `Intl.*` 的 `resolvedOptions().locale` 若为 `zh-*` 则改为目标语言 |
| 9 | 时区偏移 | **3** | 覆写 `Date.prototype.getTimezoneOffset`，按目标时区实时计算 |
| 10 | Emoji 渲染风格 | **3** | ⚠️ **降不动**，见 1.2 |

### 1.1 字体探测是怎么对抗的（首版的 bug 已修）

检测脚本用的是标准 canvas 宽度比对：

```js
t.font = `72px ${genericFamily}`;              // 先量基线
const a = t.measureText('中文字体检测ABCabc012').width;
t.font = `72px "${fontName}", ${genericFamily}`;  // 再量候选
const o = t.measureText('中文字体检测ABCabc012').width;
return Math.abs(o - a) > 0.5;                   // 宽度不同 = 字体存在
```

**首版的做法错了**：把被禁族**替换**成 `sans-serif`。

```
基线        72px monospace            → 1300
旧实现改写  72px sans-serif, monospace → 1000   ❌ 与基线不同 ⇒ 被判定「字体存在」
新实现改写  72px monospace            → 1300   ✅ 与基线一致 ⇒ 判定「字体不存在」
```

结果就是拦截看起来装了、实际反而帮对方确认了字体存在（站点仍显示 +14 / +10）。
**现在改成整段删除被禁族**，并记录每个 canvas 上下文最近一次用过的「干净」字体，
作为「只剩被禁族、没有通用族兜底」时的基线。

回归测试（不需要浏览器）：`node tools/test_font_strip.cjs`

```
信号            权重   补丁前得分  补丁前贡献  补丁后得分/贡献
中文字体          14    1.00      +14      0.00  →  +0
国产厂商字体       10    1.00      +10      0.00  →  +0
对照组 Arial：补丁后仍能正确识别（未误伤）
```

字体名单已与该站实际探测的三张名单**逐字对齐**（简体 19 / 繁体 8 / 厂商 16 项），
补齐了首版漏掉的 `MIUI`、`Alibaba Sans`、`DingTalk JinBuTi`、`HYQiHei`、`DFKai-SB`。

### 1.2 关于第 10 项 Emoji：+1 是理论下限

这一项**根本不是真的在测 emoji 渲染**，检测脚本只按 UA / platform 推断系统厂商：

```js
score: { Apple: 0.25, Microsoft: 0.4, Google: 0.35, "Linux / Other": 0.5, Unknown: 0.4 }
```

`Apple` 的 **0.25 是整张表里最低的一档**（没有任何分支能拿到 0），`3 × 0.25 = 0.75`，
四舍五入即 **+1**。所以 macOS 上已经是最低分，**任何伪装都消不掉这 1 分**。
反倒要注意：如果伪造 UA 时让 `/mac/` 匹配失败，会掉到 `Unknown`（0.4 → +1.2 → +1），
所以本扩展**不会**去动 `navigator.platform` 与 macOS UA。

另外：

- `Date.prototype.toString` / `toTimeString` / `toLocaleString` 等会一并按目标时区重写（`GMT+0800` → `GMT-0500` 这种破绽最容易被抓）。
- 通过 `declarativeNetRequest` 把发往 `claude.ai` / `claude.com` / `anthropic.com` / `fuck-claude.vercel.app` 的
  **`Accept-Language` 请求头**重写成目标语言（服务端 `curl /api/check` 那条路径也由它兜住）。
- 所有 hook 都做了 `Function.prototype.toString` 代理掩盖，`toString()` 反查会看到原生源码。

## 2. 生效范围

```
claude.ai            *.claude.ai
claude.com           *.claude.com
anthropic.com        *.anthropic.com   （含 console.anthropic.com）
fuck-claude.vercel.app
```

只在上述域名注入。Cloudflare Turnstile 等第三方 iframe（域名不匹配）不受影响。

## 3. 安装

### 方式 A：下载即用（推荐）

1. 到 [Releases](../../releases/latest) 下载 `claude-fingerprint-shield-v1.0.0.zip`
2. **解压**到一个**固定目录**（别放临时目录，扩展加载后不能挪走）
3. 打开 `chrome://extensions/`（Edge 是 `edge://extensions/`，Brave 是 `brave://extensions/`）
4. 右上角打开 **开发者模式**
5. 点 **加载已解压的扩展程序**，选择刚才解压出来的目录

> Release 里也附了 `.crx`。Chromium 系从 88 版起就禁止把非商店来源的 crx 拖进扩展页安装，
> 所以 crx 只适合部分浏览器（如开启相应开关的 Brave / 企业策略下发）。**装不上就用上面的 zip 方式**，
> 两者内容完全一致。

### 方式 B：从源码加载

```bash
git clone https://github.com/AnonUsAl/claude-fingerprint-shield.git
```

然后按上面第 3~5 步，选择克隆下来的目录即可。

### 方式 C：命令行带参数启动（仅当次生效）

```bash
# 先完全退出浏览器，再执行
"<浏览器二进制路径>" \
  --load-extension="/绝对路径/claude-fingerprint-shield" \
  --disable-features=DisableLoadExtensionCommandLineSwitch \
  --no-first-run --no-default-browser-check
```

注意 `--load-extension` **只在这一次启动生效**，下次正常双击图标打开时扩展不在。
想一劳永逸请用方式 A 或 B。

### 装好之后

打开 https://fuck-claude.vercel.app/zh/ ，看分数变化。
改动设置后需要**刷新页面**才生效（时区 / 语言这类 hook 在 `document_start` 注入）。

## 4. 面板

点扩展图标弹出控制面板：

- **左侧「当前风险分」**：在扩展页面里跑真实环境检测（不经过本扩展伪装），拿到你现在实际会被判的分数
- **右侧「伪装后预计」**：按当前开关推演，即打开 Claude 页面时对方会看到的分数
- 下面 10 行明细，逐项标出「命中 / 通过 / 检测中」
- WebRTC 一项是真跑一次 `RTCPeerConnection` + STUN 的实际探测（约 3 秒），不是猜的

## 5. 降不了的东西（重要）

风险分只是**浏览器可见指纹**的估算。以下这些不在网页可见范围内，本扩展也无能为力：

| 维度 | 说明 |
|------|------|
| **IP 归属与信誉** | 数据中心 IP、机房段、被标注过的出口 IP，照样会被标记。需要住宅 IP / 干净节点。 |
| **支付方式** | 虚拟卡 / 高风险卡 BIN。 |
| **账号资历与行为** | 注册地、账号年龄、使用模式。 |
| **Claude Code 的系统时区** | 官方被披露的机制读的是**操作系统** `TZ`，不是浏览器的。用 Claude Code + 中转时要自己改宿主机 `TZ`。 |
| **中转 hostname** | `ANTHROPIC_BASE_URL` 里含敏感关键词的域名。 |

结论：**低分 ≠ 不会被封**。这个扩展只是把「浏览器里最明显的破绽」抹掉。

## 6. 已知限制

- `world: "MAIN"` 注入只覆盖页面主线程和匹配域名的 iframe，**不覆盖 Web Worker**。
- 配置由 ISOLATED world 的 `bridge.js` 读取 storage 后 `postMessage` 送达，理论上比 `document_start`
  晚几毫秒；因为所有 hook 都是「调用时读配置」，对实际检测（一般在 hydration 之后）无影响。
- 扩展页面（弹窗）自身不做伪装，这是故意的——「当前风险分」要读真实环境。
- 若目标站点后续加了 Service Worker / Worker 侧的字体或时区检测，需要另行补丁。

## 7. 目录结构

```
claude-fingerprint-shield/
├── manifest.json            MV3 清单
├── src/
│   ├── spoof.js             指纹伪装主脚本（MAIN world / document_start）
│   ├── bridge.js            配置桥（ISOLATED world，读 storage → postMessage）
│   ├── background.js        Service Worker，同步 Accept-Language 动态规则
│   └── popup.html/css/js    控制面板与分数对照
├── icons/                   16/32/48/128 图标
├── tools/
│   ├── make_icons.py        图标生成脚本（纯标准库，无第三方依赖）
│   └── test_font_strip.cjs  字体对抗回归测试（纯 Node，不需要浏览器）
├── LICENSE                  MIT
└── .gitignore
```

跑一遍字体对抗的回归测试：

```bash
node tools/test_font_strip.cjs
```

它用一个假的 canvas 上下文 + 原样搬来的站点探测函数，验证「被禁字体一律量成基线宽度」，
同时确认对照组（Arial 等真实存在的字体）没有被误伤。

## 8. 开发

- 无构建步骤，改完源码直接在扩展页点 **重新加载** 即可。
- 改 `manifest.json` 的 `content_scripts.matches` 后，需要重新加载扩展 + 刷新页面。
- 重新打包 crx（需要你自己生成并妥善保管私钥）：

```bash
# macOS / Linux，需已安装 Chrome
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --pack-extension="/绝对路径/claude-fingerprint-shield" \
  --pack-extension-key="/安全位置/claude-fingerprint-shield.pem"
```

> ⚠️ `.pem` 是签名私钥，**扩展 ID 由它决定**。私钥泄露或丢失都会出问题：
> 泄露 = 别人能以你的名义发布「同 ID」的扩展；丢失 = 以后发的包 ID 会变、老用户无法升级。
> 本仓库的 `.gitignore` 已把 `*.pem` 排除在外。

## 9. 免责声明

本项目仅供**学习浏览器指纹识别与隐私防护原理**使用。使用者需自行确认其使用方式符合
目标网站的服务条款及所在地法律法规；因使用本项目产生的任何后果由使用者自行承担。
项目作者不对任何账号处置、服务中断或数据损失负责。

如果你只是想要「网络层面不被识别为中国大陆」，请使用正规的合规网络服务，
本扩展**解决不了 IP 与账号层面的问题**。

## 10. 开源协议

[MIT](LICENSE) © 2026 AnonUsAl

欢迎提 Issue / PR。如果它帮到了你，给个 Star 是最大的鼓励。
