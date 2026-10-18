# 奶娃过四级 · Naiwa CET-4 Collector

> 看视频的时候，把四级词汇悄悄攒起来。

[![Version](https://img.shields.io/badge/version-1.5.0-c2572a)](manifest.json)
[![License](https://img.shields.io/badge/license-MIT-2f7d52)](LICENSE)
[![Manifest](https://img.shields.io/badge/manifest-v3-4285f4)](manifest.json)

一个 Chrome / Edge 浏览器扩展（Manifest V3）。播放视频时自动从字幕里提取**四级词汇范围内的英文单词**，去重、**每个 3 分钟区间记一个精确出现时间点**（点一下就能跳回视频那一秒），用**卡片式四选一**帮你把词记牢（答对自动跳下一题，可点读发音），还能把已经熟悉的词一键「斩」掉。

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
| **自动抓词** | 优先读取「沉浸式翻译」渲染的双语字幕（英文+中文）；没开时通过 MAIN world 桥接抓 YouTube 原生字幕轨 |
| **卡片式答题** | 单词题做成卡片牌堆，**一屏只有一道题**。底部常驻「上一题 / 下一题」按钮左右翻页；键盘 ← → 和鼠标划动也能翻 |
| **去重 + 精确时间点** | 同一个词只列一次；按 **3 分钟一个区间**记录，但记的是**那一句真正出现的秒数**（如 `3:47`），不是区间开头的整点，最多 10 个。**点一下视频就跳回去**，落点再提前 0.7 秒，免得跳过去字幕已经消失 |
| **四选一记词** | 不直接给答案：单击单词朗读发音，从 4 个中文释义里选。**选对自动翻到下一题；选错停在原题**、标 ❌ 让你接着选。选项顺序**按单词固定**，不会每开一次就乱跳。**4590 词题库内置，出题不联网** |
| **基础词过滤** | `a / the / of / be / go` 这类词不进题堆，只在显示层隐藏（原始记录不动，搜索仍能查到） |
| **一键「斩」** | 标记为熟悉词后，该词**立刻从当前题堆移除**，越用越清爽 |
| **点「详解」看详情** | 原型、各词性释义、单词变形（复数/过去式/过去分词/现在分词/比较级/最高级）、同根词 |
| **双词典兜底** | 本地词表 → Free Dictionary API → Wiktionary，404 也能查到 |
| **只读不打扰** | 纯只读监听页面字幕元素，不修改任何页面内容，不影响翻译扩展与视频播放 |
| **跨站点** | 不局限于 YouTube，任何页面上出现字幕（配合沉浸式翻译）都能收集 |

---

## 安装（开发者模式加载）

> **浏览器版本要求：Chrome / Edge 111 及以上。**
> 抓 YouTube 原生字幕依赖 content script 的 `world: "MAIN"`，这是 Chrome 111 才有的能力
> （`manifest.json` 里已写 `minimum_chrome_version: "111"`，更低的版本会直接装不上）。
> 只用沉浸式翻译通道的话，老版本也能跑，但建议直接升级。

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
├── youtube-bridge.js      # 只跑在 YouTube 的 MAIN world：把播放器里的字幕轨元数据递出来
├── popup.html / popup.js  # 弹窗界面：卡片牌堆答题、详情、斩词、历史
├── cet4_words.json        # 四级词表（4590 词，带中文释义）
├── cet6_words.json        # 六级词头（2219 词，CC BY-SA 4.0，源数据无释义）
├── ielts_words.json       # 雅思/学术词表（1000 词，带英文释义）
├── vocab_extra_meanings.json  # 非四级词的中文释义（1453 条，让六级/雅思能离线出题）
├── quiz_bank.json         # 出题题库：每个四级词的 3 个形近/易混干扰释义（本地生成）
├── vocabulary-sources.json    # 上面几个数据文件的来源、许可、校验值
├── licenses/              # 第三方数据许可全文（CC BY-SA 4.0 / MIT ×2）
├── scripts/
│   └── build-vocab-data.py    # 按固定 commit 重建词库数据（构建期用，运行时不调用）
├── icons/                 # 扩展图标 16 / 48 / 128
├── docs/
│   ├── index.html         # GitHub Pages 落地页
│   ├── privacy.html       # 隐私政策（公开可访问）
│   ├── vocabulary-sources.html  # 词表与题库来源（署名页）
│   ├── 使用说明.md / 使用说明.html
│   ├── logo-300.png       # 页面页头图标
│   └── screenshots/       # 界面截图
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
  └─ YouTube 原生字幕（备用通道，两级配合）
        ├─ youtube-bridge.js  ← 跑在页面 MAIN world，读 window.ytInitialPlayerResponse，
        │                        再用 postMessage 把「字幕轨地址」递给隔离世界的 content.js
        └─ background         ← 拿地址下载 + 解析 fmt=json3（service worker 不受页面 CORS 约束）
        ↓  MutationObserver 监听变化
content.js  提取英文字幕文本 → 发给 background
        ↓  chrome.runtime.sendMessage
background.js
  ├─ lemmatize()  词形还原（不规则动词表 + 规则变形 + 词表查证）
  ├─ matchCET4()  与 cet4_words.json 比对，命中即记录 surface / lemma / 时间点
  └─ chrome.storage.local  按 videoId 存储；时间点按 3 分钟分区，
                           每区只留该区里**最早那句的精确秒数**，最多 10 个
        ↓
popup.js  卡片牌堆：一屏一道题，底部按钮 / ← → / 划动翻页
          单击单词   → 系统语音朗读（本地）
          选答案     → 全在本地判分，题库来自 quiz_bank.json
                      选对 → 亮释义，750ms 后自动翻下一题
                      选错 → 标 ❌，停在原题继续选
          点时间点   → 让视频 seek 到「记录秒数 − 0.7s」
          点「详解」 → LOOKUP_LOCAL（秒出本地变形）→ LOOKUP_ONLINE（补释义）
```

> **为什么备用通道要拆成两个脚本？**
> content script 跑在「隔离世界」，`window` 是扩展自己的全局对象，
> **读不到页面 JS 定义的 `ytInitialPlayerResponse`**。早期版本直接读它，
> 结果恒为 `undefined`，这条兜底通道一直静默失效 —— 1.5.0 才真正修好。
> 现在由 MAIN world 的 `youtube-bridge.js` 读页面变量，只把字幕轨地址递出来（不传内容），
> 下载交给 service worker。

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
git tag v1.4.0
git push origin v1.4.0
```

也可以本地手动打包：把 `manifest.json`、`background.js`、`content.js`、`popup.html`、`popup.js`、`cet4_words.json`、`quiz_bank.json`、`icons/` 压缩成一个 zip（**不要**把 `docs/`、`.github/`、`README.md` 打进去）。

---

## 贡献

欢迎提 Issue 和 PR，详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 许可

**代码**：[MIT](LICENSE)

**数据**：`cet4_words.json` / `quiz_bank.json` 沿用原项目；`cet6_words.json` 是
**CC BY-SA 4.0**（OpenEtymology CET6）；`ielts_words.json` 是 MIT（WordLevel）；
`vocab_extra_meanings.json` 以 ECDICT 为主整理（仓库级 MIT，上游为多来源汇编）。

⚠️ **因为这个仓库带了 CC BY-SA 4.0 的六级词表，它不算「完全的 MIT」** ——
数据文件各自沿用来源许可，再分发时请把署名带上。
完整来源、固定 commit、校验值和许可全文见
[`docs/vocabulary-sources.html`](docs/vocabulary-sources.html) 与 [`licenses/`](licenses/)。

---

## 免责声明

本扩展为个人学习工具，词表与释义来自公开资源，仅供参考。与 YouTube、Microsoft、沉浸式翻译等第三方无任何关联。

> 记住：工具只是帮你把词捞出来，真正记住它们还得靠你自己多看一眼。
