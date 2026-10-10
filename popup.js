// popup.js —— 结果页逻辑

'use strict';

let currentRecord = null;
let familiarWords = [];
let currentTab = 'current';
let searchKeyword = '';

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

// 初始化：优先问当前标签页的 content 有没有已累积的内容，否则读历史存储
let lastStatus = null;
let contentAlive = null; // null=未知, true=content 响应了, false=没注入
let contentDebug = null; // content 返回的诊断信息
async function init() {
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
      const fam = await send({ type: 'GET_FAMILIAR' });
      familiarWords = fam.familiar || [];
      lastStatus = null;
      render();
      return;
    }
  }

  // 2) 否则读最近一次视频的存储记录
  const resp = await send({ type: 'GET_LAST_VIDEO' });
  if (resp && resp.ok && resp.record) {
    currentRecord = resp.record;
    familiarWords = resp.familiar || [];
    lastStatus = null;
    render();
    return;
  }

  // 3) 没有视频记录，查状态（无字幕/错误）
  const st = await send({ type: 'GET_STATUS' });
  if (st && st.ok && st.status) {
    lastStatus = st.status;
  }
  render();
}

// 渲染当前 tab
function render() {
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

  const words = currentRecord.words || [];
  const slashedSet = new Set(familiarWords);
  const kw = searchKeyword.trim().toLowerCase();

  // 过滤
  let shown = words.filter((w) => {
    if (kw) {
      return w.word.toLowerCase().includes(kw) || (w.meaning || '').toLowerCase().includes(kw);
    }
    return true;
  });

  const shownCount = shown.length;
  const slashedCount = words.filter((w) => slashedSet.has(w.word)).length;
  const activeCount = words.filter((w) => !slashedSet.has(w.word)).length;

  // 顶部统计
  let statsHtml = `
    <div class="stats">
      <div class="stat"><b>${words.length}</b>四级词</div>
      <div class="stat"><b>${activeCount}</b>待记</div>
      <div class="stat"><b>${slashedCount}</b>已斩</div>
    </div>`;

  if (words.length === 0) {
    container.innerHTML = statsHtml + '<div class="empty"><div class="icon">🔍</div>本视频字幕里没有匹配到四级词汇</div>';
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
      .map((t) => `<span class="time-tag">${t}</span>`)
      .join('');
    const lemmaHint = w.lemma && w.lemma !== w.word
      ? `<span class="word-hint">→ ${escapeHtml(w.lemma)}</span>`
      : '';
    cardsHtml += `
      <div class="word-card ${isSlashed ? 'slashed' : ''}" data-word="${escapeHtml(w.word)}">
        <div class="word-head">
          <div class="word-left word-clickable" data-word="${escapeHtml(w.word)}">
            <div class="word-text">${escapeHtml(w.word)}${lemmaHint}</div>
            <div class="word-meaning">${escapeHtml(w.meaning || '')}</div>
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
      if (familiarWords.includes(word)) {
        await send({ type: 'UNSLASH_WORD', word: word });
      } else {
        await send({ type: 'SLASH_WORD', word: word });
      }
      const resp = await send({ type: 'GET_FAMILIAR' });
      familiarWords = resp.familiar || [];
      render();
    });
  });
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
  let html = '';
  for (const v of videos) {
    const date = new Date(v.capturedAt).toLocaleString('zh-CN', { hour12: false });
    html += `
      <div class="video-item" data-video="${v.videoId}">
        <div class="v-title">${escapeHtml(v.title || v.videoId)}</div>
        <div class="v-meta">${v.totalWords} 个四级词 · ${date}</div>
      </div>`;
  }
  container.innerHTML = html;

  container.querySelectorAll('.video-item').forEach((el) => {
    el.addEventListener('click', async () => {
      const videoId = el.getAttribute('data-video');
      const r = await send({ type: 'GET_VIDEO', videoId: videoId });
      if (r.ok && r.record) {
        currentRecord = r.record;
        familiarWords = r.familiar || [];
        switchTab('current');
        render();
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
  render();
});

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

// 启动
init();
