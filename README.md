# 奶娃过四级 · Naiwa CET-4 Collector

> 看视频的时候，把四级、六级和雅思学习词汇悄悄攒起来。

[![Version](https://img.shields.io/badge/version-1.2.0-c2572a)](manifest.json)
[![License](https://img.shields.io/badge/license-MIT-2f7d52)](LICENSE)
[![Manifest](https://img.shields.io/badge/manifest-v3-4285f4)](manifest.json)

一个 Chrome / Edge 浏览器扩展（Manifest V3）。播放视频时自动从字幕里提取**四级、六级和雅思学习词表中的英文单词**，每次选择一个词库查看，展示全部命中标签，去重、标注出现时间点、一键查看单词变形与释义，还能把已经熟悉的词「斩」掉。

<p align="center">
  <img src="icons/icon128.png" width="110" alt="奶娃过四级">
</p>

---

## 功能特点

| 功能 | 说明 |
|------|------|
| **自动抓词** | 优先读取「沉浸式翻译」渲染的双语字幕（英文+中文），未开启时自动回退到 YouTube 原生字幕 |
| **单选词库** | 四级 / 六级 / 雅思每次选一项，记住上次选择；当前列表、历史词数和已斩词随选择筛选 |
| **全部命中标签** | 重叠词显示全部类别，例如「六级」「雅思」；采集保存三份词库并集，切换无需重新抓取 |
| **去重 + 时间点** | 同一个词只列一次，记录它在视频里出现的位置（`mm:ss`），最多显示前 10 个 |
| **一键「斩」** | 标记为熟悉词后，词卡变灰并计入已斩；三个词库共享熟悉词记录 |
| **点击查详情** | 点任意单词 → 原型、各词性释义、单词变形（复数/过去式/过去分词/现在分词/比较级/最高级）、同根词 |
| **双词典兜底** | 本地词表 → Free Dictionary API → Wiktionary，404 也能查到 |
| **只读不打扰** | 纯只读监听页面字幕元素，不修改任何页面内容，不影响翻译扩展与视频播放 |
| **跨站点** | 不局限于 YouTube，任何页面上出现字幕（配合沉浸式翻译）都能收集 |

## 显示规则

内置词表保留完整数据，但界面会自动隐藏常见基础词及其变形，例如冠词、代词、介词、连词以及 `be`、`go`、`have`、`do` 等基础词。原始采集记录仍保存在本地，调整过滤名单后可以恢复显示。

默认选择四级。六级新增 **2,219 词**，雅思选项新增 **1,000 词**；雅思使用社区整理的 **TOEFL / IELTS 共用学术词表，非官方、非雅思专属**。标签表示命中内置词表。旧记录只能为已保存的四级词补标签，重新抓取可补充以前未收集的六级和雅思词。

来源、释义差异与数据许可见 [词库说明](docs/词库说明.md)，扩展内也有「词表来源」入口。

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

> 使用前请确保视频页面上已经显示字幕（推荐配合沉浸式翻译的双语字幕），并让视频持续播放 —— 单词是跟着字幕一句句累积的。

---

## 目录结构

```
.
├── manifest.json          # 扩展配置（MV3）
├── background.js          # 核心逻辑：词形还原/生成、词表匹配、词典查询、消息路由
├── content.js             # 页面侧：监听字幕 DOM / Shadow DOM，上报字幕文本
├── popup.html / popup.js  # 弹窗界面：单词列表、详情、斩词、历史
├── cet4_words.json        # 四级词表（约 4590 词）
├── cet6_words.json        # 六级词表（2219 词，CC BY-SA 4.0）
├── ielts_words.json       # TOEFL/IELTS 共用学术词表（1000 词，MIT）
├── vocabulary-sources.*   # 来源版本、校验值、面向用户的署名页面
├── licenses/              # 新增词表的原数据许可声明
├── scripts/               # 固定源版本与哈希的词表重建脚本
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
  ├─ matchVocabulary()  与三份词表并集比对，命中即记录 surface / lemma / 全部类别 / 时间点
  └─ chrome.storage.local  按 videoId 存储，最多保留前 10 个时间点
        ↓
popup.js  按所选词库渲染单词列表 / 详情 / 斩词 / 历史
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

也可以本地手动打包：把 `manifest.json`、`background.js`、`content.js`、`popup.html`、`popup.js`、三份 `*_words.json`、`vocabulary-sources.json`、`vocabulary-sources.html`、`licenses/`、`icons/` 压缩成一个 zip（**不要**把 `docs/`、`.github/`、`README.md` 打进去）。

---

## 贡献

欢迎提 Issue 和 PR，详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 许可

项目代码使用 [MIT](LICENSE)。新增六级词表及其格式改编使用 **CC BY-SA 4.0**，雅思选项的共用学术词表使用 **MIT**；数据许可、原版权及署名见 [词表来源](vocabulary-sources.html) 和 `licenses/`。

---

## 免责声明

本扩展为个人学习工具，词表与释义来自公开资源，仅供参考。与 YouTube、Microsoft、沉浸式翻译等第三方无任何关联。

> 记住：工具只是帮你把词捞出来，真正记住它们还得靠你自己多看一眼。
