// popup.js —— 结果页逻辑

'use strict';

let currentRecord = null;
let familiarWords = [];
let familiarEntries = [];
let selectedVocabulary = 'cet4';
const VOCABULARY_LABELS = { cet4: '四级', cet6: '六级', ielts: '雅思' };
let uiError = '';
let currentTab = 'current';
let searchKeyword = '';

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

// 初始化：优先问当前标签页的 content 有没有已累积的内容，否则读历史存储
let lastStatus = null;
let contentAlive = null; // null=未知, true=content 响应了, false=没注入
let contentDebug = null; // content 返回的诊断信息
async function init() {
  const picker = document.getElementById('vocabularySelect');
  picker.disabled = true;
  const settings = await send({ type: 'GET_VOCABULARY' });
  picker.disabled = false;
  if (!settings.ok) {
    uiError = settings.error;
    lastStatus = { type: 'error', error: settings.error };
    render();
    return;
  }
  selectedVocabulary = settings.selectedVocabulary;
  picker.value = selectedVocabulary;
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
  // 1) 先问当前标签页 content script（实时累积，不用等存储）
  const cs = await sendToContent({ type: 'GET_STATE' });
  contentAlive = !!(cs && cs.ok);
  contentDebug = cs && cs.state ? cs.state.debug || null : null;
  if (cs && cs.ok && cs.state && cs.state.cues && cs.state.cues.length > 0) {
    // content 有内容，交给 background 处理成单词表并返回记录
    const rec = await send({
      type: 'CAPTIONS',
      videoId: cs.state.videoId,
      title: cs.state.title,
      language: 'en',
      cues: cs.state.cues,
      source: 'immersive-translate',
    });
    if (rec && rec.ok && rec.record) {
      currentRecord = rec.record;
      lastStatus = null;
      render();
      return;
    }
    if (!rec.ok) {
      uiError = rec.error;
      lastStatus = { type: 'error', error: rec.error };
      render();
      return;
    }
  }

  // 2) 否则读最近一次视频的存储记录
  const resp = await send({ type: 'GET_LAST_VIDEO' });
  if (resp && resp.ok && resp.record) {
    currentRecord = resp.record;
    updateFamiliar(resp);
    lastStatus = null;
    render();
    return;
  }
  if (!resp.ok) {
    uiError = resp.error;
    lastStatus = { type: 'error', error: resp.error };
    render();
    return;
  }

  // 3) 没有视频记录，查状态（无字幕/错误）
  const st = await send({ type: 'GET_STATUS' });
  lastStatus = st.ok ? st.status : { type: 'error', error: st.error };
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

function vocabularyTags(categories) {
  return '<span class="vocabulary-tags">' + (categories || [])
    .filter((category) => Object.hasOwn(VOCABULARY_LABELS, category))
    .map((category) => `<span class="vocabulary-tag ${category}"${category === 'ielts' ? ' title="社区 TOEFL/IELTS 共用学术词表，非官方"' : ''}>${VOCABULARY_LABELS[category]}</span>`)
    .join('') + '</span>';
}

function renderVocabularyStatus() {
  const status = document.getElementById('vocabularyStatus');
  status.textContent = uiError || (selectedVocabulary === 'ielts'
    ? '社区学术词表，含 TOEFL 词汇，非官方'
    : '每次选择一个词库，词卡显示全部命中标签');
  status.classList.toggle('error', !!uiError);
}

// 渲染当前 tab
function render() {
  renderVocabularyStatus();
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

  const words = selectedWords(currentRecord.words);
  const slashedSet = new Set(familiarWords);
  const kw = searchKeyword.trim().toLowerCase();

  // 过滤
  let shown = words.filter((w) => {
    if (kw) {
      return w.word.toLowerCase().includes(kw) || (w.meaning || '').toLowerCase().includes(kw);
    }
    return true;
  });

  const slashedCount = words.filter((w) => slashedSet.has(w.word)).length;
  const activeCount = words.filter((w) => !slashedSet.has(w.word)).length;

  // 顶部统计
  let statsHtml = `
    <div class="stats">
      <div class="stat"><b>${words.length}</b>${VOCABULARY_LABELS[selectedVocabulary]}词</div>
      <div class="stat"><b>${activeCount}</b>待记</div>
      <div class="stat"><b>${slashedCount}</b>已斩</div>
    </div>`;

  if (currentRecord.isLegacyVocabulary && selectedVocabulary !== 'cet4') {
    statsHtml += '<p class="legacy-note">旧记录只采集过四级词，重新抓取可补全新词库。</p>';
  }

  if (words.length === 0) {
    container.innerHTML = statsHtml + '<div class="empty"><div class="icon">🔍</div>本视频字幕里没有匹配到待学习的' + VOCABULARY_LABELS[selectedVocabulary] + '词汇<br/><span class="muted">基础词已自动隐藏；可切换词库查看其他命中</span></div>';
    return;
  }

  if (shown.length === 0) {
    container.innerHTML = statsHtml + '<div class="empty"><div class="icon">🔍</div>没有匹配「' + escapeHtml(searchKeyword) + '」的单词</div>';
    return;
  }

  let cardsHtml = '';
  for (const w of shown) {
    const isSlashed = slashedSet.has(w.word);
    const timesHtml = (w.times || []).slice(0, 10)
      .map((t) => `<span class="time-tag">${escapeHtml(t)}</span>`)
      .join('');
    const lemmaHint = w.lemma && w.lemma !== w.word
      ? `<span class="word-hint">→ ${escapeHtml(w.lemma)}</span>`
      : '';
    cardsHtml += `
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

  container.innerHTML = statsHtml + cardsHtml;

  // 点击单词（非斩词按钮）→ 弹出详情
  container.querySelectorAll('.word-clickable').forEach((el) => {
    el.addEventListener('click', async (e) => {
      const word = el.getAttribute('data-word');
      openDetail(word);
    });
  });

  // 绑定斩词按钮
  container.querySelectorAll('.slash-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const word = btn.getAttribute('data-word');
      const resp = await send({ type: familiarWords.includes(word) ? 'UNSLASH_WORD' : 'SLASH_WORD', word: word });
      updateFamiliar(resp);
      render();
    });
  });
}

// 渲染已斩词列表
function renderFamiliar() {
  const container = document.getElementById('familiarContent');
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
  const container = document.getElementById('historyContent');
  const resp = await send({ type: 'GET_ALL_VIDEOS' });
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
    html += `
      <div class="video-item" data-video="${escapeHtml(v.videoId)}">
        <div class="v-title">${escapeHtml(v.title || v.videoId)}</div>
        <div class="v-meta">${selectedWords(v.words).length} 个${VOCABULARY_LABELS[selectedVocabulary]}词 · ${date}</div>
        ${v.isLegacyVocabulary && selectedVocabulary !== 'cet4' ? '<div class="v-meta">旧记录只含原四级采集结果</div>' : ''}
      </div>`;
  }
  container.innerHTML = html;

  container.querySelectorAll('.video-item').forEach((el) => {
    el.addEventListener('click', async () => {
      const videoId = el.getAttribute('data-video');
      const r = await send({ type: 'GET_VIDEO', videoId: videoId });
      if (r.ok && r.record) {
        currentRecord = r.record;
        updateFamiliar(r);
        switchTab('current');
        render();
      } else if (!r.ok) {
        uiError = r.error;
        renderVocabularyStatus();
      }
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
document.getElementById('vocabularySelect').addEventListener('change', async (e) => {
  const picker = e.target;
  picker.disabled = true;
  const resp = await send({ type: 'SET_VOCABULARY', selectedVocabulary: picker.value });
  picker.disabled = false;
  if (resp.ok) {
    selectedVocabulary = resp.selectedVocabulary;
    uiError = '';
  } else {
    picker.value = selectedVocabulary;
    uiError = resp.error;
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
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id) {
    chrome.tabs.sendMessage(tab.id, { type: 'RECAPTURE' }, () => {
      void chrome.runtime.lastError; // content script 可能未加载
    });
  }
  setTimeout(async () => {
    await init();
  }, 1500);
});

document.getElementById('clearFamiliarBtn').addEventListener('click', async () => {
  if (!confirm('确定清空所有已斩单词吗？')) return;
  const resp = await send({ type: 'CLEAR_FAMILIAR' });
  updateFamiliar(resp);
  render();
});

// ============ 单词详情弹窗 ============
// 两阶段渲染：本地数据（原型/精简释义/单词变形/同根词）先秒出，联网释义后补
let detailRequest = 0;
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

// 启动
init();
