# 奶娃过四级 · Naiwa CET-4 Collector

> 看视频的时候，把四级词汇悄悄攒起来。

[![Version](https://img.shields.io/badge/version-1.2.0-c2572a)](manifest.json)
[![License](https://img.shields.io/badge/license-MIT-2f7d52)](LICENSE)
[![Manifest](https://img.shields.io/badge/manifest-v3-4285f4)](manifest.json)

一个 Chrome / Edge 浏览器扩展（Manifest V3）。播放视频时自动从字幕里提取**四级词汇范围内的英文单词**，去重、标注出现时间点、一键查看单词变形与释义，还能像背单词 App 一样把已经熟悉的词「斩」掉。

<p align="center">
  <img src="icons/icon128.png" width="110" alt="奶娃过四级">
</p>

> [!IMPORTANT]
> **一定要打开「沉浸式翻译」的双语字幕。**
> 本扩展优先读取的就是「沉浸式翻译」渲染出的双语字幕（取其中的英文原文行）。
> 不开也能退回抓 YouTube 自带字幕，但 Netflix / B站 这类平台**必须**靠它，否则抓不到词。

---

## 功能特点

| 功能 | 说明 |
|------|------|
| **自动抓词** | 优先读取「沉浸式翻译」渲染的双语字幕（英文+中文），未开启时自动回退到 YouTube 原生字幕 |
| **去重 + 时间点** | 同一个词只列一次，记录它在视频里出现的位置（`mm:ss`），最多显示前 10 个 |
| **一键「斩」** | 标记为熟悉词后，该词不再出现在单词列表中，越用越清爽 |
| **点击查详情** | 点任意单词 → 原型、各词性释义、单词变形（复数/过去式/过去分词/现在分词/比较级/最高级）、同根词 |
| **双词典兜底** | 本地词表 → Free Dictionary API → Wiktionary，404 也能查到 |
| **只读不打扰** | 纯只读监听页面字幕元素，不修改任何页面内容，不影响翻译扩展与视频播放 |
| **跨站点** | 不局限于 YouTube，任何页面上出现字幕（配合沉浸式翻译）都能收集 |

---

## 安装（开发者模式加载）

### Chrome

1. 下载或克隆本仓库到本地
2. 打开 `chrome://extensions/`
3. 右上角打开 **开发者模式**
4. 点击 **加载已解压的扩展程序**，选择仓库根目录（含 `manifest.json` 的那一层）
5. 打开任意视频页面，点击工具栏里的奶娃图标即可看到收集结果

### Edge

1. 打开 `edge://extensions/`
2. 左下角打开 **开发人员模式**
3. 点击 **加载解压缩的扩展**，选择仓库根目录
4. 其余同 Chrome

> **装好之后第一件事：打开「沉浸式翻译」的双语字幕**（画面上要能看到英文一行、中文一行）。
> 单词是跟着播放进度一句句累积的，所以别只打开不播 —— 播 30 秒左右再点弹窗看。

---

## 目录结构

```
.
├── manifest.json          # 扩展配置（MV3）
├── background.js          # 核心逻辑：词形还原/生成、词表匹配、词典查询、消息路由
├── content.js             # 页面侧：监听字幕 DOM / Shadow DOM，上报字幕文本
├── popup.html / popup.js  # 弹窗界面：单词列表、详情、斩词、历史
├── cet4_words.json        # 四级词表（约 4590 词）
├── icons/                 # 扩展图标 16 / 48 / 128
├── docs/
│   ├── index.html         # GitHub Pages 落地页
│   ├── privacy.html       # 隐私政策（商店要求公开可访问）
│   ├── 使用说明.md
│   ├── screenshots/       # 商店截图
│   └── store-assets/      # 商店宣传图与文案
├── .github/workflows/
│   └── release.yml        # 打 tag 自动打包 zip
├── LICENSE
└── CONTRIBUTING.md
```

---

## 工作原理

```
视频页面
  ├─ 沉浸式翻译字幕（#immersive-translate-caption-window 的 Shadow DOM）
  │     └─ .source-cue 英文原文
  └─ YouTube 原生字幕（备用通道）
        ↓  MutationObserver 监听变化
content.js  提取英文字幕文本 → 发给 background
        ↓  chrome.runtime.sendMessage
background.js
  ├─ lemmatize()  词形还原（不规则动词表 + 规则变形 + 词表查证）
  ├─ matchCET4()  与 cet4_words.json 比对，命中即记录 surface / lemma / 时间点
  └─ chrome.storage.local  按 videoId 存储，最多保留前 10 个时间点
        ↓
popup.js  渲染单词列表 / 详情 / 斩词 / 历史
          点击单词 → LOOKUP_LOCAL（秒出本地变形）→ LOOKUP_ONLINE（补释义）
```

### 隐私

- 字幕文本**只在你的浏览器本地处理**，不上传（本扩展没有服务器）。
- 只有你**主动点击**某个单词时，才把**该单词本身**发给公开词典接口（`api.dictionaryapi.dev`、`en.wiktionary.org`）。
- 「已斩词」和收集记录保存在 `chrome.storage.local`，不离开设备。
- 无登录、无广告、无追踪、无统计分析。

完整内容见 [`docs/privacy.html`](docs/privacy.html)。

---

## 开发

无需构建步骤 —— 源码即产物，改完在扩展管理页点「刷新」即可。

```bash
git clone https://github.com/JETGO-BLUE/naiwa-cet4.git
cd naiwa-cet4
# 然后在 chrome://extensions 里「加载已解压的扩展程序」指向本目录
```

### 调试建议

- **看不到单词**：先确认页面上有字幕在动；打开 popup 看诊断区（会显示 host 是否找到、是否拿到 shadowRoot、cue 数量、字幕文本样例）。
- **改了 content.js 不生效**：content script 需要「重新加载扩展 + 刷新页面」。
- **改了 background.js 不生效**：扩展管理页点刷新，再重开 popup。

### 打包发布

```bash
# 打完 tag 推送，GitHub Actions 会自动产出 zip 到 Release
git tag v1.2.0
git push origin v1.2.0
```

也可以本地手动打包：把 `manifest.json`、`background.js`、`content.js`、`popup.html`、`popup.js`、`cet4_words.json`、`icons/` 压缩成一个 zip（**不要**把 `docs/`、`.github/`、`README.md` 打进去）。

---

## 贡献

欢迎提 Issue 和 PR，详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 许可

[MIT](LICENSE)

---

## 免责声明

本扩展为个人学习工具，词表与释义来自公开资源，仅供参考。与 YouTube、Microsoft、沉浸式翻译等第三方无任何关联。

> 记住：工具只是帮你把词捞出来，真正记住它们还得靠你自己多看一眼。
