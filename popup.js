// popup.js —— 结果页逻辑

'use strict';

let currentRecord = null;
let activePageRecordId = null;
let currentRecordId = null;
let currentSessionId = null;
let activeTabId = null;
let currentVersion = 0;
let persistedVersion = 0;
let lastStatusSequence = 0;
let captureState = null;
let perfSummary = null;
let historyRequest = 0;
let initRequest = 0;
let navigationRequest = 0;
let familiarWords = [];
let familiarEntries = [];
let selectedVocabulary = 'cet4';
let learningMode = 'normal';
const VOCABULARY_LABELS = { cet4: '四级', cet6: '六级', ielts: '雅思' };
let uiError = '';
let currentTab = 'current';
let searchKeyword = '';
let quizContextVersion = 0;
const quizCache = new Map();
const quizState = new Map();
let voiceNotice = null;
let detailRequest = 0;

// 发送消息到 background（Promise 包装）
function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      const error = chrome.runtime.lastError;
      resolve(error ? { ok: false, error: error.message } : (resp || { ok: false, error: '扩展未响应，请重新加载扩展' }));
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

// 初始化当前标签页身份后只查询记录，不再把页面累计字幕重新提交给后台。
let lastStatus = null;
let contentAlive = null; // null=未知, true=content 响应了, false=没注入
let contentDebug = null; // content 返回的诊断信息
async function init() {
  const requestId = ++initRequest;
  const picker = document.getElementById('vocabularySelect');
  const modePicker = document.getElementById('learningModeSelect');
  picker.disabled = true;
  modePicker.disabled = true;
  const settings = await send({ type: 'GET_VOCABULARY' });
  picker.disabled = false;
  modePicker.disabled = false;
  if (!settings.ok) {
    uiError = settings.error;
    lastStatus = { type: 'error', error: settings.error };
    render();
    return;
  }
  selectedVocabulary = settings.selectedVocabulary;
  picker.value = selectedVocabulary;
  learningMode = settings.learningMode === 'quiz' ? 'quiz' : 'normal';
  modePicker.value = learningMode;
  document.getElementById('settingsOpenBtn').disabled = false;
  quizContextVersion += 1;
  uiError = '';
  currentRecord = null;
  const familiar = await send({ type: 'GET_FAMILIAR' });
  if (!familiar.ok) {
    uiError = familiar.error;
    lastStatus = { type: 'error', error: familiar.error };
    render();
    return;
  }
  updateFamiliar(familiar);
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tabs && tabs[0] ? tabs[0].id : null;
  const cs = await sendToContent({ type: 'GET_STATE' });
  if (requestId !== initRequest) return;
  contentAlive = !!(cs && cs.ok);
  contentDebug = cs && cs.state ? cs.state.debug || null : null;
  currentRecord = null;
  currentRecordId = null;
  currentVersion = 0;
  persistedVersion = 0;
  if (cs && cs.ok && cs.state && cs.state.recordId) {
    activePageRecordId = cs.state.recordId;
    currentRecordId = cs.state.recordId;
    currentSessionId = cs.state.sessionId || null;
    lastStatusSequence = Number(cs.state.statusSequence) || 0;
    captureState = cs.state;
    const record = await send({ type: 'GET_VIDEO', recordId: currentRecordId });
    if (requestId !== initRequest) return;
    if (record && record.ok) {
      currentRecord = record.record;
      currentVersion = record.version || (record.record && record.record.version) || 0;
      persistedVersion = record.persistedVersion || currentVersion;
      updateFamiliar(record);
      lastStatus = null;
    } else {
      lastStatus = { type: 'error', error: record.error || '读取当前视频失败' };
    }
  } else {
    // 没有当前页面身份时显示连接状态，不把上一视频记录伪装成当前视频。
    activePageRecordId = null;
    currentSessionId = null;
    captureState = null;
    lastStatus = { type: 'disconnected' };
  }
  const perf = await send({ type: 'GET_PERF' });
  if (requestId !== initRequest) return;
  perfSummary = perf && perf.ok ? perf.summary : null;
  render();
}

function updateFamiliar(resp) {
  if (!resp || !resp.ok) {
    uiError = resp && resp.error ? resp.error : '读取已斩词失败';
    return;
  }
  familiarWords = resp.familiar || [];
  familiarEntries = resp.familiarEntries || [];
}

function selectedWords(words) {
  return (words || []).filter((item) => (item.categories || []).includes(selectedVocabulary));
}

function modeWords(words) {
  return selectedWords(words).filter((item) => !item.isBasic);
}

function activeWords(words) {
  const slashed = new Set(familiarWords);
  return modeWords(words).filter((item) => !slashed.has(item.word));
}

function vocabularyTags(categories) {
  return '<span class="vocabulary-tags">' + (categories || [])
    .filter((category) => Object.hasOwn(VOCABULARY_LABELS, category))
    .map((category) => `<span class="vocabulary-tag ${category}"${category === 'ielts' ? ' title="社区 TOEFL/IELTS 共用学术词表，非官方"' : ''}>${VOCABULARY_LABELS[category]}</span>`)
    .join('') + '</span>';
}

function renderVocabularyStatus() {
  const status = document.getElementById('vocabularyStatus');
  if (!status) return;
  status.textContent = uiError || (learningMode === 'quiz'
    ? '测试模式已隐藏基础词；答对仅完成本题，熟悉词请点「斩」'
    : selectedVocabulary === 'ielts'
    ? '社区学术词表，含 TOEFL 词汇，非官方'
    : '每次选择一个词库，词卡显示全部命中标签');
  status.classList.toggle('error', !!uiError);
}

function renderSettingsSummary() {
  const summary = document.getElementById('settingsSummaryText');
  if (!summary) return;
  const vocabulary = VOCABULARY_LABELS[selectedVocabulary] || '四级';
  const mode = learningMode === 'quiz' ? '测试模式' : '普通模式';
  summary.textContent = `${vocabulary} · ${mode}`;
}

function captureStatusMessage() {
  const status = captureState && captureState.status;
  const labels = {
    connecting: '正在连接字幕来源',
    waiting: '等待可读取的英文字幕',
    collecting: '正在收集并保存字幕',
    saved: '本地记录已保存',
    no_captions: '没有可读取的英文字幕',
    error: '字幕来源连接失败',
    save_failed: '本地保存失败，输入仍在页面缓存中',
  };
  let message = status ? labels[status] || status : (contentAlive === false ? '扩展脚本未连接' : '等待字幕状态');
  if (captureState && captureState.detail) message += ' · ' + captureState.detail;
  if (currentRecord && currentRecord.identityConfirmed === false) message += ' · 视频身份未确认';
  if (currentVersion > persistedVersion) message += ' · 保存队列中';
  const uiMetric = perfSummary && perfSummary.captureToPopup;
  if (uiMetric && uiMetric.p95 != null) {
    message += ` · 弹窗更新回调 P95 ${Math.round(uiMetric.p95)} ms（${uiMetric.sampleCount} 次）`;
  }
  return message;
}

function renderCaptureStatus() {
  const element = document.getElementById('captureStatus');
  if (!element) return;
  const status = captureState && captureState.status;
  const compactLabels = {
    connecting: '正在连接字幕',
    waiting: '等待英文字幕',
    collecting: '正在收集',
    saved: '已保存',
    no_captions: '未找到英文字幕',
    error: '连接失败',
    save_failed: '保存失败',
  };
  element.textContent = status
    ? compactLabels[status] || '字幕状态已更新'
    : (contentAlive === false ? '脚本未连接' : '等待字幕状态');
  element.dataset.state = status || (contentAlive === false ? 'error' : 'waiting');
  renderDiagnosticsPanel();
}

function renderDiagnosticsPanel() {
  const status = document.getElementById('diagnosticsCaptureStatus');
  const debug = document.getElementById('diagnosticsContentDebug');
  if (!status || !debug) return;
  status.textContent = captureStatusMessage();
  debug.innerHTML = renderDebug() || '暂无页面字幕容器诊断信息。';
}

function renderPerformanceMetrics() {
  const container = document.getElementById('perfMetrics');
  if (!container) return;
  if (!perfSummary) {
    container.textContent = '暂无计时样本';
    return;
  }
  const format = (metric) => metric && metric.sampleCount
    ? `P50 ${Number(metric.p50).toFixed(1)} ms · P95 ${Number(metric.p95).toFixed(1)} ms · n=${metric.sampleCount}`
    : '暂无样本';
  const rows = [
    ['字幕回调 → 后台收到', perfSummary.captureToBackground],
    ['后台匹配与展示过滤', perfSummary.match],
    ['普通单句匹配', perfSummary.normalIncrementalMatch],
    ['YouTube 整轨匹配', perfSummary.youtubeNativeMatch],
    ['本地存储写入', perfSummary.save],
    ['字幕回调 → 本地保存', perfSummary.captureToSave],
    ['字幕回调 → 弹窗绘制回调', perfSummary.captureToPopup],
    ['本地历史记录恢复', perfSummary.recordRestore],
    ['YouTube 整轨网络请求', perfSummary.youtubeCaptionFetch],
  ];
  const cold = perfSummary.vocabularyColdStartMs == null ? '尚未加载' : `${Number(perfSummary.vocabularyColdStartMs).toFixed(1)} ms`;
  container.innerHTML = rows.map(([label, metric]) => `<div>${escapeHtml(label)}：${escapeHtml(format(metric))}</div>`).join('') +
    `<div>三份词库冷加载：${escapeHtml(cold)}</div>` +
    '<div class="muted">按回调采集起点计时；弹窗项到 requestAnimationFrame 回调，不等于完整物理绘制。浏览器时间精度有限；后台重启后样本会清空。</div>';
}

// 渲染当前 tab
function render() {
  renderVocabularyStatus();
  renderSettingsSummary();
  const titleEl = document.getElementById('videoTitle');
  if (currentRecord) {
    titleEl.textContent = (currentRecord.title || '(无标题)') + (currentRecord.identityConfirmed === false ? ' · 视频身份未确认' : '');
  } else if (captureState && captureState.title) {
    titleEl.textContent = captureState.title + (captureState.identityConfirmed === false ? ' · 视频身份未确认' : '');
  } else if (lastStatus && lastStatus.type === 'no_captions') {
    titleEl.textContent = (lastStatus.title || '视频') + ' — 无字幕';
  } else if (lastStatus && lastStatus.type === 'error') {
    titleEl.textContent = '抓取出错';
  } else {
    titleEl.textContent = '尚未捕获视频';
  }
  renderCaptureStatus();
  renderPerformanceMetrics();
  renderCurrent();
  renderFamiliar();
  if (currentTab === 'history') renderHistory();
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

function questionLemma(w) {
  return String(w.lemma || w.word || '').toLowerCase();
}

function questionKey(w) {
  return selectedVocabulary + ':' + questionLemma(w);
}

function getQuizState(key) {
  if (!quizState.has(key)) quizState.set(key, { wrong: new Set(), solved: false });
  return quizState.get(key);
}

function renderQuizBlock(w) {
  const key = questionKey(w);
  if (!quizCache.has(key)) return '<div class="quiz-loading">正在准备本地题目…</div>';
  const question = quizCache.get(key);
  if (!question) return '<div class="quiz-missing">该词暂无题目，可以点「详解」正常查词。</div>';
  const state = getQuizState(key);
  let html = '<div class="quiz">';
  if (!state.solved) {
    html += question.options.map((option, index) => {
      const wrong = state.wrong.has(index);
      const correct = index === question.correctIndex && state.solved;
      const marker = wrong ? '✕' : correct ? '✓' : '';
      return `<button class="opt quiz-option ${wrong ? 'wrong' : ''} ${correct ? 'correct' : ''}" data-word="${escapeHtml(w.word)}" data-choice="${index}" ${wrong ? 'disabled' : ''}>
        <span class="idx">${String.fromCharCode(65 + index)}</span><span class="txt">${escapeHtml(option)}</span><span class="mark">${marker}</span>
      </button>`;
    }).join('');
    html += '<div class="quiz-tip">单击单词朗读 · 选择中文释义</div>';
  } else {
    html += `<button class="answer-reveal" data-word="${escapeHtml(w.word)}"><span>✅ 本题完成 · 释义：<b>${escapeHtml(question.correct)}</b></span><span class="more">点此看详解 ▸</span></button>`;
  }
  if (voiceNotice && voiceNotice.word === w.word) html += `<div class="voice-status">${escapeHtml(voiceNotice.text)}</div>`;
  html += '</div>';
  return html;
}

async function ensureQuizzes(words) {
  const category = selectedVocabulary;
  const recordId = currentRecordId;
  const contextVersion = quizContextVersion;
  const lemmas = Array.from(new Set(words.map(questionLemma).filter(Boolean)));
  const missing = lemmas.filter((lemma) => !quizCache.has(category + ':' + lemma));
  if (!missing.length) return;
  for (let offset = 0; offset < missing.length; offset += 500) {
    const batch = missing.slice(offset, offset + 500);
    const response = await send({ type: 'GET_QUIZ_BATCH', vocabulary: category, words: batch });
    if (contextVersion !== quizContextVersion || category !== selectedVocabulary ||
        recordId !== currentRecordId || learningMode !== 'quiz') return;
    const quizzes = response && response.ok ? response.quizzes || {} : {};
    for (const lemma of batch) quizCache.set(category + ':' + lemma, quizzes[lemma] || null);
  }
  const container = document.getElementById('currentContent');
  for (const card of container.querySelectorAll('.word-card')) {
    const word = (currentRecord && currentRecord.words || []).find((item) => item.word === card.getAttribute('data-word'));
    const host = card.querySelector('.quiz-host');
    if (word && host && (word.categories || []).includes(category)) host.innerHTML = renderQuizBlock(word);
  }
}

function renderWordCard(w, slashedSet) {
  const isSlashed = slashedSet.has(w.word);
  const timesHtml = (w.times || []).slice(0, 10)
    .map((t) => `<span class="time-tag">${escapeHtml(t)}</span>`)
    .join('');
  const lemmaHint = w.lemma && w.lemma !== w.word
    ? `<span class="word-hint">→ ${escapeHtml(w.lemma)}</span>`
    : '';
  if (learningMode === 'quiz') {
    return `
    <div class="word-card ${isSlashed ? 'slashed' : ''}" data-word="${escapeHtml(w.word)}">
      <div class="word-head">
        <div class="word-left">
          <div class="word-text word-speak" data-word="${escapeHtml(w.word)}" title="点击单词朗读">${escapeHtml(w.word)}${lemmaHint}<span class="spk">🔊</span></div>
          ${vocabularyTags(w.categories)}
        </div>
        <div class="word-actions">
          <button class="mini-btn detail-btn" data-word="${escapeHtml(w.word)}">详解</button>
          <button class="slash-btn ${isSlashed ? 'slashed' : ''}" data-word="${escapeHtml(w.word)}">${isSlashed ? '已斩 ✓' : '斩'}</button>
        </div>
      </div>
      <div class="quiz-host">${renderQuizBlock(w)}</div>
      <div class="times">${timesHtml}</div>
    </div>`;
  }
  return `
    <div class="word-card ${isSlashed ? 'slashed' : ''}" data-word="${escapeHtml(w.word)}">
      <div class="word-head">
        <div class="word-left word-clickable" data-word="${escapeHtml(w.word)}">
          <div class="word-text">${escapeHtml(w.word)}${lemmaHint}</div>
          ${vocabularyTags(w.categories)}
          <div class="word-meaning">${escapeHtml(w.meaning || '点击单词联网查释义')}</div>
        </div>
        <button class="slash-btn ${isSlashed ? 'slashed' : ''}" data-word="${escapeHtml(w.word)}">
          ${isSlashed ? '已斩 ✓' : '斩'}
        </button>
      </div>
      <div class="times">${timesHtml}</div>
    </div>`;
}

// 渲染当前视频单词列表
function renderCurrent() {
  const container = document.getElementById('currentContent');
  if (!currentRecord) {
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
    if (lastStatus && lastStatus.type === 'disconnected') {
      container.innerHTML = '<div class="empty"><div class="icon">🔌</div><b>当前页面没有连接字幕采集</b><br/>' +
        '打开视频页后刷新页面，再让字幕出现。已有视频记录可在「历史记录」中查看。</div>';
      return;
    }
    container.innerHTML =
      (contentAlive === false
        ? '<div class="empty"><div class="icon">🔌</div><b>扩展脚本没在这个页面跑起来</b><br/>' +
          '请先<b>刷新当前视频页面</b>（F5），再打开沉浸式翻译双语字幕，' +
          '或启用可读取的英文字幕轨。' +
          '<br/><br/>（改完代码后，扩展和页面都要刷新一次）</div>'
        : contentAlive === true
        ? '<div class="empty"><div class="icon">🎬</div><b>脚本已连接，等待可读取的英文字幕</b><br/>' +
          '可以显示沉浸式翻译的英文原文，或启用网站提供的英文字幕轨。' +
          renderDebug() +
          '</div>'
        : '<div class="empty"><div class="icon">🎬</div>打开一个视频<br/>（需有字幕）后回到这里查看</div>');
    return;
  }

  const allWords = modeWords(currentRecord.words);
  const slashedSet = new Set(familiarWords);
  const words = allWords.filter((word) => !slashedSet.has(word.word));
  const kw = searchKeyword.trim().toLowerCase();

  // 过滤
  let shown = words.filter((w) => {
    if (kw) {
      return w.word.toLowerCase().includes(kw) || (w.meaning || '').toLowerCase().includes(kw);
    }
    return true;
  });

  const slashedCount = allWords.length - words.length;
  const activeCount = words.length;

  // 顶部统计
  let statsHtml = `
    <div class="stats">
      <div class="stat"><b>${allWords.length}</b>${VOCABULARY_LABELS[selectedVocabulary]}词</div>
      <div class="stat"><b>${activeCount}</b>待记</div>
      <div class="stat"><b>${slashedCount}</b>已斩</div>
    </div>`;

  if (currentRecord.isLegacyVocabulary && selectedVocabulary !== 'cet4') {
    statsHtml += '<p class="legacy-note">旧记录只采集过四级词，重新抓取可补全新词库。</p>';
  }

  if (allWords.length === 0) {
    container.innerHTML = statsHtml + '<div class="empty"><div class="icon">🔍</div>本视频字幕里没有匹配到待学习的' + VOCABULARY_LABELS[selectedVocabulary] + '词汇<br/><span class="muted">基础词已自动隐藏；可切换词库查看其他命中</span></div>';
    return;
  }

  if (words.length === 0) {
    container.innerHTML = statsHtml + '<div class="empty"><div class="icon">🎉</div>当前模式下的词都已斩掉<br/>需要撤销时打开「已斩词」页，点击词条后的 ✕。</div>';
    return;
  }

  if (shown.length === 0) {
    container.innerHTML = statsHtml + '<div class="empty"><div class="icon">🔍</div>没有匹配「' + escapeHtml(searchKeyword) + '」的单词</div>';
    return;
  }

  const cardsHtml = shown.map((word) => renderWordCard(word, slashedSet)).join('');
  container.innerHTML = statsHtml + cardsHtml;
  if (learningMode === 'quiz') void ensureQuizzes(shown);
}

function refreshStatsOnly(container) {
  const stats = container.querySelector('.stats');
  if (!stats || !currentRecord) return false;
  const allWords = modeWords(currentRecord.words);
  const slashedSet = new Set(familiarWords);
  const active = allWords.filter((word) => !slashedSet.has(word.word)).length;
  const slashed = allWords.length - active;
  const html = `<div class="stats">
    <div class="stat"><b>${allWords.length}</b>${VOCABULARY_LABELS[selectedVocabulary]}词</div>
    <div class="stat"><b>${active}</b>待记</div>
    <div class="stat"><b>${slashed}</b>已斩</div>
  </div>`;
  stats.outerHTML = html;
  return true;
}

function applyRecordDelta(message) {
  if (message.recordId !== currentRecordId || Number(message.version) <= currentVersion) return;
  const container = document.getElementById('currentContent');
  const scrollTop = container.scrollTop;
  if (!currentRecord) {
    currentRecord = {
      videoId: message.recordId,
      recordId: message.recordId,
      title: message.title || '',
      identityConfirmed: message.identityConfirmed !== false,
      words: [],
      totalWords: 0,
      capturedAt: Date.now(),
      version: 0,
      vocabularyVersion: 1,
    };
  }
  const wordsBySurface = new Map((currentRecord.words || []).map((word) => [String(word.word || '').toLowerCase(), word]));
  for (const word of message.changedWords || []) {
    wordsBySurface.set(String(word.word || '').toLowerCase(), word);
  }
  currentRecord.words = Array.from(wordsBySurface.values());
  currentRecord.totalWords = Number(message.totalWords) || currentRecord.words.length;
  currentRecord.title = message.title || currentRecord.title;
  currentRecord.identityConfirmed = message.identityConfirmed !== false;
  currentRecord.version = Number(message.version) || currentVersion;
  currentVersion = Number(message.version) || currentVersion;
  persistedVersion = Number(message.persistedVersion) || persistedVersion;
  captureState = {
    ...(captureState || {}),
    recordId: message.recordId,
    title: currentRecord.title,
    identityConfirmed: currentRecord.identityConfirmed,
    status: 'collecting',
    detail: message.hadNewMatches ? '字幕已读取，已发现新的命中词。' : '字幕已读取，但这一批没有新增命中词。',
  };
  document.getElementById('videoTitle').textContent = currentRecord.title || '(无标题)';
  if (!currentRecord.identityConfirmed) document.getElementById('videoTitle').textContent += ' · 视频身份未确认';
  renderCaptureStatus();

  if (currentTab === 'current') {
    if (searchKeyword.trim() || !container.querySelector('.stats')) {
      renderCurrent();
    } else {
      let needsFullRender = false;
      const slashedSet = new Set(familiarWords);
      for (const word of message.changedWords || []) {
        const matchesSelected = (word.categories || []).includes(selectedVocabulary);
        const visibleInMode = learningMode === 'quiz' || !word.isBasic;
        const notFamiliar = !familiarWords.includes(word.word);
        const query = searchKeyword.trim().toLowerCase();
        const matchesQuery = !query || word.word.toLowerCase().includes(query) || (word.meaning || '').toLowerCase().includes(query);
        const existing = Array.from(container.querySelectorAll('.word-card')).find((card) => card.getAttribute('data-word') === word.word);
        if (!matchesSelected || !visibleInMode || !notFamiliar || !matchesQuery) {
          if (existing) existing.remove();
          continue;
        }
        const markup = renderWordCard(word, slashedSet);
        if (existing) existing.outerHTML = markup;
        else {
          const insertionPoint = container.querySelector('.empty');
          if (insertionPoint) needsFullRender = true;
          else container.insertAdjacentHTML('beforeend', markup);
        }
      }
      if (needsFullRender || !refreshStatsOnly(container)) renderCurrent();
    }
    container.scrollTop = scrollTop;
    if (learningMode === 'quiz') void ensureQuizzes(activeWords(currentRecord.words));
  } else if (currentTab === 'history') {
    renderHistory();
  }

  if (message.capturedAtEpoch) {
    requestAnimationFrame(() => {
      const captureToPopupMs = performance.timeOrigin + performance.now() - Number(message.capturedAtEpoch);
      if (Number.isFinite(captureToPopupMs) && captureToPopupMs >= 0) {
        void (async () => {
          await send({ type: 'PERF_SAMPLE', captureToPopupMs });
          const response = await send({ type: 'GET_PERF' });
          if (response && response.ok && message.recordId === currentRecordId) {
            perfSummary = response.summary;
            renderCaptureStatus();
            renderPerformanceMetrics();
          }
        })();
      }
    });
  }
}

async function loadActivePageRecord() {
  const navigationId = ++navigationRequest;
  quizContextVersion += 1;
  detailRequest += 1;
  document.getElementById('detailPanel').classList.remove('open');
  const targetId = activePageRecordId;
  if (!targetId) {
    currentRecordId = null;
    currentRecord = null;
    currentVersion = 0;
    persistedVersion = 0;
    render();
    return;
  }
  currentRecordId = targetId;
  currentRecord = null;
  currentVersion = 0;
  persistedVersion = 0;
  render();
  const response = await send({ type: 'GET_VIDEO', recordId: targetId });
  if (navigationId !== navigationRequest || currentTab !== 'current' || activePageRecordId !== targetId) return;
  currentRecordId = targetId;
  currentRecord = response && response.ok ? response.record : null;
  currentVersion = response && response.ok ? Number(response.version) || 0 : 0;
  persistedVersion = response && response.ok ? Number(response.persistedVersion) || currentVersion : 0;
  if (response && response.ok) updateFamiliar(response);
  else lastStatus = { type: 'error', error: response && response.error || '读取当前视频失败' };
  render();
}

// 渲染已斩词列表
function renderFamiliar() {
  const container = document.getElementById('familiarContent');
  // Keep familiar basic words visible here in every mode so users can undo
  // words that were slashed while studying in quiz mode.
  const entries = selectedWords(familiarEntries);
  if (entries.length === 0) {
    container.innerHTML = '<div class="empty"><div class="icon">✂️</div>这个词库还没有已斩词<br/>在单词卡片上点「斩」即可标记为熟悉词</div>';
    return;
  }
  let html = '<div class="familiar-list">';
  for (const item of entries) {
    html += `<span class="familiar-item">${escapeHtml(item.word)} ${vocabularyTags(item.categories)}<span class="undo" data-word="${escapeHtml(item.word)}">✕</span></span>`;
  }
  html += '</div>';
  container.innerHTML = html;

  container.querySelectorAll('.undo').forEach((el) => {
    el.addEventListener('click', async () => {
      const word = el.getAttribute('data-word');
      const resp = await send({ type: 'UNSLASH_WORD', word: word });
      updateFamiliar(resp);
      render();
    });
  });
}

// 渲染历史记录
async function renderHistory() {
  const requestId = ++historyRequest;
  const container = document.getElementById('historyContent');
  const oldScrollTop = container.scrollTop;
  const resp = await send({ type: 'GET_ALL_VIDEOS' });
  if (requestId !== historyRequest || currentTab !== 'history') return;
  if (!resp.ok) {
    container.innerHTML = '<div class="empty">' + escapeHtml(resp.error) + '</div>';
    return;
  }
  const videos = resp.videos || [];
  if (videos.length === 0) {
    container.innerHTML = '<div class="empty"><div class="icon">📦</div>暂无历史记录</div>';
    return;
  }
  let html = '';
  for (const v of videos) {
    const date = new Date(v.capturedAt).toLocaleString('zh-CN', { hour12: false });
    const isActivePage = v.videoId === activePageRecordId;
    const title = v.title || v.videoId;
    html += `
      <div class="video-item" data-video="${escapeHtml(v.videoId)}">
        <div class="v-item-head">
          <div class="v-title">${escapeHtml(title)}</div>
          <button type="button" class="video-delete" data-video="${escapeHtml(v.videoId)}" aria-label="${isActivePage ? '当前页面记录无法删除：' : '删除历史记录：'}${escapeHtml(title)}" title="${isActivePage ? '当前页面仍关联此记录，切换视频或关闭页面后可删除' : '删除这条历史记录'}" ${isActivePage ? 'disabled' : ''}>${isActivePage ? '当前页' : '删除'}</button>
        </div>
        <div class="v-meta">${activeWords(v.words).length} 个待学词 · ${date}</div>
        ${v.isLegacyVocabulary && selectedVocabulary !== 'cet4' ? '<div class="v-meta">旧记录只含原四级采集结果</div>' : ''}
      </div>`;
  }
  container.innerHTML = html;
  container.scrollTop = oldScrollTop;

  container.querySelectorAll('.video-delete').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (button.disabled) return;
      const videoId = button.getAttribute('data-video');
      const video = videos.find((item) => item.videoId === videoId);
      const title = video && video.title || videoId;
      if (!window.confirm(`确定删除“${title}”的历史记录吗？删除后无法恢复。`)) return;

      button.disabled = true;
      const response = await send({ type: 'DELETE_VIDEO', videoId });
      if (!response.ok) {
        window.alert('删除失败：' + (response.error || '请重试'));
        button.disabled = false;
        return;
      }
      if (currentRecordId === videoId) {
        navigationRequest += 1;
        quizContextVersion += 1;
        detailRequest += 1;
        document.getElementById('detailPanel').classList.remove('open');
        currentRecord = null;
        currentRecordId = null;
        currentVersion = 0;
        persistedVersion = 0;
      }
      await renderHistory();
    });
  });

  container.querySelectorAll('.video-item').forEach((el) => {
    el.addEventListener('click', async () => {
      const videoId = el.getAttribute('data-video');
      const navigationId = ++navigationRequest;
      quizContextVersion += 1;
      detailRequest += 1;
      document.getElementById('detailPanel').classList.remove('open');
      const r = await send({ type: 'GET_VIDEO', videoId: videoId });
      if (navigationId !== navigationRequest || currentTab !== 'history') return;
      if (r.ok && r.record) {
        currentRecord = r.record;
        currentRecordId = videoId;
        currentVersion = Number(r.version) || Number(r.record.version) || 0;
        persistedVersion = Number(r.persistedVersion) || currentVersion;
        updateFamiliar(r);
        switchTab('current', true);
        render();
      } else if (!r.ok) {
        uiError = r.error;
        renderVocabularyStatus();
      }
    });
  });
}

// tab 切换
function switchTab(tab, preserveViewedRecord) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.getAttribute('data-tab') === tab);
  });
  document.getElementById('tab-current').style.display = tab === 'current' ? '' : 'none';
  document.getElementById('tab-history').style.display = tab === 'history' ? '' : 'none';
  document.getElementById('tab-familiar').style.display = tab === 'familiar' ? '' : 'none';

  if (tab === 'history') renderHistory();
  if (tab === 'current' && !preserveViewedRecord && currentRecordId !== activePageRecordId) void loadActivePageRecord();
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

document.getElementById('currentContent').addEventListener('click', async (event) => {
  const slashButton = event.target.closest('.slash-btn');
  if (slashButton) {
    event.stopPropagation();
    const word = slashButton.getAttribute('data-word');
    const response = await send({ type: familiarWords.includes(word) ? 'UNSLASH_WORD' : 'SLASH_WORD', word });
    updateFamiliar(response);
    const scrollTop = document.getElementById('currentContent').scrollTop;
    renderCurrent();
    document.getElementById('currentContent').scrollTop = scrollTop;
    renderFamiliar();
    return;
  }
  const quizOption = event.target.closest('.quiz-option');
  if (quizOption) {
    event.preventDefault();
    event.stopPropagation();
    const word = quizOption.getAttribute('data-word');
    const wordData = currentRecord && (currentRecord.words || []).find((item) => item.word === word);
    const key = wordData && questionKey(wordData);
    const question = key && quizCache.get(key);
    if (!question) return;
    const state = getQuizState(key);
    const choice = Number(quizOption.getAttribute('data-choice'));
    if (state.solved || state.wrong.has(choice)) return;
    if (choice === question.correctIndex) state.solved = true;
    else state.wrong.add(choice);
    const host = quizOption.closest('.word-card').querySelector('.quiz-host');
    if (host && wordData) host.innerHTML = renderQuizBlock(wordData);
    return;
  }
  const detailButton = event.target.closest('.detail-btn, .answer-reveal');
  if (detailButton) {
    event.stopPropagation();
    openDetail(detailButton.getAttribute('data-word'));
    return;
  }
  const speakButton = event.target.closest('.word-speak');
  if (speakButton) {
    event.stopPropagation();
    speakWord(speakButton.getAttribute('data-word'));
    return;
  }
  const wordCard = event.target.closest('.word-clickable');
  if (wordCard) openDetail(wordCard.getAttribute('data-word'));
});

function showVoiceNotice(word, text) {
  voiceNotice = { word, text };
  const card = Array.from(document.querySelectorAll('#currentContent .word-card'))
    .find((item) => item.getAttribute('data-word') === word);
  if (!card) return;
  let status = card.querySelector('.voice-status');
  if (!status) {
    status = document.createElement('div');
    status.className = 'voice-status';
    const host = card.querySelector('.quiz-host');
    if (host) host.appendChild(status);
  }
  status.textContent = text;
}

function speakWord(word) {
  const synth = window.speechSynthesis;
  if (!synth || typeof SpeechSynthesisUtterance === 'undefined') {
    showVoiceNotice(word, '浏览器不支持语音合成。');
    return;
  }
  const voices = synth.getVoices() || [];
  const voice = voices.find((item) => item.localService === true && /^en(?:-|$)/i.test(item.lang || ''));
  if (!voice) {
    showVoiceNotice(word, '没有可用的本地英语音色，无法朗读。');
    return;
  }
  try {
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(String(word));
    utterance.voice = voice;
    utterance.lang = voice.lang || 'en-US';
    utterance.rate = 0.9;
    utterance.onerror = () => showVoiceNotice(word, '本地英语音色朗读失败。');
    synth.speak(utterance);
    voiceNotice = null;
    const card = Array.from(document.querySelectorAll('#currentContent .word-card'))
      .find((item) => item.getAttribute('data-word') === word);
    const status = card && card.querySelector('.voice-status');
    if (status) status.remove();
  } catch (_) {
    showVoiceNotice(word, '本地英语音色朗读失败。');
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message || !message.type) return;
  if (message.type === 'RECORD_UPDATED') {
    const identityIsUnconfirmed = currentRecord && currentRecord.identityConfirmed === false ||
      captureState && captureState.recordId === currentRecordId && captureState.identityConfirmed === false;
    if (message.recordId === currentRecordId && (!identityIsUnconfirmed || message.sessionId === currentSessionId)) applyRecordDelta(message);
    else if (currentTab === 'history') renderHistory();
    return;
  }
  if (message.type === 'CAPTURE_STATUS') {
    void acceptCaptureStatus(message);
    return;
  }
  if (message.type === 'RECORD_PERSISTED' && message.recordId === currentRecordId) {
    persistedVersion = Math.max(persistedVersion, Number(message.persistedVersion) || 0);
    if (captureState && currentVersion <= persistedVersion) {
      captureState.status = 'saved';
      captureState.detail = '字幕已写入本地记录。';
    }
    renderCaptureStatus();
    void send({ type: 'GET_PERF' }).then((response) => {
      if (response && response.ok) {
        perfSummary = response.summary;
        renderCaptureStatus();
        renderPerformanceMetrics();
      }
    });
    return;
  }
  if ((message.type === 'RECORD_SAVE_FAILED' || message.type === 'RECORD_SAVE_PAUSED') && message.recordId === currentRecordId) {
    captureState = { ...(captureState || {}), status: 'save_failed', detail: message.error || '本地保存失败。' };
    renderCaptureStatus();
  }
});

async function acceptCaptureStatus(message) {
  if (message.tabId !== activeTabId) return;
  let state = message;
  if (currentSessionId && message.sessionId && message.sessionId !== currentSessionId) {
    const response = await sendToContent({ type: 'GET_STATE' });
    if (!response || !response.ok || !response.state || response.state.sessionId !== message.sessionId) return;
    state = response.state;
  }
  const sequence = Number(state.statusSequence) || 0;
  if (state.sessionId === currentSessionId && sequence && sequence <= lastStatusSequence) return;
  const previousPageId = activePageRecordId;
  activePageRecordId = state.recordId || state.videoId || activePageRecordId;
  currentSessionId = state.sessionId || currentSessionId;
  lastStatusSequence = sequence || lastStatusSequence;
  captureState = {
    ...(captureState || {}),
    recordId: activePageRecordId,
    sessionId: currentSessionId,
    statusSequence: lastStatusSequence,
    status: state.status || state.captureStatus || 'waiting',
    detail: state.detail || state.statusDetail || '',
    title: state.title || '',
    identityConfirmed: state.identityConfirmed !== false,
    debug: state.debug || captureState && captureState.debug,
  };
  if (currentTab === 'current' && currentRecordId === previousPageId && activePageRecordId !== previousPageId) {
    currentRecordId = activePageRecordId;
    currentRecord = null;
    currentVersion = 0;
    persistedVersion = 0;
    void loadActivePageRecord();
  } else {
    if (currentTab === 'current' && currentRecordId === activePageRecordId && !currentRecord) {
      void loadActivePageRecord();
    } else {
      renderCaptureStatus();
      if (currentTab === 'current' && !currentRecord) renderCurrent();
    }
  }
}

// 事件绑定
document.getElementById('vocabularySelect').addEventListener('change', async (e) => {
  const picker = e.target;
  picker.disabled = true;
  const resp = await send({ type: 'SET_VOCABULARY', selectedVocabulary: picker.value });
  picker.disabled = false;
  if (resp.ok) {
    selectedVocabulary = resp.selectedVocabulary;
    quizContextVersion += 1;
    detailRequest += 1;
    document.getElementById('detailPanel').classList.remove('open');
    voiceNotice = null;
    uiError = '';
  } else {
    picker.value = selectedVocabulary;
    uiError = resp.error;
  }
  render();
});

document.getElementById('learningModeSelect').addEventListener('change', async (event) => {
  const picker = event.target;
  picker.disabled = true;
  const response = await send({ type: 'SET_LEARNING_MODE', learningMode: picker.value });
  picker.disabled = false;
  if (response && response.ok) {
    learningMode = response.learningMode === 'quiz' ? 'quiz' : 'normal';
    quizContextVersion += 1;
    detailRequest += 1;
    document.getElementById('detailPanel').classList.remove('open');
    voiceNotice = null;
    uiError = '';
  } else {
    picker.value = learningMode;
    uiError = response && response.error || '切换学习模式失败';
  }
  render();
});

document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => switchTab(t.getAttribute('data-tab')));
});

document.getElementById('searchInput').addEventListener('input', (e) => {
  searchKeyword = e.target.value;
  renderCurrent();
});

document.getElementById('recaptureBtn').addEventListener('click', async () => {
  const button = document.getElementById('recaptureBtn');
  button.disabled = true;
  button.textContent = '正在连接…';
  const response = await sendToContent({ type: 'RECAPTURE' });
  if (response && response.ok && response.state) {
    const state = response.state;
    const oldPageRecordId = activePageRecordId;
    activePageRecordId = state.recordId;
    currentSessionId = state.sessionId;
    lastStatusSequence = Number(state.statusSequence) || lastStatusSequence;
    captureState = state;
    contentAlive = true;
    contentDebug = state.debug || null;
    if (currentTab === 'current' && currentRecordId === oldPageRecordId && currentRecordId !== activePageRecordId) {
      currentRecordId = activePageRecordId;
      currentRecord = null;
      currentVersion = 0;
      persistedVersion = 0;
      await loadActivePageRecord();
    } else {
      renderCaptureStatus();
    }
  } else {
    captureState = { ...(captureState || {}), status: 'error', detail: '当前页面未响应重新抓取，请刷新视频页面。' };
    renderCaptureStatus();
  }
  button.disabled = false;
  button.textContent = '重新抓取';
});

document.getElementById('clearFamiliarBtn').addEventListener('click', async () => {
  if (!confirm('确定清空所有已斩单词吗？')) return;
  const resp = await send({ type: 'CLEAR_FAMILIAR' });
  updateFamiliar(resp);
  render();
});

// ============ 单词详情弹窗 ============
// 两阶段渲染：本地数据（原型/精简释义/单词变形/同根词）先秒出，联网释义后补
async function openDetail(word) {
  const panel = document.getElementById('detailPanel');
  const request = ++detailRequest;
  panel.classList.add('open');
  document.getElementById('detailBox').innerHTML = '<div class="detail-loading">正在查询…</div>';

  // 第一阶段：本地，秒出
  const local = await send({ type: 'LOOKUP_LOCAL', word: word });
  if (request !== detailRequest || !panel.classList.contains('open')) return;
  if (!local || !local.ok) {
    document.getElementById('detailBox').innerHTML = '<div class="detail-error">查询失败</div>';
    return;
  }
  renderDetailLocal(word, local);

  // 第二阶段：联网，慢，到了再补
  const resp = await send({ type: 'LOOKUP_ONLINE', word: local.base || word });
  if (request !== detailRequest || !panel.classList.contains('open')) return;
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

  html += vocabularyTags(resp.categories);
  html += `<div class="detail-section"><h4>本地词表释义</h4><div class="def-item">${escapeHtml(resp.localMeaning || '此词表仅提供词头，释义见下方联网结果。')}</div></div>`;

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
    html += `<div class="detail-section"><h4>同根词（内置词表内）</h4><div class="syn-ant">`;
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
    sec.innerHTML = `<h4>各词性释义</h4><div class="muted" style="padding:6px 0">${escapeHtml(err)}；若有本地释义，可先参考上方内容。</div>`;
  }
}

// 点击面板背景关闭
document.getElementById('detailPanel').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) {
    e.currentTarget.classList.remove('open');
  }
});

function openPopupPanel(panelId, triggerId, focusId) {
  const panel = document.getElementById(panelId);
  const trigger = document.getElementById(triggerId);
  panel.classList.add('open');
  panel.setAttribute('aria-hidden', 'false');
  trigger.setAttribute('aria-expanded', 'true');
  const focusTarget = document.getElementById(focusId);
  if (focusTarget && !focusTarget.disabled) focusTarget.focus();
}

function closePopupPanel(panelId, triggerId) {
  const panel = document.getElementById(panelId);
  const trigger = document.getElementById(triggerId);
  panel.classList.remove('open');
  panel.setAttribute('aria-hidden', 'true');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.focus();
}

document.getElementById('settingsOpenBtn').addEventListener('click', () => {
  openPopupPanel('settingsPanel', 'settingsOpenBtn', 'vocabularySelect');
});
document.getElementById('settingsClose').addEventListener('click', () => {
  closePopupPanel('settingsPanel', 'settingsOpenBtn');
});
document.getElementById('diagnosticsBtn').addEventListener('click', () => {
  renderDiagnosticsPanel();
  openPopupPanel('diagnosticsPanel', 'diagnosticsBtn', 'diagnosticsClose');
});
document.getElementById('diagnosticsClose').addEventListener('click', () => {
  closePopupPanel('diagnosticsPanel', 'diagnosticsBtn');
});

for (const [panelId, triggerId] of [
  ['settingsPanel', 'settingsOpenBtn'],
  ['diagnosticsPanel', 'diagnosticsBtn'],
]) {
  document.getElementById(panelId).addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closePopupPanel(panelId, triggerId);
  });
}

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  for (const [panelId, triggerId] of [
    ['settingsPanel', 'settingsOpenBtn'],
    ['diagnosticsPanel', 'diagnosticsBtn'],
  ]) {
    if (document.getElementById(panelId).classList.contains('open')) {
      closePopupPanel(panelId, triggerId);
      return;
    }
  }
  document.getElementById('detailPanel').classList.remove('open');
});

// 启动
init();
