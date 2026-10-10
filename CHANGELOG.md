# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)：`主版本.次版本.修订号`

---

## [1.2.0] — 2026-10-10

### 新增
- 🎨 **品牌化**：更名「奶娃过四级」，使用专属图标（16 / 48 / 128）
- 🔍 **双词典兜底**：本地词表查不到时，依次回退 Free Dictionary API → Wiktionary，解决 HTTP 404 查不到词的问题
- ✂️ **释义精简**：只保留常用释义，自动过滤 `【古】/archaic/obsolete/rare` 等生僻义项
- 🧩 **单词变形**：按词性生成复数、三单、过去式、过去分词、现在分词、比较级、最高级
- 🌐 **跨站点支持**：不再局限于 YouTube，任何页面上的字幕（配合沉浸式翻译）都能收集
- 🗂️ **上架材料**：商店宣传图、双语文案、隐私政策、上架指南

### 修复
- **沉浸式翻译字幕抓不到**（核心问题）：字幕渲染在 `#immersive-translate-caption-window` 的 **Shadow DOM** 内，原来的 MutationObserver 挂在 light DOM 上监听到不变化。现在改为监听 `shadowRoot`，并从 `.source-cue` 精准提取英文原文
- **非 YouTube 站点不工作**：`getVideoId()` 原先只认 YouTube 的 `?v=` 参数，已改为回退 `host + pathname` 哈希
- **popup 打开瞬间无数据**：去掉 800ms 节流，并让 popup 主动向 content script 拉实时状态
- **缺 `tabs` 权限**：popup 的 `chrome.tabs.sendMessage` 一直是失效的，已补上
- **词形还原错误**：`makes → mak`、`sees → se`、`happier → happier`、`bigger → bigger` 等，已用词表查证兜底修正
- **动词三单错误**：`go → gos`（应为 `goes`）
- **词性标记被切散**：`n&vt.` 解析成 `n&` + `vt.`，正则交替顺序已修正
- **词表缺基础词**：补入 study / run / take / write / see / think 等 52 个高频词，词表从 4538 → **4590** 词

### 变更
- 每个单词最多记录 **前 10 个**出现时间点
- 单词以**字幕原样**列出（不改变形态），点击后才展示原型与变形

---

## [1.0.0] — 2026-10-09

### 新增
- 首个可用版本：从 YouTube 原生字幕提取四级词汇
- 单词去重 + 时间点标注
- 一键「斩」掉熟悉词
- 点击单词查看本地变形与释义

---

[1.2.0]: https://github.com/JETGO-BLUE/naiwa-cet4/releases/tag/v1.2.0
[1.0.0]: https://github.com/JETGO-BLUE/naiwa-cet4/releases/tag/v1.0.0
