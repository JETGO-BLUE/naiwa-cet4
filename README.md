# 奶娃过四级

> 看视频的时候，把四级、六级和雅思学习词汇悄悄攒起来。

[![Version](https://img.shields.io/badge/version-1.3.0-c2572a)](manifest.json)
[![License](https://img.shields.io/badge/license-MIT-2f7d52)](LICENSE)
[![Manifest](https://img.shields.io/badge/manifest-v3-4285f4)](manifest.json)

一个 Chrome / Edge 浏览器扩展（Manifest V3）。播放视频时自动从字幕里提取**四级、六级和雅思学习词表中的英文单词**，每次选择一个词库查看。可在普通模式查词，或在测试模式做中文四选一；两种模式共用同一份字幕记录和熟悉词列表。

<p align="center">
  <img src="icons/icon128.png" width="110" alt="奶娃过四级">
</p>

---

## 功能特点

| 功能 | 说明 |
|------|------|
| **实时增量抓词** | 读取可见的「沉浸式翻译」英文原文和可读取的标准英文字幕轨；YouTube 还有原生字幕整轨兜底 |
| **按视频持久累加** | 新字幕只增加词卡或时间点；弹窗、页面刷新和可靠识别的 YouTube 视频重开后继续显示本地记录 |
| **弹窗自动更新** | 弹窗保持打开时收到新词卡，不打断搜索、滚动或详情查看 |
| **单选词库** | 四级 / 六级 / 雅思每次选一项，记住上次选择；当前列表、历史词数和已斩词随选择筛选 |
| **全部命中标签** | 重叠词显示全部类别，例如「六级」「雅思」；采集保存三份词库并集，切换无需重新抓取 |
| **普通 / 测试模式** | 两种模式均隐藏基础词；普通模式显示释义，测试模式提供本地中文四选一和答题反馈 |
| **去重 + 精确时间点** | 同一个词只列一次，按字幕采集精度记录时间（最多到 0.1 秒），保留每词最早的 10 个不同时间点 |
| **一键「斩」** | 标记为熟悉词后，词卡变灰并计入已斩；三个词库共享熟悉词记录 |
| **历史记录管理** | 按视频回看已采集词汇，可删除单条历史记录 |
| **点击查详情** | 点任意单词 → 原型、各词性释义、单词变形（复数/过去式/过去分词/现在分词/比较级/最高级）、同根词 |
| **本地朗读** | 测试模式点击单词只选本地英语音色；没有可用音色时会提示 |
| **双词典兜底** | 本地词表 → Free Dictionary API → Wiktionary，404 也能查到 |
| **只读不打扰** | 纯只读监听页面字幕元素，不修改任何页面内容，不影响翻译扩展与视频播放 |
| **身份不确定时隔离** | 非 YouTube 页面无法确认视频身份时按页面连接单独记录并保留历史；重开可能产生另一份记录，不会按路径盲目合并 |

## 显示规则

普通模式和测试模式都会隐藏常见基础词及其变形，例如冠词、代词、介词、连词以及 `be`、`go`、`have`、`do` 等基础词。基础词保留在原始采集记录中；两种模式切换不会重新采集或清空记录。

测试模式按词形原型匹配题目，例如字幕词形 `studies` 使用 `study` 的题目，卡片仍显示 `studies`。选错会标记该选项，答对后显示释义并完成本次题目；要从待学列表隐藏熟悉词，仍需点「斩」，可在「已斩词」页撤销。个别词可能没有题目，此时仍可用「详解」查询。

题目覆盖三词库词头并集 **6,043 词**：保留上游四级的 4,590 道题，另由固定版本公开释义整理 1,453 道补充题。新增题目目前为程序整理，尚未逐题人工审校；来源、许可、提交、校验值、缺口和生成规则见 [题库来源与许可](vocabulary-sources.html) 及 [`quiz-sources.json`](quiz-sources.json)。

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

> 需要 Chrome / Edge 111 或更新版本。使用前让视频页面显示英文字幕（沉浸式翻译原文、可读的标准字幕轨，或 YouTube 原生英文轨）。正常路径随播放增量采集；YouTube 原生兜底会请求整条字幕轨，可能提前收集尚未播放的内容。

---

## 目录结构

```
.
├── manifest.json          # 扩展配置（MV3）
├── background.js          # 核心逻辑：词形还原/生成、词表匹配、词典查询、消息路由
├── content.js             # 页面侧：字幕增量、待确认缓存、连接恢复
├── youtube-bridge.js      # 仅 YouTube 页面 MAIN world 字幕变量桥接
├── popup.html / popup.js  # 弹窗界面：单词列表、详情、斩词、历史
├── cet4_words.json        # 四级词表（约 4590 词）
├── cet6_words.json        # 六级词表（2219 词，CC BY-SA 4.0）
├── ielts_words.json       # TOEFL/IELTS 共用学术词表（1000 词，MIT）
├── vocabulary-sources.*   # 来源版本、校验值、面向用户的署名页面
├── quiz_bank.json         # 上游四级题库
├── quiz_extras.json      # 六级/雅思缺口与短语兼容题
├── quiz-sources.json     # 题库来源、许可、版本、校验值和覆盖统计
├── licenses/              # 词表与题库来源许可声明
├── scripts/               # 数据重建、覆盖与字幕链路验证脚本
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
  ├─ 沉浸式翻译字幕（Shadow DOM .source-cue）
  ├─ 可读取的标准英文 TextTrack（cuechange）
  └─ YouTube 原生字幕整轨（只在 YouTube 页面使用 MAIN world 桥接）
        ↓  新字幕事件 / 有界整轨批次
content.js  提取英文字幕文本 → 保留未确认事件并增量发送
        ↓  chrome.runtime.sendMessage
background.js
  ├─ 增量分词和词形还原，只处理新字幕
  ├─ 按视频串行合并词卡与时间点，多标签页结果不会相互覆盖
  ├─ 立即通知弹窗；独立合并本地写入并在成功后确认页面输入
  └─ chrome.storage.local 持久保存；每个词最多保留前 10 个不同时间点
        ↓
popup.js  按所选词库和学习模式渲染词卡 / 题卡 / 详情 / 斩词 / 历史
          测试题由 background.js 从本地 quiz_bank.json 和 quiz_extras.json 统一提供
          点击详解 → LOOKUP_LOCAL（本地释义）→ LOOKUP_ONLINE（补释义）
```

### 隐私

- 沉浸式翻译和标准字幕轨只在本地处理。YouTube 原生字幕兜底会向 YouTube 请求字幕轨，可能下载整条字幕并包含尚未播放的部分；字幕和匹配结果不会上传到本扩展的服务器（本扩展没有服务器）。
- 只有你**主动点击**某个单词时，才把**该单词本身**发给公开词典接口（`api.dictionaryapi.dev`、`en.wiktionary.org`）。
- 「已斩词」和收集记录保存在 `chrome.storage.local`，不离开设备。
- 朗读仅使用浏览器标记为本地服务的英语音色；没有本地英语音色时不会尝试远程音色。
- 原始字幕不会作为长期记录保存；页面仍存活时，尚未获得本地写入确认的短期缓存留在页面内存中。浏览器与页面同时突然关闭前最后一小段未确认内容可能丢失。
- 无登录、无广告、无追踪；本地阶段计时不发送遥测。

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
git tag v1.3.0
git push origin v1.3.0
```

也可以本地手动打包：把 `manifest.json`、`background.js`、`content.js`、`youtube-bridge.js`、`popup.html`、`popup.js`、三份 `*_words.json`、`quiz_bank.json`、`quiz_extras.json`、`vocabulary-sources.json`、`vocabulary-sources.html`、`quiz-sources.json`、`licenses/`、`icons/` 压缩成一个 zip（**不要**把 `docs/`、`.github/`、`README.md` 打进去）。

---

## 贡献

欢迎提 Issue 和 PR，详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 许可

项目代码使用 [MIT](LICENSE)。新增六级词表及其格式改编使用 **CC BY-SA 4.0**，雅思选项的共用学术词表和 ECDICT 来源释义使用其声明的 **MIT**；短语释义基于 English Wiktionary 并按 **CC BY-SA 4.0** 标注。详细数据许可、原版权及署名见 [词表与题库来源](vocabulary-sources.html) 和 `licenses/`。

---

## 免责声明

本扩展为个人学习工具，词表与释义来自公开资源，仅供参考。与 YouTube、Microsoft、沉浸式翻译等第三方无任何关联。

> 记住：工具只是帮你把词捞出来，真正记住它们还得靠你自己多看一眼。
