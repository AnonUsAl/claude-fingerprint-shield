# Claude Fingerprint Shield

**English** | [简体中文](README.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue.svg)](manifest.json)
[![Chromium 111+](https://img.shields.io/badge/Chromium-111%2B-4285F4.svg)](#3-installation)

A Manifest V3 extension for Chrome / Edge / Brave (Chromium 111+) that — **only on Claude-related
sites** — disguises the "mainland China" regional fingerprint your browser exposes, so that the
10-signal weighted model behind [fuck-claude.vercel.app](https://fuck-claude.vercel.app/zh/)
gives you a lower risk score.

> It does not change your IP and never touches your account — it only smooths over the few tells
> that are easiest to catch from inside a browser.
> **A low score does not mean you won't get banned.** Please read
> [section 5](#5-what-this-cannot-fix-important) first.

---

## 1. What it spoofs

| # | Signal | Weight | What the extension does |
|---|--------|:------:|-------------------------|
| 1 | System timezone | **24** | Proxies `Intl.DateTimeFormat` (including `resolvedOptions().timeZone`); defaults to `America/New_York` |
| 2 | Browser language | **18** | Overrides `navigator.language` / `navigator.languages`; defaults to `en-US` |
| 3 | Installed Chinese fonts | **14** | Makes the canvas font probe measure the "baseline width" for every Chinese / Traditional-Chinese / CJK font, so it is reported as *not installed* |
| 4 | Mainland vendor fonts | **10** | Same, covering MiSans / MIUI / HarmonyOS Sans / OPPO Sans / vivo Sans / Alibaba Sans / DingTalk JinBuTi / HYQiHei / Hanyi / Founder and others |
| 5 | WebRTC IP leak | **10** | Empties `iceServers` when an `RTCPeerConnection` is constructed, and filters out `icecandidate` events carrying the real IP |
| 6 | Mainland browser / WebView | **8** | When the UA carries WeChat / QQ / Quark / UC / Sogou / 360 / Huawei / Xiaomi / OPPO / vivo markers, it is replaced with a clean Chromium UA |
| 7 | Mainland device brand | **6** | Sanitises `navigator.userAgentData` alongside it (brands / platform / getHighEntropyValues) |
| 8 | Intl locale | **4** | Any `Intl.*` whose `resolvedOptions().locale` is `zh-*` is switched to the target language |
| 9 | Timezone offset | **3** | Overrides `Date.prototype.getTimezoneOffset` and computes it live from the target timezone |
| 10 | Emoji rendering style | **3** | ⚠️ **Cannot be reduced** — see 1.2 |

### 1.1 How the font probe is countered (the first release had this wrong)

The detector uses the standard canvas width comparison:

```js
t.font = `72px ${genericFamily}`;                 // measure the baseline first
const a = t.measureText('中文字体检测ABCabc012').width;
t.font = `72px "${fontName}", ${genericFamily}`;  // then measure the candidate
const o = t.measureText('中文字体检测ABCabc012').width;
return Math.abs(o - a) > 0.5;                     // different width = font exists
```

**The first release got this backwards**: it *replaced* blocked families with `sans-serif`.

```
baseline            72px monospace            → 1300
old patching        72px sans-serif, monospace → 1000   ❌ differs from baseline ⇒ "font exists"
current patching    72px monospace            → 1300   ✅ matches baseline  ⇒ "font absent"
```

In other words the interception looked like it was working while actually *confirming* the fonts
were present — the site still reported `+14` / `+10`. **It now deletes the blocked families
outright**, and remembers the last "clean" font string each canvas context used, as a fallback
baseline for the case where only blocked families remain and no generic family is left to fall
back on.

Regression test, no browser required:

```bash
node tools/test_font_strip.cjs
```

```
signal              weight  before  contrib   after / contrib
Chinese fonts          14    1.00     +14     0.00  →  +0
Vendor fonts           10    1.00     +10     0.00  →  +0
control (Arial): still detected correctly after patching — no collateral damage
```

The font lists are now aligned **character by character** with the three lists the site actually
probes (19 Simplified / 8 Traditional / 16 vendor entries), filling in `MIUI`, `Alibaba Sans`,
`DingTalk JinBuTi`, `HYQiHei` and `DFKai-SB`, which the first release missed.

### 1.2 On signal #10 (Emoji): +1 is a hard floor

This signal **does not actually measure emoji rendering at all**. The detector merely infers the
OS vendor from UA / platform:

```js
score: { Apple: 0.25, Microsoft: 0.4, Google: 0.35, "Linux / Other": 0.5, Unknown: 0.4 }
```

`Apple`'s **0.25 is the lowest rung in the whole table** — no branch returns 0 — so
`3 × 0.25 = 0.75`, which rounds to **+1**. On macOS you are already at the floor and **no amount
of spoofing removes that 1 point**.

The risk runs the other way: if a faked UA breaks the `/mac/` match you drop to `Unknown`
(0.4 → +1.2 → +1). That is why this extension deliberately **leaves `navigator.platform` and the
macOS UA alone**.

Also worth knowing:

- `Date.prototype.toString` / `toTimeString` / `toLocaleString` are rewritten for the target
  timezone too — a `GMT+0800` vs `GMT-0500` mismatch is the single easiest tell to catch.
- A `declarativeNetRequest` rule rewrites the **`Accept-Language` request header** sent to every
  in-scope domain listed in [section 2](#2-where-it-runs), which also covers the server-side
  `curl /api/check` path.
- Every hook is masked with a `Function.prototype.toString` proxy, so a `toString()` round-trip
  returns the native source.

## 2. Where it runs

```
claude.ai              *.claude.ai
claude.com             *.claude.com
anthropic.com          *.anthropic.com   (including console.anthropic.com)
claude.dev             *.claude.dev      developer domain
clau.de                *.clau.de         share-link landing domain
claudemcpclient.com    *.claudemcpclient.com
claudemcpcontent.com   *.claudemcpcontent.com
claudeusercontent.com  *.claudeusercontent.com   artifact iframes (all_frames is on)
fuck-claude.vercel.app
servd-anthropic-website.b-cdn.net          static assets (shared BunnyCDN domain — exact subdomain only)
```

It injects only on the domains above. Third-party iframes such as Cloudflare Turnstile (which do
not match) are left untouched.

> The **single source of truth** for this list is `domains.json` at the repository root: the
> manifest's `host_permissions`, both `content_scripts.matches` arrays and `SCOPED_DOMAINS` in
> `background.js` are all generated by `tools/sync_domains.cjs`. **Do not edit those three places by
> hand** — a missed spot does not raise an error, it just leaves you with "the content script
> injected but `Accept-Language` was never rewritten". To add a domain, edit `domains.json` and
> re-run the sync (see [section 8](#8-development)).
> Chrome MV3 match patterns and `declarativeNetRequest.requestDomains` accept **domains only — no
> ASN or CIDR**. To pin traffic by IP range, use a Clash / Surge ruleset; see
> [section 5](#5-what-this-cannot-fix-important).

## 3. Installation

### Option A — download and go (recommended)

1. Grab `claude-fingerprint-shield-v1.0.2.zip` from
   [Releases](../../releases/latest)
2. **Unzip it into a permanent folder** (not a temp directory — an unpacked extension cannot be
   moved after it is loaded)
3. Open `chrome://extensions/` (Edge: `edge://extensions/`, Brave: `brave://extensions/`)
4. Turn on **Developer mode** in the top-right corner
5. Click **Load unpacked** and pick the folder you just unzipped

> A `.crx` is attached to the Release as well — signed with the same private key as the zip, so the
> extension ID is `bmhigbelenmlihofadfkcbcoallnfjjp` either way; it is not a separate extension.
> Since Chromium 88 it is no longer possible to drag a non-Store crx into the extensions page, so the
> crx only works on some browsers (Brave with the relevant switch enabled, or via enterprise policy).
> **If it will not install, use the zip route** — the contents are identical.

### Option B — load from source

```bash
git clone https://github.com/AnonUsAl/claude-fingerprint-shield.git
```

Then follow steps 3–5 above and select the cloned folder.

### Option C — launch with a command-line flag (this run only)

```bash
# Fully quit the browser first, then run:
"/path/to/browser/binary" \
  --load-extension="/absolute/path/claude-fingerprint-shield" \
  --disable-features=DisableLoadExtensionCommandLineSwitch \
  --no-first-run --no-default-browser-check
```

Note that `--load-extension` **only applies to that one launch**. Open the browser normally next
time and the extension is gone. Use option A or B if you want it to stick.

### After installing

Open https://fuck-claude.vercel.app/zh/ and watch the score. After changing any setting you need
to **reload the page** — the timezone/language hooks are injected at `document_start`.

## 4. The popup

Click the extension icon:

- **Left, "current risk score"**: runs a real environment probe *inside the extension page*
  (without this extension's spoofing) to show the score you would get as-is
- **Right, "projected after spoofing"**: simulates the score the site will see, based on the
  toggles as they are now
- Below that, 10 rows of detail, each marked hit / pass / probing
- The WebRTC row is a genuine `RTCPeerConnection` + STUN probe (about 3 seconds), not a guess

## 5. What this cannot fix (important)

The risk score is only an estimate of **browser-visible fingerprinting**. None of the following is
visible to a web page, and this extension cannot help with any of it:

| Dimension | Notes |
|-----------|-------|
| **IP reputation & geolocation** | Datacenter IPs, hosting ranges and flagged exit IPs get marked anyway. You need a residential IP / clean node. To pin the exit, write a Clash / Surge ruleset keyed on domain (an MV3 extension cannot express ASN / CIDR) and point the Anthropic domains at a single node. |
| **Payment method** | Virtual cards, high-risk card BINs. |
| **Account age & behaviour** | Registration country, account age, usage patterns. |
| **Claude Code's system timezone** | The publicly described mechanism reads the **operating system** `TZ`, not the browser's. If you use Claude Code through a proxy you have to change the host `TZ` yourself. |
| **Proxy hostname** | Domains in `ANTHROPIC_BASE_URL` containing sensitive keywords. |

Conclusion: **a low score is not immunity from being banned.** This extension only removes the most
obvious tells in the browser.

## 6. Known limitations

- `world: "MAIN"` injection covers the page's main thread and same-domain iframes, but **not Web
  Workers**.
- The config is delivered by `bridge.js` (ISOLATED world) over a **one-shot nonce channel**: at
  `document_start` a nonce is written synchronously to `documentElement[data-fp-n]` and sent with the
  config message; `spoof.js` only accepts a message whose nonce matches, and drops the listener and
  the attribute as soon as it takes the first valid config. A forged `{__fpGuard:true}` message
  copied from the wire carries no nonce and is discarded, and every config value is validated as
  well (the timezone must be resolvable by `Intl`, the language must look like BCP-47, the switches
  must be real booleans).
  The residual risk is inherent to MV3 MAIN-world injection: the MAIN world shares a realm with page
  scripts, so a page that manages to read the nonce before the first config arrives and
  synchronously dispatches a forged `MessageEvent` can still rewrite that one config — which is why
  **you should reload the page after changing settings**, and why the channel only stays open once.
- The extension's own pages (the popup) are deliberately **not** spoofed — the "current risk score"
  needs the real environment.
- If the target site later adds font or timezone probing on the Service Worker / Worker side, that
  needs a separate patch.

## 7. Repository layout

```
claude-fingerprint-shield/
├── manifest.json            MV3 manifest (matches / host_permissions generated by sync_domains.cjs)
├── domains.json             single source of truth for in-scope domains
├── src/
│   ├── spoof.js             main fingerprint-spoofing script (MAIN world / document_start)
│   ├── ua-patterns.js       single source of truth for mainland UA patterns
│   │                        (injected before spoof.js; the popup loads the same file)
│   ├── bridge.js            config bridge (ISOLATED world, storage → one-shot nonce channel)
│   ├── background.js        service worker, keeps the Accept-Language DNR rule in sync
│   └── popup.html/css/js    control panel and score comparison
├── icons/                   16/32/48/128 icons
├── tools/
│   ├── make_icons.py        icon generator (standard library only, no dependencies)
│   ├── sync_domains.cjs     domains.json → manifest/background sync, plus `--check`
│   ├── test_font_strip.cjs  font-countermeasure regression test (plain Node, no browser)
│   └── test_config_channel.cjs  config channel / UA-pattern regression test (plain Node)
├── .github/workflows/       domains-sync-check: runs sync_domains.cjs --check on push / PR
├── README.md                Chinese documentation
├── README.en.md             this file
├── LICENSE                  MIT
└── .gitignore
```

Run the regression tests (neither needs a browser):

```bash
node tools/test_font_strip.cjs
node tools/test_config_channel.cjs
```

`test_config_channel.cjs` loads `ua-patterns.js` / `spoof.js` / `bridge.js` into a "mini extension
runtime" stub and checks the Symbol guard, the one-shot nonce channel, rejection of forged messages,
invalid config values being ignored, and that the merged UA pattern set now really does catch entries
such as `wxwork`.

## 8. Development

- No build step. Edit the source and hit **Reload** on the extensions page.
- After changing `content_scripts.matches` in `manifest.json`, reload the extension *and* refresh
  the page.
- **Domains go through a single source of truth**: add or change a domain only in `domains.json`,
  then run

  ```bash
  node tools/sync_domains.cjs           # write manifest.json / src/background.js
  node tools/sync_domains.cjs --check   # verify only; exits 1 on mismatch
  ```

  The repository ships a GitHub Actions workflow (`.github/workflows/domains-sync-check.yml`) that
  runs `--check` on every push / PR so the three copies cannot drift apart again; it also works as a
  pre-commit hook.
- **Mainland UA patterns go through a single source of truth** in `src/ua-patterns.js`: the manifest
  injects it before `spoof.js` (same MAIN world, executed in `js` array order) and `popup.html`
  `<script>`-loads the same file. `--check` validates that ordering too.
- To re-pack the crx (you generate and keep the private key yourself):

```bash
# macOS / Linux, requires Chrome to be installed
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --pack-extension="/absolute/path/claude-fingerprint-shield" \
  --pack-extension-key="/secure/path/claude-fingerprint-shield.pem"
```

> ⚠️ The `.pem` is the signing key and **determines the extension ID**. Both leaking it and losing
> it cause problems: leaking it lets someone else publish an extension with the same ID under your
> name; losing it changes the ID of future packages, so existing users cannot be upgraded. The
> `.gitignore` in this repository excludes `*.pem`.

## 9. Disclaimer

This project is provided for **studying how browser fingerprinting works and how to defend against
it**. You are responsible for confirming that your use complies with the target site's terms of
service and the laws of your jurisdiction; any consequences of using this project are your own. The
author accepts no liability for account actions, service interruptions or data loss.

If all you want is not to be *seen* as coming from mainland China at the network layer, use a proper
compliant network service — **this extension cannot fix anything at the IP or account level**.

## 10. License

[MIT](LICENSE) © 2026 AnonUsAl

Issues and PRs are welcome. If this helped you, a star is the best encouragement.
