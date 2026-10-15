// content.js —— 双通道抓字幕：
//  主通道：只读监听「沉浸式翻译」渲染的双语字幕 DOM，实时累积英文 + 播放时间戳
//  备用通道：YouTube 原生字幕轨抓取（沉浸式翻译未开启时兜底）
// 原则：纯观察，不 hook 任何 API、不改任何 DOM，不影响沉浸式翻译和正常观看。
(function () {
  'use strict';

  // 当前已处理的视频 id
  let lastVideoId = null;

  // ============ 主通道：沉浸式翻译字幕监听 ============
  // 沉浸式翻译的字幕容器 id（YouTube 及多数平台）
  const CAPTION_SELECTOR = '#immersive-translate-caption-window';
  let captionObserver = null;
  let seenSentences = new Map(); // sentence -> 首次时间戳(秒)
  let currentText = '';          // 当前容器里显示的文字（用于判断是否变化）

  function getVideo() {
    return document.querySelector('video');
  }

  function getVideoId() {
    // 1) YouTube: 用 ?v= 参数
    try {
      const v = new URLSearchParams(location.search).get('v');
      if (v) return v;
    } catch (e) {}
    // 2) 其他网站：用 域名 + 路径 哈希作为标识（同一视频页面 url 不变，id 就不变）
    try {
      const base = location.host + location.pathname;
      let h = 0;
      for (let i = 0; i < base.length; i++) {
        h = (h * 31 + base.charCodeAt(i)) >>> 0;
      }
      return 'p' + h.toString(36);
    } catch (e) {
      return null;
    }
  }

  function getVideoTitle() {
    const el = document.querySelector(
      'h1.title.style-scope.ytd-video-primary-info-renderer, h1.ytd-watch-metadata'
    );
    return el ? el.textContent.trim() : document.title;
  }

  // 沉浸式翻译把字幕渲染在「宿主元素 + open Shadow DOM」里，
  // 宿主是 #immersive-translate-caption-window，字幕内容在 shadowRoot 内部，
  // 英文原文在 .source-cue，中文译文在 .target-cue（greasyfork 社区脚本佐证）。
  function getCaptionRoot() {
    const host = document.querySelector(CAPTION_SELECTOR);
    if (!host) return null;
    return host.shadowRoot || host; // open shadow root 就能拿到，closed 才退化为宿主
  }

  // 从字幕根（shadowRoot 或宿主）里提取「英文原文」文本
  function extractEnglishFromRoot(root) {
    if (!root) return '';
    // 1) 优先：.source-cue（英文原文行）
    let cues = root.querySelectorAll('.source-cue');
    if (cues && cues.length > 0) {
      return Array.from(cues).map((c) => c.textContent || '').join(' ').trim();
    }
    // 2) 兜底：找 class 里带 source 的元素
    cues = root.querySelectorAll('[class*="source"]');
    if (cues && cues.length > 0) {
      const t = Array.from(cues).map((c) => c.textContent || '').join(' ').trim();
      if ((t.match(/[a-zA-Z]/g) || []).length > 0) return t;
    }
    // 3) 再兜底：整个根的 textContent，按行取含英文字母最多的行
    const text = root.textContent || '';
    const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    if (lines.length > 1) {
      let best = '';
      let bestScore = -1;
      for (const line of lines) {
        const letters = (line.match(/[a-zA-Z]/g) || []).length;
        if (letters > bestScore) {
          bestScore = letters;
          best = line;
        }
      }
      if (best && bestScore > 0) return best;
    }
    return text.trim();
  }

  function onCaptionChanged() {
    const root = getCaptionRoot();
    if (!root) return;
    const text = extractEnglishFromRoot(root);
    if (!text || text === currentText) return;
    currentText = text;

    const video = getVideo();
    const t = video && video.currentTime != null ? video.currentTime : 0;

    if (!seenSentences.has(text)) {
      seenSentences.set(text, t);
    }
    flushCaptions();
  }

  function flushCaptions() {
    const videoId = getVideoId();
    if (!videoId) return;
    const cues = [];
    for (const [text, start] of seenSentences) {
      cues.push({ start: start, text: text });
    }
    if (cues.length === 0) return;
    chrome.runtime.sendMessage({
      type: 'CAPTIONS',
      videoId: videoId,
      title: getVideoTitle(),
      language: 'en',
      cues: cues,
      source: 'immersive-translate',
    });
  }

  // 供 popup 查询"现在累积了多少"
  function getCurrentState() {
    const cues = [];
    for (const [text, start] of seenSentences) {
      cues.push({ start: start, text: text });
    }
    // 诊断信息：排查"收不到字幕"用
    const host = document.querySelector(CAPTION_SELECTOR);
    const root = getCaptionRoot();
    let debug = {
      hostFound: !!host,
      hasShadowRoot: !!(host && host.shadowRoot),
      sourceCueCount: root ? root.querySelectorAll('.source-cue').length : 0,
      targetCueCount: root ? root.querySelectorAll('.target-cue').length : 0,
      rootTextSample: root ? (root.textContent || '').slice(0, 80) : '',
    };
    return {
      videoId: getVideoId(),
      title: getVideoTitle(),
      sentenceCount: seenSentences.size,
      cues: cues,
      debug: debug,
    };
  }

  function startCaptionObserver() {
    if (captionObserver) return;
    // 先观察已存在的容器（观察目标是 shadowRoot，字幕变化在里面）
    const tryObserve = () => {
      const root = getCaptionRoot();
      if (root && !captionObserver) {
        captionObserver = new MutationObserver(onCaptionChanged);
        captionObserver.observe(root, {
          childList: true,
          subtree: true,
          characterData: true,
        });
        onCaptionChanged(); // 立即读一次当前字幕
      }
    };
    tryObserve();
    // 容器/shadowRoot 可能是视频播放后才创建的，用间隔兜底找
    const findTimer = setInterval(() => {
      tryObserve();
      if (captionObserver) clearInterval(findTimer);
    }, 1000);
    setTimeout(() => clearInterval(findTimer), 60000);
  }

  // 视频切换时清空累积
  function resetState() {
    seenSentences = new Map();
    currentText = '';
  }

  // ============ 备用通道：YouTube 原生字幕 ============
  function getPlayerResponse() {
    if (window.ytInitialPlayerResponse) return window.ytInitialPlayerResponse;
    if (window.ytplayer && window.ytplayer.config && window.ytplayer.config.args) {
      try {
        return JSON.parse(window.ytplayer.config.args.player_response);
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  function getCaptionTracks(pr) {
    try {
      return pr.captions.playerCaptionsTracklistRenderer.captionTracks || [];
    } catch (e) {
      return [];
    }
  }

  async function fetchCaptions(track) {
    let url = track.baseUrl;
    url += (url.indexOf('?') === -1 ? '?' : '&') + 'fmt=json3';
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('字幕请求失败 ' + resp.status);
    const data = await resp.json();
    return parseJson3(data);
  }

  function parseJson3(data) {
    const cues = [];
    const events = data.events || [];
    for (const ev of events) {
      if (ev.segs && ev.tStartMs != null) {
        const text = ev.segs.map((s) => s.utf8 || '').join(' ').trim();
        if (text) cues.push({ start: ev.tStartMs / 1000, text: text });
      }
    }
    return cues;
  }

  function pickTrack(tracks) {
    if (!tracks || tracks.length === 0) return null;
    return (
      tracks.find((t) => t.languageCode === 'en' && !t.kind) ||
      tracks.find((t) => t.languageCode === 'en') ||
      tracks.find((t) => (t.languageCode || '').startsWith('en')) ||
      tracks[0]
    );
  }

  // 备用通道：沉浸式翻译没抓到任何东西时，尝试原生字幕
  async function fallbackNativeCaptions() {
    const videoId = getVideoId();
    if (!videoId || videoId === lastVideoId) return;
    try {
      let pr = getPlayerResponse();
      let waited = 0;
      while (!pr && waited < 8000) {
        await new Promise((r) => setTimeout(r, 500));
        waited += 500;
        pr = getPlayerResponse();
      }
      if (!pr) return;
      const tracks = getCaptionTracks(pr);
      if (tracks.length === 0) return;
      const track = pickTrack(tracks);
      if (!track) return;
      const cues = await fetchCaptions(track);
      if (cues.length > 0) {
        lastVideoId = videoId;
        chrome.runtime.sendMessage({
          type: 'CAPTIONS',
          videoId: videoId,
          title: getVideoTitle(),
          language: track.languageCode || 'unknown',
          cues: cues,
          source: 'youtube-native',
        });
      }
    } catch (e) {
      console.warn('[YT-CET4] 原生字幕兜底失败:', e);
    }
  }

  // ============ 导航监听 ============
  function watchNavigation() {
    let lastUrl = location.href;
    const check = () => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        resetState();
        lastVideoId = null;
        // 新视频：重置字幕观察（容器会重建）
        if (captionObserver) {
          captionObserver.disconnect();
          captionObserver = null;
        }
        setTimeout(() => {
          startCaptionObserver();
          // 兜底：沉浸式翻译 3 秒内没产出就试原生
          setTimeout(() => {
            if (seenSentences.size === 0) fallbackNativeCaptions();
          }, 3000);
        }, 800);
      }
    };

    new MutationObserver(check).observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
    });
    window.addEventListener('popstate', check);
    window.addEventListener('yt-navigate-finish', () => {
      resetState();
      lastVideoId = null;
      if (captionObserver) {
        captionObserver.disconnect();
        captionObserver = null;
      }
      setTimeout(() => {
        startCaptionObserver();
        setTimeout(() => {
          if (seenSentences.size === 0) fallbackNativeCaptions();
        }, 3000);
      }, 800);
    });
  }

  function boot() {
    watchNavigation();
    startCaptionObserver();
    // 初始兜底
    setTimeout(() => {
      if (seenSentences.size === 0) fallbackNativeCaptions();
    }, 3000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // 响应 popup 的消息
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'RECAPTURE') {
      resetState();
      lastVideoId = null;
      if (captionObserver) {
        captionObserver.disconnect();
        captionObserver = null;
      }
      startCaptionObserver();
      setTimeout(() => {
        if (seenSentences.size === 0) fallbackNativeCaptions();
      }, 2000);
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === 'GET_STATE') {
      sendResponse({ ok: true, state: getCurrentState() });
      return true;
    }
    // 点击弹窗里的时间点 → 把视频跳到那个位置
    // 只改播放位置，不动播放/暂停状态（原本在播就继续播，原本暂停就停在那一帧）
    if (msg.type === 'SEEK_TO') {
      const v = getVideo();
      const t = Number(msg.time);
      if (v && Number.isFinite(t) && t >= 0) {
        try {
          v.currentTime = t;
          sendResponse({ ok: true, currentTime: v.currentTime });
        } catch (err) {
          sendResponse({ ok: false, error: String(err) });
        }
      } else {
        sendResponse({ ok: false, error: 'no-video' });
      }
      return true;
    }
  });
})();
