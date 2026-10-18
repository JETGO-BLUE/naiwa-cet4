// popup.js —— 结果页逻辑

'use strict';

let currentRecord = null;
let familiarWords = [];
let currentTab = 'current';
let searchKeyword = '';

// 出题相关的内存态（关掉弹窗即重置；跨会话只保留"已斩词"）
const quizCache = new Map(); // word -> quiz | null（null = 题库里没有，避免反复请求）
const quizState = new Map(); // word -> { wrong:Set<number>, solved:boolean }

// ============ 卡片牌堆状态 ============
const SEEK_LEAD_SEC = 0.7; // 跳转提前量：字幕常在时间点之后很快就没了，提前 0.7s 落点
const AUTO_NEXT_DELAY = 750; // 答对后停留多久再自动翻到下一题(ms)
const SWIPE_MIN_PX = 55; // 鼠标/手指划动多少像素算一次翻页

let deckWords = []; // 当前牌堆里的单词（已过滤掉已斩词 / 搜索结果）
let deckIndex = 0; // 当前在第几张
let autoNextTimer = null;
let swipeStartX = null;
let swipeMoved = false;
let swipeEndAt = 0; // 刚划完的时间戳，用来吃掉紧随其后的那次 click
let basicHiddenCount = 0; // 本次被隐藏的基础词数量（只用于提示）
let captureStatus = null; // content script 上报的采集状态
let dictState = { selected: 'cet4', dicts: [] }; // 当前词库 + 可选词库列表
let lastLoadedVideoId = null; // 上次按「做题进度」加载的是哪个视频
let progressSaveTimer = null; // 防抖：翻页时别每按一次键就写一次盘

// ============ 做题进度持久化 ============
// 每个视频存一份：做到第几个（用 anchor 单词锚定）+ 哪些词答对/答错过。
// 这样退出再进，不仅停在原来那张，前后的「已做/未做」状态也都在、顺序也一致。
async function restoreProgress(videoId) {
  const r = await send({ type: 'GET_PROGRESS', videoId: videoId });
  const p = r && r.progress;
  if (!p) return null;
  const done = p.done || {};
  const wrong = p.wrong || {};
  for (const w of Object.keys(done)) getQuizState(w).solved = true;
  for (const w of Object.keys(wrong)) {
    const st = getQuizState(w);
    if (Array.isArray(wrong[w])) wrong[w].forEach((i) => st.wrong.add(i));
  }
  return { index: Number(p.index) || 0, anchor: p.anchor || null };
}

// 恢复时先找 anchor 那个词（顺序变了也不怕），找不到再退回存的下标
function resolveResumeIndex(shown, resume) {
  if (resume.anchor) {
    const i = shown.findIndex((w) => w.word === resume.anchor);
    if (i >= 0) return i;
  }
  return Math.max(0, Math.min(shown.length - 1, Number(resume.index) || 0));
}

function saveProgress() {
  if (!currentRecord || !currentRecord.videoId || !deckWords.length) return;
  const done = {};
  const wrong = {};
  for (const w of deckWords) {
    const st = quizState.get(w.word);
    if (!st) continue;
    if (st.solved) done[w.word] = true;
    if (st.wrong && st.wrong.size) wrong[w.word] = Array.from(st.wrong);
  }
  send({
    type: 'SAVE_PROGRESS',
    videoId: currentRecord.videoId,
    index: deckIndex,
    anchor: deckWords[deckIndex] ? deckWords[deckIndex].word : null,
    done: done,
    wrong: wrong,
  });
}

function scheduleSaveProgress() {
  if (progressSaveTimer) clearTimeout(progressSaveTimer);
  progressSaveTimer = setTimeout(() => {
    progressSaveTimer = null;
    saveProgress();
  }, 300);
}

// ============ 基础词过滤 ============
// a / the / of / be / go 这类词放题堆里就是噪音。
// 只在**显示层**隐藏：存储里的原始记录一个字不删，搜索时也照样搜得到。
const BASIC_WORDS = new Set(
  (
    'a an the i you he she it we they me him her us them ' +
    'my your his its our their mine yours hers ours theirs ' +
    'this that these those and or but so if as ' +
    'to of in on at for from with by ' +
    'be go have do get come take make say see know think ' +
    'can could may might must shall should will would ' +
    'not no yes very'
  ).split(/\s+/)
);

function isBasicWord(w) {
  if (!w) return false;
  return (
    BASIC_WORDS.has(String(w.word || '').toLowerCase()) ||
    BASIC_WORDS.has(String(w.lemma || '').toLowerCase())
  );
}

// ============ 发音：浏览器内置语音合成（本地，不联网、不加权限） ============
function pickEnglishVoice() {
  try {
    const vs = window.speechSynthesis.getVoices() || [];
    return (
      vs.find((v) => /^en[-_]US/i.test(v.lang)) ||
      vs.find((v) => /^en[-_]/i.test(v.lang)) ||
      null
    );
  } catch (e) {
    return null;
  }
}

function speakWord(word) {
  if (!word) return;
  try {
    const synth = window.speechSynthesis;
    if (!synth) return;
    synth.cancel(); // 连点只读最后一次
    const u = new SpeechSynthesisUtterance(String(word));
    u.lang = 'en-US';
    u.rate = 0.9;
    const v = pickEnglishVoice();
    if (v) u.voice = v;
    synth.speak(u);
  } catch (e) {
    /* 系统无语音包时静默失败，不影响其他功能 */
  }
}

// 预热一次语音列表（Chrome 首次 getVoices() 常返回空）
try {
  if (window.speechSynthesis) window.speechSynthesis.getVoices();
} catch (e) {}

// 发送消息到 background（Promise 包装）
function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      resolve(resp);
    });
  });
}

// 发消息到当前标签页的 content script
function sendToContent(msg) {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs[0] || !tabs[0].id) {
        resolve(null);
        return;
      }
      chrome.tabs.sendMessage(tabs[0].id, msg, (resp) => {
        if (chrome.runtime.lastError) {
          resolve(null); // content script 未注入（比如不是视频页）
          return;
        }
        resolve(resp);
      });
    });
  });
}

// ============ 时间点：显示 + 跳转 ============
// 秒 → "3:47"
function fmtTime(sec) {
  const s0 = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(s0 / 60);
  const s = s0 % 60;
  return m + ':' + String(s).padStart(2, '0');
}

// 兼容两种数据：
//   新版 background 存的是秒数（number，如 227.4）
//   旧版存的是格式化字符串（'3:00'）—— 老记录里还有一堆，得能读
function timeToSec(t) {
  if (typeof t === 'number' && Number.isFinite(t)) return t;
  const m = String(t == null ? '' : t).match(/^\s*(\d+):(\d{1,2})\s*$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

// 回看时实际要落到哪个秒数：比记录时间提前 SEEK_LEAD_SEC（不早于 0）
function seekTarget(sec) {
  return Math.max(0, Math.round((Number(sec) - SEEK_LEAD_SEC) * 10) / 10);
}

// 初始化：优先问当前标签页的 content 有没有已累积的内容，否则读历史存储
let lastStatus = null;
let contentAlive = null; // null=未知, true=content 响应了, false=没注入
let contentDebug = null; // content 返回的诊断信息
async function init() {
  // 0) 词库列表（必须先拿到，否则渲染时不知道该按哪个词库筛选）
  await loadDicts();

  // 0.5) 采集状态（content script 上报的，抓不到词时靠它看卡在哪一步）
  const cap = await send({ type: 'GET_CAPTURE_STATUS' });
  captureStatus = (cap && cap.status) || null;

  // 1) 先问当前标签页 content script（哪个视频、有没有正在累积的字幕）
  const cs = await sendToContent({ type: 'GET_STATE' });
  contentAlive = !!(cs && cs.ok);
  contentDebug = cs && cs.state ? cs.state.debug || null : null;

  const activeVideoId = cs && cs.ok && cs.state ? cs.state.videoId : null;

  // 2) content 手里若有还没落盘的字幕，用「增量合并」补进存储。
  //    ⚠️ 这里以前用 CAPTIONS 全量重建，会把 content 内存里那几句当成全部，
  //    覆盖掉之前攒的记录 —— 这正是「刷新页面后单词重新开始」的元凶。
  if (cs && cs.ok && cs.state && cs.state.cues && cs.state.cues.length > 0) {
    await send({
      type: 'CAPTIONS_DELTA',
      videoId: cs.state.videoId,
      title: cs.state.title,
      language: 'en',
      cues: cs.state.cues,
      source: 'immersive-translate',
    });
  }

  // 3) 读「当前页面这个视频」的记录；只有认不出当前视频时，才退回最近一次
  if (activeVideoId) {
    const r = await send({ type: 'GET_VIDEO', videoId: activeVideoId });
    if (r && r.ok && r.record) {
      currentRecord = r.record;
      familiarWords = r.familiar || [];
      lastStatus = null;
      render({ reset: true });
      return;
    }
    // 当前视频还没任何记录 → 走空态，别把上一个视频的词张冠李戴
    const st = await send({ type: 'GET_STATUS' });
    if (st && st.ok && st.status) lastStatus = st.status;
    render({ reset: true });
    return;
  }

  // 4) 认不出当前视频（不是视频页 / content 没跑起来）→ 读最近一次记录
  const resp = await send({ type: 'GET_LAST_VIDEO' });
  if (resp && resp.ok && resp.record) {
    currentRecord = resp.record;
    familiarWords = resp.familiar || [];
    lastStatus = null;
    render({ reset: true });
    return;
  }

  // 5) 没有视频记录，查状态（无字幕/错误）
  const st = await send({ type: 'GET_STATUS' });
  if (st && st.ok && st.status) {
    lastStatus = st.status;
  }
  render({ reset: true });
}

// 渲染当前 tab
function render(opts) {
  const titleEl = document.getElementById('videoTitle');
  if (currentRecord) {
    titleEl.textContent = currentRecord.title || '(无标题)';
  } else if (lastStatus && lastStatus.type === 'no_captions') {
    titleEl.textContent = (lastStatus.title || '视频') + ' — 无字幕';
  } else if (lastStatus && lastStatus.type === 'error') {
    titleEl.textContent = '抓取出错';
  } else {
    titleEl.textContent = '尚未捕获视频';
  }
  renderCurrent(opts).catch((err) => console.error('[popup] renderCurrent 出错', err));
  renderFamiliar();
  renderCaptureStatus();
}

// ============ 采集状态条 ============
// 一行小字 + 一个点：让用户一眼看出是「没连上」「在等字幕」还是「已经在收了」。
function renderCaptureStatus() {
  const el = document.getElementById('capStatus');
  const txt = document.getElementById('capStatusText');
  if (!el || !txt) return;

  const st = captureStatus;
  if (!st || !st.status) {
    el.dataset.state = 'idle';
    el.title = '打开一个视频页并让字幕出现，这里会显示采集进度';
    txt.textContent = '尚未开始采集';
    return;
  }

  const short = {
    connecting: '正在连接字幕…',
    waiting: '已连接，等待字幕出现',
    collecting: '正在收集 · ' + (st.cueCount || 0) + ' 句',
    no_captions: '读不到字幕',
    error: '抓取出错',
  }[st.status] || st.status;

  const full = short + (st.detail ? ' · ' + st.detail : '');
  el.dataset.state = st.status;
  el.title = full; // 被 CSS 截断时鼠标悬停能看全文
  // 出错/读不到时直接把原因摊开，省得用户再点诊断
  txt.textContent = st.status === 'error' || st.status === 'no_captions' ? full : short;
}

// 渲染 content 诊断信息（排查"收不到字幕"用）
function renderDebug() {
  if (!contentDebug) return '';
  const d = contentDebug;
  return (
    '<br/><br/><span class="muted" style="font-size:11px;text-align:left;display:inline-block">' +
    '诊断：<br/>' +
    '字幕容器：' + (d.hostFound ? '✅ 找到' : '❌ 未找到') + '<br/>' +
    'Shadow DOM：' + (d.hasShadowRoot ? '✅ 有' : '❌ 无') + '<br/>' +
    '英文行(.source-cue)：' + d.sourceCueCount + ' 个<br/>' +
    '中文行(.target-cue)：' + d.targetCueCount + ' 个<br/>' +
    (d.rootTextSample ? '容器文字样例：' + escapeHtml(d.rootTextSample) : '') +
    '</span>'
  );
}

// 空态/正常态切换：牌堆模式要把内容区的滚动交还给牌堆自己
function setDeckMode(on) {
  const c = document.getElementById('currentContent');
  if (c) c.classList.toggle('deck-mode', !!on);
}

// 新牌堆落在第几张：优先锚定同一个单词，找不到就沿用旧下标（夹紧）
function resolveDeckIndex(shown, opts) {
  const oldIndex = deckIndex;
  if (opts && opts.reset) return 0;
  const anchor = (opts && opts.anchor) || (deckWords[deckIndex] && deckWords[deckIndex].word);
  if (anchor) {
    const i = shown.findIndex((w) => w.word === anchor);
    if (i >= 0) return i;
  }
  const want = opts && opts.stayIndex != null ? opts.stayIndex : oldIndex;
  return Math.max(0, Math.min(shown.length - 1, want));
}

// 渲染当前视频的单词——卡片式：一次只显示一个单词的四选一
async function renderCurrent(opts) {
  opts = opts || {};
  const container = document.getElementById('currentContent');
  if (!currentRecord) {
    lastLoadedVideoId = null;
    setDeckMode(false);
    if (lastStatus && lastStatus.type === 'no_captions') {
      container.innerHTML =
        '<div class="empty"><div class="icon">🚫</div><b>这个视频没有字幕轨</b><br/>' +
        '该视频没有提供任何字幕（含自动字幕），无法提取英文单词。<br/><br/>' +
        '换一个带 CC 字幕 / 自动字幕的视频试试。</div>';
      return;
    }
    if (lastStatus && lastStatus.type === 'error') {
      container.innerHTML =
        '<div class="empty"><div class="icon">⚠️</div><b>抓取出错</b><br/>' +
        escapeHtml(lastStatus.error || '') + '</div>';
      return;
    }
    container.innerHTML =
      (contentAlive === false
        ? '<div class="empty"><div class="icon">🔌</div><b>扩展脚本没在这个页面跑起来</b><br/>' +
          '请先<b>刷新当前视频页面</b>（F5），再打开沉浸式翻译双语字幕，' +
          '让视频播放几秒后再点本图标。' +
          '<br/><br/>（改完代码后，扩展和页面都要刷新一次）</div>'
        : contentAlive === true
        ? '<div class="empty"><div class="icon">🎬</div><b>脚本已注入，但还没收到字幕</b><br/>' +
          '确认沉浸式翻译的双语字幕（英文+中文）已经显示在视频上，' +
          '并让视频<b>持续播放</b>——单词是跟着字幕一句句累积的。' +
          renderDebug() +
          '</div>'
        : '<div class="empty"><div class="icon">🎬</div>打开一个视频<br/>（需有字幕）后回到这里查看</div>');
    return;
  }

  const allRaw = currentRecord.words || [];
  const slashedSet = new Set(familiarWords);
  const sel = dictState.selected || 'cet4';

  // ① 先按当前词库筛选（一个词可能同时属于四级 / 六级 / 雅思）
  //    老记录没有 cats 标注 → 当四级词处理，不然升级后旧记录会整片消失
  const all = allRaw.filter((w) => {
    if (!Array.isArray(w.cats) || w.cats.length === 0) return sel === 'cet4';
    return w.cats.indexOf(sel) >= 0;
  });

  // ② 基础词（a / the / of …）不进题堆，但原始记录保留、搜索仍能查到
  const learning = all.filter((w) => !isBasicWord(w));
  basicHiddenCount = all.length - learning.length;

  const slashedCount = learning.filter((w) => slashedSet.has(w.word)).length;
  // ③ 已经斩过的词汇，不再出现在题堆里
  const active = learning.filter((w) => !slashedSet.has(w.word));

  const kw = searchKeyword.trim().toLowerCase();
  // 搜索时**不受基础词过滤限制** —— 想找 "the" 也能找得到
  const shown = kw
    ? all
        .filter((w) => !slashedSet.has(w.word))
        .filter(
          (w) =>
            w.word.toLowerCase().includes(kw) ||
            (w.meaning || '').toLowerCase().includes(kw)
        )
    : active;

  const dictLabel = currentDictLabel();

  // 顶部统计
  const statsHtml = `
    <div class="stats">
      <div class="stat"><b>${learning.length}</b>${escapeHtml(dictLabel)}词</div>
      <div class="stat"><b>${active.length}</b>待记</div>
      <div class="stat"><b>${slashedCount}</b>已斩</div>
    </div>`;

  // 空态里也要留一个词库切换入口，否则用户卡在空页面上换不回去
  const chipHtml =
    '<div class="empty-dict"><button type="button" class="dict-chip" id="dictChip">' +
    escapeHtml(dictLabel) +
    ' <i>▾</i></button></div>';

  if (allRaw.length === 0) {
    setDeckMode(false);
    container.innerHTML =
      statsHtml +
      '<div class="empty"><div class="icon">🔍</div>本视频字幕里没有匹配到四级词汇' +
      chipHtml +
      '</div>';
    return;
  }

  if (all.length === 0) {
    setDeckMode(false);
    container.innerHTML =
      statsHtml +
      '<div class="empty"><div class="icon">🗂️</div>这个视频里没有「' +
      escapeHtml(dictLabel) +
      '」词库的词<br/><br/>换个词库看看？' +
      chipHtml +
      '</div>';
    return;
  }

  if (active.length === 0) {
    setDeckMode(false);
    const onlyBasic = learning.length === 0;
    const note =
      basicHiddenCount > 0
        ? '<br/><br/><span class="muted">已自动隐藏 ' + basicHiddenCount + ' 个 a / the / of 这类基础词</span>'
        : '';
    container.innerHTML =
      statsHtml +
      '<div class="empty"><div class="icon">' + (onlyBasic ? '🫧' : '🎉') + '</div>' +
      (onlyBasic
        ? '这个视频里只有基础词，没有值得记的' + escapeHtml(dictLabel) + '词'
        : '这个视频的' + escapeHtml(dictLabel) + '词都被你斩完了<br/><br/>想找回来？切到「已斩词」页，点词后面的 ✕ 即可撤销。') +
      note +
      chipHtml +
      '</div>';
    return;
  }

  if (shown.length === 0) {
    setDeckMode(false);
    container.innerHTML =
      statsHtml +
      '<div class="empty"><div class="icon">🔍</div>没有匹配「' +
      escapeHtml(searchKeyword) +
      '」的单词' +
      chipHtml +
      '</div>';
    return;
  }

  // 换视频（或首次打开）→ 清答题状态，从存储恢复做题进度
  const vid = currentRecord.videoId;
  let resume = null;
  if (vid !== lastLoadedVideoId) {
    lastLoadedVideoId = vid;
    quizState.clear();
    resume = await restoreProgress(vid);
  }

  // 先把题目准备好（本地题库，一次批量取回）
  await ensureQuizzes(shown);

  const idx = resume ? resolveResumeIndex(shown, resume) : resolveDeckIndex(shown, opts);
  const byWord = new Map(shown.map((w) => [w.word, w]));

  deckWords = shown;
  deckIndex = idx;
  clearAutoNext();

  setDeckMode(true);
  container.innerHTML = deckHtml(shown);
  renderDictChip();

  // 逐张把题目填进去
  container.querySelectorAll('.deck-card').forEach((card) => {
    const w = byWord.get(card.getAttribute('data-word'));
    if (w) renderQuizBlock(card, w);
  });

  applyDeckPosition({ animate: false });
  updateDeckMeta();
}

// 牌堆骨架：顶部进度 + 滑块 + 底部常驻左右按钮
function deckHtml(shown) {
  const cardsHtml = shown
    .map((w, i) => {
      const wd = escapeHtml(w.word);
      const timesHtml = (w.times || [])
        .slice(0, 10)
        .map((t) => {
          const sec = timeToSec(t);
          if (sec == null) return `<span class="time-tag">${escapeHtml(String(t))}</span>`;
          return (
            `<span class="time-tag" data-seek="${sec}" ` +
            `title="回看 ${fmtTime(sec)}（实际落在 ${fmtTime(seekTarget(sec))}，提前 ${SEEK_LEAD_SEC} 秒起播，字幕更完整）">` +
            `${fmtTime(sec)}</span>`
          );
        })
        .join('');
      const lemmaHint =
        w.lemma && w.lemma !== w.word ? `<span class="dc-lemma">→ ${escapeHtml(w.lemma)}</span>` : '';
      return `
      <div class="deck-card" data-index="${i}" data-word="${wd}">
        <div class="dc-inner">
          <div class="dc-head">
            <div class="dc-word" data-word="${wd}" title="点击听发音">${escapeHtml(w.word)}${lemmaHint}<span class="spk">🔊</span></div>
            <div class="dc-actions">
              <button class="mini-btn detail-btn" data-word="${wd}">详解</button>
              <button class="mini-btn slash-btn" data-word="${wd}">斩</button>
            </div>
          </div>
          <div class="quiz-host"></div>
          <div class="dc-times">
            <span class="dc-times-label">字幕出现</span>
            ${timesHtml || '<span class="muted">（本视频未记录到时间点）</span>'}
          </div>
        </div>
      </div>`;
    })
    .join('');

  return `
    <div class="deck">
      <div class="deck-top">
        <div class="deck-count">第 <b class="deck-now">1</b> / <span class="deck-total">${shown.length}</span> 题<button type="button" class="dict-chip" id="dictChip" title="切换词库">四级 <i>▾</i></button></div>
        <div class="deck-stat"></div>
      </div>
      <div class="deck-bar"><i></i></div>
      <div class="deck-stage">
        <div class="deck-track">${cardsHtml}</div>
      </div>
      <div class="deck-done" hidden>🎉 这个视频的题都答完了</div>
      <div class="deck-nav">
        <button class="deck-btn deck-prev" title="上一题（键盘 ←）">‹ 上一题</button>
        <span class="deck-pos"><b>1</b>/${shown.length}</span>
        <button class="deck-btn deck-next" title="下一题（键盘 →）">下一题 ›</button>
      </div>
    </div>`;
}

// 牌堆位移。
// 注意：translateX 的百分比基数是**元素自己的 border-box 宽度**，而 .deck-track 是
// 块级 flex 容器、宽度被拉伸成「一张卡」那么宽（卡片是 flex:0 0 100% 溢出去的），
// 所以这里就是 -下标 × 100%，不用除以题数。
function deckTransform() {
  return 'translateX(' + -deckIndex * 100 + '%)';
}

// 把当前下标反映到界面（位置 / 计数 / 进度条 / 按钮禁用态）
function applyDeckPosition(opts) {
  opts = opts || {};
  const track = document.querySelector('.deck-track');
  if (track) {
    if (opts.animate === false) {
      track.style.transition = 'none';
      track.style.transform = deckTransform();
      void track.offsetWidth; // 强制回流，避免首次也播放动画
      track.style.transition = '';
    } else {
      track.style.transform = deckTransform();
    }
  }

  const n = deckWords.length || 1;
  document.querySelectorAll('.deck-now').forEach((el) => {
    el.textContent = String(deckIndex + 1);
  });
  document.querySelectorAll('.deck-pos > b').forEach((el) => {
    el.textContent = String(deckIndex + 1);
  });
  const bar = document.querySelector('.deck-bar > i');
  if (bar) bar.style.width = ((deckIndex + 1) / n) * 100 + '%';

  const prev = document.querySelector('.deck-prev');
  const next = document.querySelector('.deck-next');
  if (prev) prev.disabled = deckIndex <= 0;
  if (next) next.disabled = deckIndex >= deckWords.length - 1;

  // 翻到的这一张，回到顶部
  const card = document.querySelectorAll('.deck-card')[deckIndex];
  if (card) card.scrollTop = 0;
}

// 翻到第 i 张（自动夹在合法范围里）
function goToDeck(i) {
  if (!deckWords.length) return;
  clearAutoNext(); // 手动翻页就打掉待执行的自动跳
  const next = Math.max(0, Math.min(deckWords.length - 1, i));
  if (next === deckIndex) {
    applyDeckPosition();
    return;
  }
  deckIndex = next;
  applyDeckPosition();
  updateDeckMeta();
  scheduleSaveProgress();
}

// 顶部「✅ / ❌ / 斩」计数 + 全部答完提示
function updateDeckMeta() {
  const statEl = document.querySelector('.deck-stat');
  const doneEl = document.querySelector('.deck-done');
  if (!statEl && !doneEl) return;
  let right = 0;
  let wrong = 0;
  for (const w of deckWords) {
    const st = quizState.get(w.word);
    if (!st) continue;
    if (st.solved) right++;
    wrong += st.wrong.size;
  }
  if (statEl) {
    // 基础词被隐藏时给个交代，不然"怎么少了 12 个词"会让人以为丢了
    const basicNote =
      basicHiddenCount > 0
        ? ' · <span class="muted" title="已隐藏 ' +
          basicHiddenCount +
          ' 个 a / the / of 这类基础词；在搜索框里输入仍能查到">基础 ' +
          basicHiddenCount +
          '</span>'
        : '';
    statEl.innerHTML =
      '✅ <b>' + right + '</b> · ❌ <b>' + wrong + '</b> · 斩 <b>' + familiarWords.length + '</b>' + basicNote;
  }
  if (doneEl) doneEl.hidden = !(deckWords.length > 0 && right === deckWords.length);
}

// 答对后自动翻页：等一下让用户看清正确项，再滑到下一张
function scheduleAutoNext(word) {
  clearAutoNext();
  autoNextTimer = setTimeout(() => {
    autoNextTimer = null;
    const cur = deckWords[deckIndex];
    if (!cur || cur.word !== word) return; // 用户已经自己翻走了
    if (deckIndex < deckWords.length - 1) {
      deckIndex += 1;
      applyDeckPosition();
      updateDeckMeta();
      scheduleSaveProgress();
    }
  }, AUTO_NEXT_DELAY);
}

function clearAutoNext() {
  if (autoNextTimer) {
    clearTimeout(autoNextTimer);
    autoNextTimer = null;
  }
}

// ============ 出题（全部走本地题库，不联网） ============
// 批量取题，只请求没缓存过的词
async function ensureQuizzes(words) {
  const missing = [];
  for (const w of words) {
    if (!quizCache.has(w.word)) missing.push(w.word);
  }
  if (missing.length === 0) return;
  const resp = await send({ type: 'GET_QUIZ_BATCH', words: missing });
  const quizzes = (resp && resp.quizzes) || {};
  for (const w of missing) quizCache.set(w, quizzes[w] || null);
}

function getQuizState(word) {
  let st = quizState.get(word);
  if (!st) {
    st = { wrong: new Set(), solved: false };
    quizState.set(word, st);
  }
  return st;
}

// 一道题：4 个中文释义选项（选错标 ❌ 且停在原题，选对展开释义）
function quizHtml(q, st, word, hasNext) {
  if (!q || !q.options || q.options.length < 2) {
    return '<div class="quiz-loading">这道题暂时出不来（该词不在题库内）</div>';
  }

  let h = '<div class="quiz">';
  q.options.forEach((opt, i) => {
    const isAnswer = i === q.answer;
    let cls = 'opt';
    let mark = '';
    if (st.solved && isAnswer) {
      cls += ' correct';
      mark = '<span class="mark">✔</span>';
    } else if (st.wrong.has(i)) {
      cls += ' wrong';
      mark = '<span class="mark">❌</span>';
    }
    const dis = st.solved || st.wrong.has(i) ? ' disabled' : '';
    h +=
      `<button class="${cls}"${dis} data-i="${i}">` +
      `<span class="idx">${'ABCD'[i] || i + 1}</span>` +
      `<span class="txt">${escapeHtml(opt)}</span>${mark}</button>`;
  });
  h += '</div>';

  if (st.solved) {
    h +=
      '<div class="quiz-done">' +
      `<div class="answer-reveal" data-word="${escapeHtml(word)}">` +
      `<span>✅ 释义：<b>${escapeHtml(q.correct)}</b></span>` +
      `<span class="more">详解 ▸</span>` +
      '</div>' +
      (hasNext ? '<button class="quiz-next">下一题 ›</button>' : '') +
      '</div>';
  } else {
    h += '<div class="quiz-tip">单击单词可听发音 · 选出正确的中文释义（答错会停在本题）</div>';
  }
  return h;
}

function renderQuizBlock(card, w) {
  const host = card.querySelector('.quiz-host');
  if (!host) return;
  const idx = parseInt(card.getAttribute('data-index'), 10);
  const hasNext = Number.isFinite(idx) ? idx < deckWords.length - 1 : true;
  host.innerHTML = quizHtml(quizCache.get(w.word), getQuizState(w.word), w.word, hasNext);
  const st = quizState.get(w.word);
  card.classList.toggle('solved', !!(st && st.solved));
}

// 渲染已斩词列表
function renderFamiliar() {
  const container = document.getElementById('familiarContent');
  if (familiarWords.length === 0) {
    container.innerHTML = '<div class="empty"><div class="icon">✂️</div>还没有斩掉任何单词<br/>在单词卡片上点「斩」即可标记为熟悉词</div>';
    return;
  }
  let html = '<div class="familiar-list">';
  for (const w of familiarWords) {
    html += `<span class="familiar-item">${escapeHtml(w)} <span class="undo" data-word="${escapeHtml(w)}">✕</span></span>`;
  }
  html += '</div>';
  container.innerHTML = html;

  container.querySelectorAll('.undo').forEach((el) => {
    el.addEventListener('click', async () => {
      const word = el.getAttribute('data-word');
      await send({ type: 'UNSLASH_WORD', word: word });
      const resp = await send({ type: 'GET_FAMILIAR' });
      familiarWords = resp.familiar || [];
      render();
    });
  });
}

// 渲染历史记录
async function renderHistory() {
  const container = document.getElementById('historyContent');
  const resp = await send({ type: 'GET_ALL_VIDEOS' });
  const videos = resp.videos || [];
  if (videos.length === 0) {
    container.innerHTML = '<div class="empty"><div class="icon">📦</div>暂无历史记录</div>';
    return;
  }
  const keepScroll = container.scrollTop;
  let html = '';
  for (const v of videos) {
    const date = new Date(v.capturedAt).toLocaleString('zh-CN', { hour12: false });
    html += `
      <div class="video-item" data-video="${escapeHtml(v.videoId)}">
        <div class="v-row">
          <div class="v-title">${escapeHtml(v.title || v.videoId)}</div>
          <button type="button" class="video-del" data-video="${escapeHtml(v.videoId)}" title="删除这条历史记录">✕</button>
        </div>
        <div class="v-meta">${v.totalWords} 个四级词 · ${date}</div>
      </div>`;
  }
  container.innerHTML = html;
  container.scrollTop = keepScroll; // 重绘别把用户滚到顶部

  container.querySelectorAll('.video-item').forEach((el) => {
    el.addEventListener('click', async () => {
      const videoId = el.getAttribute('data-video');
      const r = await send({ type: 'GET_VIDEO', videoId: videoId });
      if (r.ok && r.record) {
        currentRecord = r.record;
        familiarWords = r.familiar || [];
        switchTab('current');
        render({ reset: true });
      }
    });
  });

  container.querySelectorAll('.video-del').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation(); // 别把"打开这条"也触发了
      const videoId = btn.getAttribute('data-video');
      const item = videos.find((v) => v.videoId === videoId);
      const name = (item && item.title) || videoId;
      if (!confirm('删除「' + name + '」的历史记录？\n\n只删这条视频收集到的词，已斩词和其他视频不受影响。')) return;

      btn.disabled = true;
      const r = await send({ type: 'DELETE_VIDEO', videoId: videoId });
      if (!r || !r.ok) {
        alert('删除失败：' + ((r && r.error) || '未知错误'));
        btn.disabled = false;
        return;
      }
      // 删的正好是当前正在看的那条 → 回到空态，别留一份已经不存在的数据在界面上
      if (currentRecord && currentRecord.videoId === videoId) {
        currentRecord = null;
        lastStatus = null;
        searchKeyword = '';
        document.getElementById('searchInput').value = '';
        render({ reset: true });
      }
      renderHistory();
    });
  });
}

// tab 切换
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.getAttribute('data-tab') === tab);
  });
  document.getElementById('tab-current').style.display = tab === 'current' ? '' : 'none';
  document.getElementById('tab-history').style.display = tab === 'history' ? '' : 'none';
  document.getElementById('tab-familiar').style.display = tab === 'familiar' ? '' : 'none';

  if (tab === 'history') renderHistory();
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 事件绑定
document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => switchTab(t.getAttribute('data-tab')));
});

document.getElementById('searchInput').addEventListener('input', (e) => {
  searchKeyword = e.target.value;
  renderCurrent({ reset: true });
});

document.getElementById('recaptureBtn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id) {
    chrome.tabs.sendMessage(tab.id, { type: 'RECAPTURE' }, () => {
      // content script 可能未加载，忽略错误
    });
  }
  setTimeout(async () => {
    await init();
  }, 1500);
});

document.getElementById('clearFamiliarBtn').addEventListener('click', async () => {
  if (!confirm('确定清空所有已斩单词吗？')) return;
  await send({ type: 'CLEAR_FAMILIAR' });
  familiarWords = [];
  render({ reset: true });
});

// ============ 当前题堆的点击委托（只绑一次，innerHTML 重绘后依然有效） ============
function bindCurrentDelegation() {
  const container = document.getElementById('currentContent');
  if (!container || container.dataset.bound === '1') return;
  container.dataset.bound = '1';

  container.addEventListener('click', async (e) => {
    // 刚划动过的那一下手势，不要当成点击
    if (Date.now() - swipeEndAt < 250) return;

    // 0) 点词库小标签 → 向下弹出词库列表
    if (e.target.closest('.dict-chip')) {
      openDictPop();
      return;
    }

    // 1) 上一题 / 下一题
    const nav = e.target.closest('.deck-prev, .deck-next');
    if (nav) {
      goToDeck(deckIndex + (nav.classList.contains('deck-next') ? 1 : -1));
      return;
    }

    // 2) 答对后卡片里那个「下一题 ›」
    if (e.target.closest('.quiz-next')) {
      goToDeck(deckIndex + 1);
      return;
    }

    // 3) 单击单词 → 听发音
    const spk = e.target.closest('.dc-word');
    if (spk) {
      speakWord(spk.getAttribute('data-word'));
      return;
    }

    // 4) 单击选项 → 判对错
    //    答对：标绿 + 展开释义，稍后自动翻到下一题
    //    答错：标 ❌ 但**停在本题**，让用户继续选到对为止
    const opt = e.target.closest('.opt');
    if (opt && !opt.disabled) {
      const card = opt.closest('.deck-card');
      const word = card ? card.getAttribute('data-word') : null;
      const q = word ? quizCache.get(word) : null;
      if (!q) return;
      const st = getQuizState(word);
      if (st.solved) return;
      const i = parseInt(opt.getAttribute('data-i'), 10);
      let justSolved = false;
      if (i === q.answer) {
        st.solved = true;
        justSolved = true;
      } else {
        st.wrong.add(i);
      }
      if (card) renderQuizBlock(card, { word: word }); // 只重画这一张卡
      updateDeckMeta();
      saveProgress(); // 答对/答错立刻落盘，弹窗关掉也不丢
      if (justSolved) scheduleAutoNext(word);
      return;
    }

    // 5) 单击「✅ 答对了」释义条 → 打开详情面板（变形 / 同根词 / 联网释义）
    const rev = e.target.closest('.answer-reveal');
    if (rev) {
      openDetail(rev.getAttribute('data-word'));
      return;
    }

    // 6) 单击「详解」→ 同样打开详情面板
    const det = e.target.closest('.detail-btn');
    if (det) {
      openDetail(det.getAttribute('data-word'));
      return;
    }

    // 7) 单击「斩」→ 标记为熟悉词（随后被踢出题堆，停在原下标＝下一题）
    const sb = e.target.closest('.slash-btn');
    if (sb) {
      const word = sb.getAttribute('data-word');
      if (familiarWords.includes(word)) {
        await send({ type: 'UNSLASH_WORD', word: word });
      } else {
        await send({ type: 'SLASH_WORD', word: word });
      }
      const resp = await send({ type: 'GET_FAMILIAR' });
      familiarWords = resp.familiar || [];
      quizState.delete(word); // 斩掉 = 清掉这词的做题状态，撤销后回到"未做"
      const stay = deckIndex;
      render({ stayIndex: stay });
      setTimeout(saveProgress, 0);
      return;
    }

    // 8) 单击时间点 → 让视频回看那一处
    //    落点 = 记录时间 − SEEK_LEAD_SEC，因为字幕常在单词时间点之后很快就没了，
    //    正好跳到那一秒的话经常扑空（画面上字幕已经消失）
    const tag = e.target.closest('.time-tag');
    if (tag) {
      const sec = parseFloat(tag.getAttribute('data-seek'));
      if (!Number.isFinite(sec)) return; // 旧记录没带秒数，点了也不动
      const resp = await sendToContent({ type: 'SEEK_TO', time: seekTarget(sec) });
      const ok = !!(resp && resp.ok);
      tag.classList.add(ok ? 'seeked' : 'seek-fail');
      setTimeout(() => tag.classList.remove('seeked', 'seek-fail'), 700);
    }
  });
}

// 鼠标/手指左右划动 = 翻页（按钮之外的补充手势）
function bindDeckSwipe() {
  const container = document.getElementById('currentContent');
  if (!container || container.dataset.swipeBound === '1') return;
  container.dataset.swipeBound = '1';

  container.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) {
      swipeStartX = null; // 按钮上不认划动
      return;
    }
    swipeStartX = e.clientX;
    swipeMoved = false;
  });

  container.addEventListener('pointermove', (e) => {
    if (swipeStartX == null) return;
    if (Math.abs(e.clientX - swipeStartX) > 12) swipeMoved = true;
  });

  const finish = (clientX) => {
    if (swipeStartX == null) return;
    const dx = clientX - swipeStartX;
    swipeStartX = null;
    if (swipeMoved && Math.abs(dx) >= SWIPE_MIN_PX) {
      swipeEndAt = Date.now();
      goToDeck(deckIndex + (dx < 0 ? 1 : -1));
    }
  };
  container.addEventListener('pointerup', (e) => finish(e.clientX));
  container.addEventListener('pointercancel', () => {
    swipeStartX = null;
  });
}

// 键盘 ← → 翻页
function bindDeckKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (currentTab !== 'current') return;
    const panel = document.getElementById('detailPanel');
    if (panel && panel.classList.contains('open')) return;
    const diag = document.getElementById('diagPanel');
    if (diag && diag.classList.contains('open')) return;
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      goToDeck(deckIndex - 1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      goToDeck(deckIndex + 1);
    }
  });
}

// ============ 单词详情弹窗 ============
// 两阶段渲染：本地数据（原型/精简释义/单词变形/同根词）先秒出，联网释义后补
async function openDetail(word) {
  const panel = document.getElementById('detailPanel');
  panel.classList.add('open');

  // 第一阶段：本地，秒出
  const local = await send({ type: 'LOOKUP_LOCAL', word: word });
  if (!local || !local.ok) {
    document.getElementById('detailBox').innerHTML = '<div class="detail-error">查询失败</div>';
    return;
  }
  renderDetailLocal(word, local);

  // 第二阶段：联网，慢，到了再补
  const resp = await send({ type: 'LOOKUP_ONLINE', word: local.base || word });
  fillOnline(resp && resp.online ? resp.online : null);
}

function renderDetailLocal(surface, resp) {
  const box = document.getElementById('detailBox');
  let html = '';

  // 头部（音标位留给联网结果补）
  html += `<div class="detail-head">
    <div>
      <span class="detail-word">${escapeHtml(resp.base || surface)}</span>
      <span class="detail-phonetic" id="detailPhonetic"></span>
    </div>
    <button class="detail-close" id="detailClose">✕</button>
  </div>`;

  // 原型（如果是变形词）
  if (resp.lemma) {
    html += `<div class="detail-lemma">字幕原形「${escapeHtml(surface)}」→ 原型 ${escapeHtml(resp.lemma)}</div>`;
  }

  // 四级释义（已精简：每词性最多 2 个常用释义，偏门已删）
  if (resp.cet4Meaning) {
    html += `<div class="detail-section"><h4>四级释义（常用）</h4><div class="def-item">${escapeHtml(resp.cet4Meaning)}</div></div>`;
  }

  // 单词变形（本地算，秒出）
  const infl = resp.inflections || {};
  const keys = Object.keys(infl);
  if (keys.length > 0) {
    html += `<div class="detail-section"><h4>单词变形</h4><div class="infl-list">`;
    for (const k of keys) {
      html += `<div class="infl-row"><span class="infl-label">${escapeHtml(k)}</span><span class="infl-word">${escapeHtml(infl[k])}</span></div>`;
    }
    html += `</div></div>`;
  }

  // 联网释义占位（第二阶段填充）
  html += `<div class="detail-section" id="onlineSection"><h4>各词性释义</h4><div class="detail-loading">⏳ 联网查询中…</div></div>`;

  // 同根词
  if (resp.cognates && resp.cognates.length > 0) {
    html += `<div class="detail-section"><h4>同根词（四级词表内）</h4><div class="syn-ant">`;
    resp.cognates.forEach((c) => { html += `<span class="cog-chip">${escapeHtml(c)}</span>`; });
    html += `</div></div>`;
  }

  box.innerHTML = html;
  document.getElementById('detailClose').addEventListener('click', () => {
    document.getElementById('detailPanel').classList.remove('open');
  });
}

// 第二阶段：联网结果填进占位区 + 补音标
function fillOnline(online) {
  const sec = document.getElementById('onlineSection');
  if (!sec) return; // 弹窗已被关掉/重开

  if (online && online.phonetic) {
    const ph = document.getElementById('detailPhonetic');
    if (ph) ph.textContent = online.phonetic;
  }

  if (online && online.ok && online.meanings && online.meanings.length > 0) {
    const srcName = online.source === 'wiktionary' ? 'Wiktionary' : 'DictionaryAPI';
    let html = `<h4>各词性释义<span class="muted" style="font-weight:400">（${srcName}，仅常用）</span></h4>`;
    for (const m of online.meanings) {
      html += `<div class="pos-block"><span class="pos-tag">${escapeHtml(m.partOfSpeech)}</span>`;
      for (const d of m.definitions) {
        html += `<div class="def-item">${escapeHtml(d.definition)}${d.example ? `<span class="ex">例：${escapeHtml(d.example)}</span>` : ''}</div>`;
      }
      html += `</div>`;
    }
    sec.innerHTML = html;
  } else {
    const err = online && online.error ? online.error : '未查到';
    sec.innerHTML = `<h4>各词性释义</h4><div class="muted" style="padding:6px 0">${escapeHtml(err)}，以上方四级释义为准。</div>`;
  }
}

// 点击面板背景关闭
document.getElementById('detailPanel').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) {
    e.currentTarget.classList.remove('open');
  }
});

// ============ 词库：切换 + 导入 ============
// 界面上的存在感就一个两字小标签（比如「雅思 ▾」），点开才是完整列表。
function currentDictLabel() {
  const d = dictState.dicts.find((x) => x.id === dictState.selected);
  return d ? d.label : '四级';
}

async function loadDicts() {
  const r = await send({ type: 'GET_VOCABULARIES' });
  if (r && r.ok) {
    dictState = { selected: r.selected || 'cet4', dicts: r.dicts || [] };
  }
  renderDictChip();
}

function renderDictChip() {
  const chip = document.getElementById('dictChip');
  if (!chip) return;
  const label = currentDictLabel();
  chip.innerHTML = escapeHtml(label) + ' <i>▾</i>';
  chip.title = '切换词库（当前：' + label + '）';
}

function renderDictList() {
  const box = document.getElementById('dictList');
  if (!box) return;
  const sel = dictState.selected;
  box.innerHTML = dictState.dicts
    .map((d) => {
      const active = d.id === sel ? ' active' : '';
      const tick = d.id === sel ? '✓' : '';
      const custom = d.kind === 'user' ? '<em>自定义</em>' : '';
      const del =
        d.kind === 'user'
          ? '<button type="button" class="di-del" data-del="' +
            escapeHtml(d.id) +
            '" title="删除这个词表">✕</button>'
          : '';
      return (
        '<div class="dict-item' + active + '" data-dict="' + escapeHtml(d.id) + '">' +
        '<span class="di-tick">' + tick + '</span>' +
        '<span class="di-name">' + escapeHtml(d.label) + custom + '</span>' +
        '<span class="di-count">' + (d.count || 0) + '</span>' +
        del +
        '</div>'
      );
    })
    .join('');

  box.querySelectorAll('.dict-item').forEach((el) => {
    el.addEventListener('click', async (e) => {
      if (e.target.closest('.di-del')) return;
      await selectDict(el.getAttribute('data-dict'));
    });
  });

  box.querySelectorAll('.di-del').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-del');
      const d = dictState.dicts.find((x) => x.id === id);
      if (!confirm('删除词表「' + (d ? d.label : id) + '」？\n\n只删这份导入的词表，收集记录和已斩词不受影响。')) return;
      const r = await send({ type: 'DELETE_DICT', id: id });
      if (!r || !r.ok) {
        alert('删除失败：' + ((r && r.error) || '未知错误'));
        return;
      }
      await loadDicts();
      renderDictList();
      render({ reset: true });
    });
  });
}

async function selectDict(id) {
  if (!id || id === dictState.selected) {
    closeDictPop();
    return;
  }
  const r = await send({ type: 'SET_VOCABULARY', dictId: id });
  if (!r || !r.ok) {
    alert('切换失败：' + ((r && r.error) || '未知错误'));
    return;
  }
  dictState.selected = id;
  closeDictPop();
  await loadDicts();
  render({ reset: true });
}

function onDocClickForDict(e) {
  const pop = document.getElementById('dictPop');
  if (!pop) return;
  if (pop.contains(e.target)) return;
  if (e.target.closest && e.target.closest('.dict-chip')) return;
  closeDictPop();
}

function openDictPop() {
  const chip = document.getElementById('dictChip');
  const pop = document.getElementById('dictPop');
  if (!chip || !pop) return;
  renderDictList();
  pop.hidden = false;

  // 贴着标签正下方弹出；右/下空间不够就贴回去
  const rect = chip.getBoundingClientRect();
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  let left = rect.left;
  if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - w - 8);
  let top = rect.bottom + 4;
  if (top + h > window.innerHeight - 8) top = Math.max(8, rect.top - h - 4);
  pop.style.left = Math.round(left) + 'px';
  pop.style.top = Math.round(top) + 'px';

  chip.classList.add('open');
  // 延后一拍再挂"点外面关闭"，否则这一次点击立刻就把自己关了
  setTimeout(() => document.addEventListener('click', onDocClickForDict), 0);
}

function closeDictPop() {
  const pop = document.getElementById('dictPop');
  const chip = document.getElementById('dictChip');
  if (pop) pop.hidden = true;
  if (chip) chip.classList.remove('open');
  document.removeEventListener('click', onDocClickForDict);
}

// ---------- 导入解析：JSON / CSV / TSV / TXT ----------
function splitCsvLine(line, sep) {
  const out = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuote = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuote = true;
    } else if (c === sep) {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function parseDictJson(text) {
  const data = JSON.parse(text);
  const words = {};
  let skipped = 0;
  const put = (w, m) => {
    const k = String(w == null ? '' : w).trim().toLowerCase();
    const v = String(m == null ? '' : m).trim();
    if (!k || !v) {
      skipped++;
      return;
    }
    if (!words[k]) words[k] = v;
  };

  if (Array.isArray(data)) {
    for (const item of data) {
      if (Array.isArray(item)) put(item[0], item[1]);
      else if (item && typeof item === 'object') {
        put(
          item.word || item.w || item.term || item.headword,
          item.meaning || item.definition || item.translation || item.zh || item['释义'] || item['中文']
        );
      } else {
        skipped++;
      }
    }
  } else if (data && typeof data === 'object') {
    const src = data.words && typeof data.words === 'object' ? data.words : data;
    for (const k of Object.keys(src)) {
      const v = src[k];
      if (typeof v === 'string') put(k, v);
      else if (v && typeof v === 'object') put(k, v.meaning || v.definition || v.translation);
      else skipped++;
    }
  } else {
    return { words: {}, skipped: 0, error: 'JSON 里既不是对象也不是数组' };
  }
  return { words: words, skipped: skipped };
}

function parseDictLines(text) {
  const lines = text.split(/\r?\n/);
  const sample = lines.slice(0, 20).join('\n');
  let sep = null;
  if (sample.indexOf('\t') >= 0) sep = '\t';
  else if (sample.indexOf(',') >= 0) sep = ',';
  else if (sample.indexOf(';') >= 0) sep = ';';

  const words = {};
  let skipped = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.charAt(0) === '#') continue;
    let word;
    let meaning;
    if (sep) {
      const cells = splitCsvLine(line, sep);
      word = cells[0];
      meaning = cells.slice(1).join(' ').trim();
    } else {
      // 没有分隔符：第一段是单词，剩下整段是释义
      const m = line.match(/^([A-Za-z][A-Za-z'’-]{0,40})\s+(.+)$/);
      if (!m) {
        skipped++;
        continue;
      }
      word = m[1];
      meaning = m[2];
    }
    const k = String(word || '').trim().toLowerCase();
    const v = String(meaning || '').trim();
    if (!k || !v) {
      skipped++;
      continue;
    }
    if (/^(word|单词|词|term|headword)$/.test(k)) continue; // 表头
    if (!words[k]) words[k] = v;
  }
  return { words: words, skipped: skipped };
}

function parseDictText(text, filename) {
  const t = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!t) return { words: {}, skipped: 0, error: '文件是空的' };
  const ext = String(filename || '').split('.').pop().toLowerCase();
  const looksJson = t.charAt(0) === '{' || t.charAt(0) === '[';
  if (ext === 'json' || looksJson) {
    try {
      return parseDictJson(t);
    } catch (e) {
      return { words: {}, skipped: 0, error: 'JSON 解析失败：' + (e.message || e) };
    }
  }
  return parseDictLines(t);
}

async function importDictFile(file) {
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    alert('文件太大（超过 5 MB），请精简后再导入');
    return;
  }
  let text;
  try {
    text = await file.text();
  } catch (e) {
    alert('读取文件失败：' + (e.message || e));
    return;
  }
  const parsed = parseDictText(text, file.name);
  if (parsed.error) {
    alert('导入失败：' + parsed.error);
    return;
  }
  const count = Object.keys(parsed.words).length;
  if (count === 0) {
    alert(
      '这个文件里没解析出「单词 + 释义」形式的条目。\n\n' +
        '支持：JSON（{"word":"释义"} 或 [{"word","meaning"}]）、' +
        'CSV / TSV / TXT（每行「单词,释义」或「单词<Tab>释义」）。'
    );
    return;
  }
  const name = String(file.name || '我的词表').replace(/\.[^.]+$/, '').slice(0, 40);
  const r = await send({ type: 'IMPORT_DICT', name: name, words: parsed.words });
  if (!r || !r.ok) {
    alert('导入失败：' + ((r && r.error) || '未知错误'));
    return;
  }
  alert(
    '已导入「' + r.dict.label + '」：' + r.dict.count + ' 条' +
      (r.dict.skipped ? '（跳过 ' + r.dict.skipped + ' 行无效）' : '')
  );
  await send({ type: 'SET_VOCABULARY', dictId: r.dict.id });
  await loadDicts();
  closeDictPop();
  render({ reset: true });
}

document.getElementById('dictImportBtn').addEventListener('click', () => {
  document.getElementById('dictFile').click();
});

document.getElementById('dictFile').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = ''; // 允许连续导入同一个文件
  await importDictFile(file);
});

document.getElementById('dictSrcLink').addEventListener('click', (e) => {
  e.preventDefault();
  try {
    chrome.tabs.create({ url: chrome.runtime.getURL('docs/vocabulary-sources.html') });
  } catch (err) {
    /* noop */
  }
});

// ============ 诊断面板 ============
// 把「卡在哪一步」摊开：采集状态、字幕容器、当前记录。数据全在本地，不做任何上报。
function openDiagnostics() {
  renderDiagnostics();
  document.getElementById('diagPanel').classList.add('open');
}

function renderDiagnostics() {
  const box = document.getElementById('diagBody');
  if (!box) return;
  const st = captureStatus || {};
  const d = contentDebug || {};

  const rows = (pairs) =>
    pairs
      .map(
        (p) =>
          '<div class="diag-row"><b>' +
          escapeHtml(p[0]) +
          '</b><span>' +
          p[1] +
          '</span></div>'
      )
      .join('');

  let html = '<div class="diag-sec"><h4>采集</h4>';
  html += rows([
    ['状态', escapeHtml(st.status || '未知')],
    ['说明', escapeHtml(st.detail || '—')],
    ['已读字幕', String(st.cueCount || 0) + ' 句'],
    ['已落盘', st.saved ? '<span class="diag-ok">是</span>' : '否'],
    [
      '保存耗时',
      st.roundTripMs != null ? st.roundTripMs + ' ms（字幕变化 → 后台确认）' : '—',
    ],
    [
      '状态时间',
      st.at ? new Date(st.at).toLocaleTimeString('zh-CN', { hour12: false }) : '—',
    ],
  ]);
  html += '</div>';

  html += '<div class="diag-sec"><h4>字幕容器</h4>';
  if (d.hostFound === undefined) {
    html +=
      '<div class="diag-row"><b>—</b><span>当前页面没回诊断信息（不是视频页，或页面还没刷新过）</span></div>';
  } else {
    html += rows([
      [
        '容器',
        d.hostFound ? '<span class="diag-ok">✅ 找到</span>' : '<span class="diag-bad">❌ 未找到</span>',
      ],
      ['Shadow DOM', d.hasShadowRoot ? '✅ 有' : '❌ 无'],
      ['英文行', String(d.sourceCueCount || 0) + ' 个'],
      ['中文行', String(d.targetCueCount || 0) + ' 个'],
      ['样例', d.rootTextSample ? escapeHtml(d.rootTextSample) : '—'],
    ]);
  }
  html += '</div>';

  html += '<div class="diag-sec"><h4>当前记录</h4>';
  if (currentRecord) {
    const words = currentRecord.words || [];
    const times = words.reduce((n, w) => n + ((w.times || []).length || 0), 0);
    html += rows([
      ['视频 ID', escapeHtml(currentRecord.videoId || '—')],
      ['四级词', String(words.length)],
      ['时间点', String(times)],
      ['来源', escapeHtml(currentRecord.source || '—')],
    ]);
  } else {
    html += '<div class="diag-row"><b>—</b><span>还没有当前视频的记录</span></div>';
  }
  html += '</div>';

  box.innerHTML = html;
}

document.getElementById('diagBtn').addEventListener('click', openDiagnostics);
document.getElementById('diagClose').addEventListener('click', () => {
  document.getElementById('diagPanel').classList.remove('open');
});
document.getElementById('diagPanel').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.classList.remove('open');
});

// 采集状态有更新就刷新状态条（弹窗开着的时候也能看到进度）
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.captureStatus) return;
    captureStatus = changes.captureStatus.newValue || null;
    renderCaptureStatus();
  });
} catch (e) {
  /* 老环境没有 storage.onChanged 时静默跳过 */
}

// 启动
bindCurrentDelegation();
bindDeckSwipe();
bindDeckKeyboard();
init();
