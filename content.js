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
  let sentSentences = new Set(); // 已经成功发给后台的句子（按文本）—— 增量发送的关键
  let currentText = '';          // 当前容器里显示的文字（用于判断是否变化）

  // ============ 采集状态上报 ============
  // 目的：抓不到词时让用户知道卡在哪一步（找不到容器 / 等待字幕 / 正在收集 / 读不到）。
  // 用「状态 + 每 10 句一个桶」去重，避免每来一句字幕就多发一条消息。
  let lastStatusKey = '';
  let savedOnce = false;         // 至少成功落盘过一次
  let lastRoundTripMs = null;    // 最近一次「字幕变化 → 后台确认」的往返耗时

  function reportStatus(status, detail) {
    const videoId = getVideoId();
    const cueCount = seenSentences.size;
    const key = [videoId, status, detail || '', Math.floor(cueCount / 10), savedOnce].join('|');
    if (key === lastStatusKey) return;
    lastStatusKey = key;
    try {
      chrome.runtime.sendMessage(
        {
          type: 'CAPTURE_STATUS',
          videoId: videoId,
          title: getVideoTitle(),
          status: status,
          detail: detail || '',
          cueCount: cueCount,
          saved: savedOnce,
          roundTripMs: lastRoundTripMs,
          at: Date.now(),
        },
        () => {
          // 后台可能还没醒，忽略；下一次字幕变化会再报
          if (chrome.runtime.lastError) { /* noop */ }
        }
      );
    } catch (e) {
      /* noop */
    }
  }

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
      reportStatus('collecting', '沉浸式翻译的双语字幕');
    }
    flushCaptions();
  }

  function flushCaptions() {
    const videoId = getVideoId();
    if (!videoId) return;
    // 增量：只发还没发过的新句子，后台做幂等合并。
    // 不用像旧版那样每次把全部累计字幕重发一遍。
    const delta = [];
    for (const [text, start] of seenSentences) {
      if (!sentSentences.has(text)) delta.push({ start: start, text: text });
    }
    if (delta.length === 0) return;
    const t0 = performance.now();
    chrome.runtime.sendMessage(
      {
        type: 'CAPTIONS_DELTA',
        videoId: videoId,
        title: getVideoTitle(),
        language: 'en',
        cues: delta,
        source: 'immersive-translate',
      },
      (resp) => {
        if (chrome.runtime.lastError) {
          reportStatus('error', '后台没响应（扩展可能需要重新加载）');
          return;
        }
        if (resp && resp.ok) {
          // 后台确认收到才标记已发送；失败的话下次字幕变化会重发
          for (const c of delta) sentSentences.add(c.text);
          savedOnce = true;
          lastRoundTripMs = Math.round(performance.now() - t0);
          reportStatus('collecting', '沉浸式翻译的双语字幕');
        }
      }
    );
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
    reportStatus('connecting', '正在查找沉浸式翻译的字幕容器');
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
        reportStatus('waiting', '字幕容器已连接，等待第一句字幕');
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
    sentSentences = new Set(); // 换视频了，新视频的句子要重新发
    currentText = '';
    savedOnce = false;
    lastRoundTripMs = null;
    lastStatusKey = ''; // 换视频了，状态要能重新发一遍
  }

  // ============ 备用通道：YouTube 原生字幕 ============
  // ⚠️ 这里踩过一个真实的坑：content script 跑在「隔离世界」，window 是扩展自己的全局对象，
  // **读不到页面 JS 定义的 window.ytInitialPlayerResponse**。
  // 以前直接读它，结果恒为 undefined —— 这条兜底通道从来没成功过一次，
  // 但 README 一直写着"未开启时自动回退到 YouTube 原生字幕"。
  //
  // 现在改成两步：
  //   1) 问 youtube-bridge.js（manifest 里注册的 MAIN world 脚本）要轨道元数据
  //   2) 把轨道地址交给 background 下载（service worker 有 host 权限，不受页面 CORS 约束）
  const BRIDGE_CHANNEL = 'naiwa-yt-bridge-v1';
  let bridgeSeq = 0;

  function requestYoutubeTracks(timeoutMs) {
    return new Promise((resolve) => {
      if (!/(^|\.)youtube\.com$/i.test(location.hostname)) return resolve([]);
      let settled = false;
      const requestId = 'r' + Date.now().toString(36) + '-' + ++bridgeSeq;
      const finish = (tracks) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        resolve(tracks || []);
      };
      const onMessage = (event) => {
        if (event.source !== window || event.origin !== location.origin) return;
        const d = event.data;
        if (!d || d.channel !== BRIDGE_CHANNEL || d.type !== 'TRACKS' || d.requestId !== requestId) return;
        finish(Array.isArray(d.tracks) ? d.tracks : []);
      };
      const timer = setTimeout(() => finish([]), timeoutMs || 2500);
      window.addEventListener('message', onMessage);
      try {
        window.postMessage({ channel: BRIDGE_CHANNEL, type: 'GET_TRACKS', requestId: requestId }, location.origin);
      } catch (e) {
        finish([]);
      }
    });
  }

  function fetchYoutubeCues(track, videoId) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'FETCH_YOUTUBE_CAPTIONS', trackUrl: track.baseUrl, expectedVideoId: videoId },
        (resp) => {
          if (chrome.runtime.lastError || !resp || !resp.ok) return resolve(null);
          resolve(resp.cues || null);
        }
      );
    });
  }

  function pickTrack(tracks) {
    if (!tracks || tracks.length === 0) return null;
    return (
      tracks.find((t) => t.languageCode === 'en' && !t.kind) ||
      tracks.find((t) => t.languageCode === 'en') ||
      tracks.find((t) => (t.languageCode || '').startsWith('en')) ||
      tracks.find((t) => (t.label || '').toLowerCase().indexOf('english') >= 0) ||
      // 不再退到 tracks[0]：拿到一轨西班牙语字幕对四级词表没有意义，白下载一次
      null
    );
  }

  // 备用通道：沉浸式翻译没抓到任何东西时，尝试原生字幕。
  // 页面变量可能比 document_start 晚一拍才有，所以最多试两轮。
  async function fallbackNativeCaptions() {
    const videoId = getVideoId();
    if (!videoId || videoId === lastVideoId) return;
    try {
      let track = null;
      for (let attempt = 0; attempt < 2 && !track; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
        const tracks = await requestYoutubeTracks(2500);
        track = pickTrack(tracks);
      }
      if (!track) {
        reportStatus('no_captions', '这个 YouTube 页面里没有可读的英文字幕轨');
        return;
      }
      const cues = await fetchYoutubeCues(track, videoId);
      if (!cues || cues.length === 0) {
        reportStatus('no_captions', '拿到了字幕轨地址，但没有解析出文本');
        return;
      }
      lastVideoId = videoId;
      const t0 = performance.now();
      chrome.runtime.sendMessage(
        {
          type: 'CAPTIONS',
          videoId: videoId,
          title: getVideoTitle(),
          language: track.languageCode || 'unknown',
          cues: cues,
          source: 'youtube-native',
        },
        (resp) => {
          if (chrome.runtime.lastError) return;
          if (resp && resp.ok) {
            savedOnce = true;
            lastRoundTripMs = Math.round(performance.now() - t0);
            reportStatus('collecting', 'YouTube 原生字幕轨（' + (track.languageCode || 'en') + '）');
          }
        }
      );
    } catch (e) {
      console.warn('[YT-CET4] 原生字幕兜底失败:', e);
      reportStatus('error', '原生字幕兜底失败：' + ((e && e.message) || e));
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
