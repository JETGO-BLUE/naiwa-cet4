# 截图目录

全部为 **1280 × 800 PNG**。

| 文件 | 内容 | 说明 |
|------|------|------|
| `01-word-list.png`  | 四选一记词 | 一道题答完的状态：选错的选项旁标 ❌、选对的变绿打勾并展开中文释义 |
| `02-word-detail.png`| 点「详解」   | 音标、四级释义、单词变形（复数/过去式/现在分词…）、各词性释义、同根词 |
| `03-familiar-words.png` | 已斩词 | 斩掉的词不会出现在单词表里，在这里可以逐个撤销 |
| `04-quiz-unanswered.png` | 未作答    | 题目刚出现时的样子：4 个中文释义选项 + 出现时间点 |
| `05-popup.png`      | 弹窗本体   | 无背景装饰，纯 420 × 580 弹窗 |

## 它们是怎么来的

不是手工截的，而是**跑生产代码自动生成**的：

1. `demo/build_demo.py` 把 `popup.html`（CSS + body）、`background.js`、`popup.js`
   **原样内联**成一个自包含的 HTML，只把 `chrome.*` / `fetch` 换成桩
   （词表、题库、词典数据都内置），所以演示页里跑的就是真实逻辑。
2. 用无头 Chrome 渲染并截图：
   ```bash
   chrome --headless=new --hide-scrollbars --force-device-scale-factor=1 \
          --virtual-time-budget=14000 --window-size=1280,800 \
          --screenshot=out.png "file:///.../demo/demo.html?state=answer"
   ```
   `?state=` 支持 `list | answer | detail | familiar | plain`，
   页面里的自动演示脚本会自己把对应状态点出来（含故意点错以显示 ❌）。
3. UI 改动后重新跑一遍即可，不用手动重拍。

生成脚本与演示页在仓库外的 `demo/` 目录（不进扩展包）。
