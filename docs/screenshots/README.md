# 截图目录

全部为 **1280 × 800 PNG**。

| 文件 | 内容 |
|------|------|
| `01-deck-unanswered.png` | 卡片式四选一 · 一次只做一题 |
| `02-deck-answered.png` | 选对亮释义、选错标 ❌ 停在本题 |
| `03-deck-swipe.png` | 左右翻页 · 底部常驻按钮 |
| `04-dict-picker.png` | 词库切换 · 点两字小标签向下弹出 |
| `05-diagnostics.png` | 诊断面板 · 卡在哪一步一目了然 |
| `06-word-detail.png` | 点「详解」· 变形、各词性释义、同根词 |
| `07-familiar-words.png` | 已斩词 · 斩过的不再打扰，随时可撤销 |
| `08-popup.png` | 弹窗本体 · 420 × 580 |

## 它们是怎么来的

不是手工截的，而是**跑生产代码自动生成**的：

1. `demo/build_demo.py` 把 `popup.html`（CSS + body）、`background.js`、`popup.js`
   **原样内联**成一个自包含的 HTML，只把 `chrome.*` / `fetch` 换成桩
   （词表、题库、词典数据都内置），所以演示页里跑的就是真实逻辑。
2. 用无头 Chrome 渲染并截图：

   ```bash
   chrome --headless=new --hide-scrollbars --force-device-scale-factor=1 \
          --virtual-time-budget=15000 --window-size=1280,800 \
          --screenshot=raw-answer.png "file:///.../demo/demo.html?state=answer"
   ```

   `?state=` 支持 `list | answer | next | dict | diag | detail | familiar | plain`，分别对应上表 01~08。
   页面里的自动演示脚本会自己把对应状态点出来（含故意点错以显示 ❌、
   真点两次「下一题」以摆出翻页后的样子）。

3. 把 8 张 `raw-*.png` 放到 `demo/screenshots/`，再跑 `demo/install_shots.py` 装配。

> 注意：`answer` 状态答对后会触发 750ms 自动翻页，演示脚本里会调用
> `clearAutoNext()` 把那个定时器掐掉，否则截图时题目已经翻走了。

生成脚本与演示页在仓库外的 `demo/` 目录（不进扩展包）。
