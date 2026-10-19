// content.js: observe readable subtitle text, send only new cue events, and
// retain every event until the background confirms a successful local save.
(function () {
  'use strict';

  const CAPTION_SELECTOR = '#immersive-translate-caption-window';
  const BRIDGE_CHANNEL = 'naiwa-youtube-caption-bridge-v1';
  const MAX_PENDING_EVENTS = 5000;
  const MAX_PENDING_BYTES = 4 * 1024 * 1024;
  const SEND_BATCH_SIZE = 40;
  const MAX_SEND_RETRIES = 8;
  const SEEN_CUE_LIMIT = 1200;
  const CAPTION_SETTLE_MS = 50;
  const MAX_TRACK_ATTEMPTS = 3;

  function createId() {
    if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID().replace(/-/g, '');
    return Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }

  function epochNow() {
    return performance.timeOrigin + performance.now();
  }

  let sessionId = createId();
  let recordId = null;
  let identityConfirmed = false;
  let title = document.title || '';
  let lastUrl = location.href;
  let lastMediaSource = '';
  let currentVideo = null;
  let captureStatus = 'connecting';
  let statusDetail = '';
  let captionRoot = null;
  let captionObserver = null;
  let documentObserver = null;
  let captionReadTimer = null;
  let healthTimer = null;
  let reconnectTimer = null;
  let pendingFlushTimer = null;
  let pendingEvents = new Map();
  let pendingBytes = 0;
  let eventSequence = 0;
  let cueKeys = new Set();
  let cueKeyOrder = [];
  let trackList = null;
  let trackListListener = null;
  let trackListeners = new Map();
  let trackRequestId = 0;
  let trackRequestAt = 0;
  let trackAttempts = 0;
  let nativeTrackImportedFor = '';
  let receivingPaused = false;
  let lastHealthAt = 0;
  let lastStatusSignature = '';
  let statusSequence = 0;
  let lastRoundTripMs = null;

  function randomRecordId() {
    return 'session_' + createId();
  }

  function getYouTubeVideoId() {
    if (!/(^|\.)youtube\.com$/.test(location.hostname) && location.hostname !== 'youtu.be') return null;
    try {
      const url = new URL(location.href);
      const fromQuery = url.searchParams.get('v');
      if (fromQuery && /^[a-zA-Z0-9_-]{6,20}$/.test(fromQuery)) return fromQuery;
      const path = url.pathname.match(/^\/(?:shorts|embed|live)\/([a-zA-Z0-9_-]{6,20})/);
      if (path) return path[1];
      const short = url.pathname.match(/^\/([a-zA-Z0-9_-]{6,20})$/);
      return short ? short[1] : null;
    } catch (_) {
      return null;
    }
  }

  function getVideoTitle() {
    const el = document.querySelector('h1.title.style-scope.ytd-video-primary-info-renderer, h1.ytd-watch-metadata');
    const value = el && el.textContent ? el.textContent.trim() : (document.title || '');
    return value.slice(0, 500);
  }

  function getVideo() {
    return document.querySelector('video');
  }

  function activeMediaSource(video) {
    if (!video) return '';
    return String(video.currentSrc || video.src || '').slice(0, 1500);
  }

  function setIdentity(forceNewSession, reason) {
    const youtubeId = getYouTubeVideoId();
    const nextConfirmed = !!youtubeId;
    const nextId = youtubeId || (recordId && !identityConfirmed && !forceNewSession ? recordId : randomRecordId());
    const changed = nextId !== recordId || nextConfirmed !== identityConfirmed;
    if (!changed && !forceNewSession) return false;
    if (forceNewSession || changed) {
      sessionId = createId();
      if (!youtubeId) recordId = nextId;
      else recordId = youtubeId;
      identityConfirmed = nextConfirmed;
      cueKeys = new Set();
      cueKeyOrder = [];
      nativeTrackImportedFor = '';
      trackAttempts = 0;
      statusDetail = reason || '';
      captureStatus = 'connecting';
      if (identityConfirmed) {
        chrome.runtime.sendMessage({ type: 'RETRY_SAVE', recordId }, () => void chrome.runtime.lastError);
      }
      reportStatus('connecting', reason || (identityConfirmed ? '已确认 YouTube 视频' : '视频身份无法确认，已为本次连接单独记录'));
      return true;
    }
    return false;
  }

  function ensureIdentity() {
    if (!recordId) setIdentity(false, '');
    return recordId;
  }

  function reportStatus(status, detail, source) {
    captureStatus = status;
    statusDetail = String(detail || '').slice(0, 300);
    const signature = [status, statusDetail, source || ''].join('|');
    if (signature === lastStatusSignature) return;
    lastStatusSignature = signature;
    statusSequence += 1;
    chrome.runtime.sendMessage({
      type: 'CAPTURE_STATUS',
      recordId: ensureIdentity(),
      videoId: recordId,
      sessionId: sessionId,
      statusSequence,
      title: getVideoTitle(),
      identityConfirmed,
      status: status,
      source: source || '',
      detail: statusDetail,
      cueCount: eventSequence,
      saved: status === 'saved',
      roundTripMs: lastRoundTripMs,
    }, () => void chrome.runtime.lastError);
  }

  function getCaptionHost() {
    return document.querySelector(CAPTION_SELECTOR);
  }

  function inspectCaptionRoot() {
    const host = getCaptionHost();
    if (!host) return { host: null, root: null, closedOrNotReady: false };
    if (host.shadowRoot) return { host, root: host.shadowRoot, closedOrNotReady: false };
    return { host, root: null, closedOrNotReady: true };
  }

  function extractEnglishFromRoot(root) {
    if (!root || !root.querySelectorAll) return '';
    let cues = root.querySelectorAll('.source-cue');
    if (cues && cues.length) return Array.from(cues).map((cue) => cue.textContent || '').join(' ').trim();
    cues = root.querySelectorAll('[class*="source"]');
    if (cues && cues.length) {
      const value = Array.from(cues).map((cue) => cue.textContent || '').join(' ').trim();
      if ((value.match(/[a-z]/gi) || []).length) return value;
    }
    const lines = String(root.textContent || '').split(/\n+/).map((line) => line.trim()).filter(Boolean);
    let best = '';
    let score = 0;
    for (const line of lines) {
      const count = (line.match(/[a-z]/gi) || []).length;
      if (count > score) { score = count; best = line; }
    }
    return best || '';
  }

  function rememberCueKey(key) {
    if (cueKeys.has(key)) return false;
    cueKeys.add(key);
    cueKeyOrder.push(key);
    if (cueKeyOrder.length > SEEN_CUE_LIMIT) cueKeys.delete(cueKeyOrder.shift());
    return true;
  }

  function addCue(text, start, source, exactStart) {
    if (receivingPaused) return false;
    const cleanText = String(text || '').replace(/\s+/g, ' ').trim();
    const seconds = Number(start);
    if (!cleanText || !Number.isFinite(seconds) || seconds < 0) return false;
    ensureIdentity();
    const timeKey = exactStart ? Math.round(seconds * 10) / 10 : Math.floor(seconds);
    const dedupeTime = Math.round(timeKey * 10);
    const cueKey = source + '|' + dedupeTime + '|' + cleanText.toLocaleLowerCase();
    if (!rememberCueKey(cueKey)) return false;
    const eventId = sessionId + '_' + (++eventSequence).toString(36);
    const event = {
      eventId,
      recordId,
      sessionId,
      title: getVideoTitle(),
      identityConfirmed,
      source,
      cue: { text: cleanText, start: timeKey, capturedAtEpoch: epochNow() },
    };
    const bytes = JSON.stringify(event).length * 2;
    if (pendingEvents.size >= MAX_PENDING_EVENTS || pendingBytes + bytes > MAX_PENDING_BYTES) {
      receivingPaused = true;
      reportStatus('save_failed', '本地保存确认未到达，待确认缓存已满；采集已暂停，页面仍保留未确认数据。', source);
      return false;
    }
    pendingEvents.set(eventId, { event, bytes, accepted: false, inFlight: false, retries: 0, retryAt: 0 });
    pendingBytes += bytes;
    reportStatus('collecting', '已读取字幕，正在本地合并保存', source);
    scheduleFlush();
    return true;
  }

  function scheduleFlush(delay) {
    if (pendingFlushTimer || pendingEvents.size === 0) return;
    pendingFlushTimer = setTimeout(() => {
      pendingFlushTimer = null;
      flushPending();
    }, delay == null ? CAPTION_SETTLE_MS : delay);
  }

  function flushPending() {
    if (!pendingEvents.size) return;
    const now = Date.now();
    const ready = Array.from(pendingEvents.values()).filter((item) => !item.inFlight && item.retryAt <= now);
    if (!ready.length) {
      const waiting = Array.from(pendingEvents.values()).filter((item) => !item.inFlight && Number.isFinite(item.retryAt));
      const retryAt = waiting.length ? Math.min(...waiting.map((item) => item.retryAt || now + 250)) : Infinity;
      if (Number.isFinite(retryAt)) scheduleFlush(Math.max(100, retryAt - now));
      return;
    }
    const first = ready[0].event;
    const sameSession = ready.filter((item) => item.event.recordId === first.recordId &&
      item.event.sessionId === first.sessionId && item.event.source === first.source).slice(0, SEND_BATCH_SIZE);
    for (const item of sameSession) item.inFlight = true;
    chrome.runtime.sendMessage({
      type: 'CAPTIONS_DELTA',
      recordId: first.recordId,
      videoId: first.recordId,
      sessionId: first.sessionId,
      identityConfirmed: first.identityConfirmed,
      title: first.title,
      source: first.source,
      events: sameSession.map((item) => item.event),
    }, (response) => {
      const error = chrome.runtime.lastError;
      const accepted = !error && response && response.ok;
      for (const item of sameSession) {
        item.inFlight = false;
        if (accepted) {
          item.accepted = true;
          item.ackRetries = (item.ackRetries || 0) + 1;
          if (item.ackRetries >= MAX_SEND_RETRIES) {
            item.retryAt = Infinity;
            receivingPaused = true;
            reportStatus('save_failed', '后台接受了字幕，但本地保存确认长期未到；采集已暂停，未确认输入仍保留。', item.event.source);
          } else {
            item.retryAt = Date.now() + 2500;
          }
        } else {
          item.retries += 1;
          if (item.retries >= MAX_SEND_RETRIES) {
            item.retryAt = Infinity;
            receivingPaused = true;
            reportStatus('save_failed', (response && response.error) || (error && error.message) || '后台无法确认字幕；输入仍保留，点击重新抓取后重试。', item.event.source);
          } else {
            item.retryAt = Date.now() + Math.min(30000, 500 * Math.pow(2, Math.min(item.retries - 1, 6)));
          }
          if (item.retries >= 3 && item.retries < MAX_SEND_RETRIES) {
            reportStatus('save_failed', (response && response.error) || (error && error.message) || '后台暂时不可用，输入仍保留并会继续重试。', item.event.source);
          }
        }
      }
      if (accepted) {
        const elapsed = epochNow() - Math.min(...sameSession.map((item) => item.event.cue.capturedAtEpoch));
        chrome.runtime.sendMessage({ type: 'PERF_SAMPLE', inputToBackgroundMs: elapsed }, () => void chrome.runtime.lastError);
      }
      scheduleFlush(accepted ? 50 : 500);
    });
  }

  function queueCaptionRead() {
    if (captionReadTimer) clearTimeout(captionReadTimer);
    captionReadTimer = setTimeout(() => {
      captionReadTimer = null;
      readCaptionNow();
    }, CAPTION_SETTLE_MS);
  }

  function readCaptionNow() {
    checkConnections();
    const result = inspectCaptionRoot();
    if (result.root !== captionRoot) bindCaptionRoot(result.root);
    if (!result.root) {
      if (result.host) reportStatus('waiting', '字幕宿主已出现，但内部 Shadow DOM 尚不可读。', 'immersive-translate');
      return;
    }
    const text = extractEnglishFromRoot(result.root);
    const video = getVideo();
    if (text && video) addCue(text, video.currentTime || 0, 'immersive-translate', false);
  }

  function bindCaptionRoot(root) {
    if (captionObserver) {
      captionObserver.disconnect();
      captionObserver = null;
    }
    captionRoot = root || null;
    if (captionRoot) {
      captionObserver = new MutationObserver(queueCaptionRead);
      captionObserver.observe(captionRoot, { childList: true, subtree: true, characterData: true });
      queueCaptionRead();
      reportStatus('waiting', '沉浸式字幕通道已连接，等待英文字幕。', 'immersive-translate');
    }
  }

  function isEnglishTrack(track) {
    const lang = String(track.language || track.label || '').toLowerCase();
    return /^en(?:[-_]|$)/.test(lang);
  }

  function textLooksEnglish(text) {
    const letters = String(text || '').match(/[a-z]/gi) || [];
    const all = String(text || '').match(/[\p{L}]/gu) || [];
    return letters.length >= 2 && letters.length / Math.max(1, all.length) >= 0.7;
  }

  function consumeTextTrack(track) {
    if (!track || track.mode === 'disabled') return;
    // cuechange 可能早于导航事件，先刷新身份再创建字幕事件。
    const youtubeId = getYouTubeVideoId();
    if (youtubeId && youtubeId !== recordId) setIdentity(false, '字幕轨检测到视频切换');
    else if (!youtubeId && location.href !== lastUrl) {
      lastUrl = location.href;
      setIdentity(true, '字幕轨检测到页面导航');
    }
    const cues = track.activeCues;
    if (!cues || !cues.length) return;
    for (const cue of Array.from(cues)) {
      const text = String(cue.text || '').replace(/<[^>]*>/g, ' ').trim();
      if ((!isEnglishTrack(track) && !textLooksEnglish(text)) || !text) continue;
      addCue(text, Number(cue.startTime), 'text-track', true);
    }
  }

  function refreshTextTrackListeners(video) {
    const list = video && video.textTracks;
    if (trackList !== list) {
      if (trackList && trackListListener) {
        trackList.removeEventListener('addtrack', trackListListener);
        trackList.removeEventListener('removetrack', trackListListener);
      }
      for (const [track, listener] of trackListeners) track.removeEventListener('cuechange', listener);
      trackList = list || null;
      trackListeners = new Map();
      trackListListener = null;
      if (trackList) {
        trackListListener = () => refreshTextTrackListeners(getVideo());
        trackList.addEventListener('addtrack', trackListListener);
        trackList.addEventListener('removetrack', trackListListener);
      }
    }
    if (!trackList) return;
    const currentTracks = new Set(Array.from(trackList));
    for (const [track, listener] of trackListeners) {
      if (!currentTracks.has(track)) {
        track.removeEventListener('cuechange', listener);
        trackListeners.delete(track);
      }
    }
    for (const track of currentTracks) {
      if (trackListeners.has(track)) continue;
      const listener = () => consumeTextTrack(track);
      track.addEventListener('cuechange', listener);
      trackListeners.set(track, listener);
      consumeTextTrack(track);
    }
  }

  function getBridgeTrackUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || !/(^|\.)youtube\.com$/.test(url.hostname)) return null;
      return url.href;
    } catch (_) { return null; }
  }

  function requestYouTubeTracks(force) {
    const expectedVideoId = getYouTubeVideoId();
    if (!expectedVideoId || nativeTrackImportedFor === expectedVideoId) return;
    const now = Date.now();
    if (!force && now - trackRequestAt < 8000) return;
    if (trackAttempts >= MAX_TRACK_ATTEMPTS && now - trackRequestAt > 30000) trackAttempts = 0;
    if (trackAttempts >= MAX_TRACK_ATTEMPTS && !force) return;
    trackRequestAt = now;
    trackAttempts += 1;
    trackRequestId += 1;
    const requestId = sessionId + '_' + trackRequestId;
    let timeout = setTimeout(() => {
      pendingTrackRequests.delete(requestId);
      reportStatus('waiting', '等待 YouTube 字幕来源就绪；稍后会再次检查。', 'youtube-native');
    }, 2000);
    pendingTrackRequests.set(requestId, { timeout, expectedVideoId });
    window.postMessage({ channel: BRIDGE_CHANNEL, type: 'GET_TRACKS', requestId }, location.origin);
    reportStatus('connecting', '正在检查 YouTube 原生字幕轨。', 'youtube-native');
  }

  const pendingTrackRequests = new Map();

  async function importYouTubeTrack(message, request) {
    const tracks = Array.isArray(message.tracks) ? message.tracks.filter((track) =>
      track && typeof track.baseUrl === 'string' && typeof track.languageCode === 'string'
    ) : [];
    const track = tracks.find((item) => /^en(?:[-_]|$)/i.test(item.languageCode) && item.kind !== 'asr') ||
      tracks.find((item) => /^en(?:[-_]|$)/i.test(item.languageCode));
    if (!track) {
      reportStatus(tracks.length ? 'waiting' : 'no_captions', tracks.length ? '当前只发现非英文字幕轨。' : 'YouTube 没有可读取的字幕轨。', 'youtube-native');
      return;
    }
    const trackUrl = getBridgeTrackUrl(track.baseUrl);
    if (!trackUrl) {
      reportStatus('error', 'YouTube 返回的字幕地址不符合安全校验。', 'youtube-native');
      return;
    }
    reportStatus('connecting', '正在通过 YouTube 字幕地址读取整条字幕轨（可能包含尚未播放的部分）。', 'youtube-native');
    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type: 'FETCH_YOUTUBE_CAPTIONS',
        trackUrl,
        expectedVideoId: request.expectedVideoId,
      }, (result) => {
        const error = chrome.runtime.lastError;
        resolve(error ? { ok: false, error: error.message } : (result || { ok: false, error: '后台未响应' }));
      });
    });
    if (!response.ok || !Array.isArray(response.cues)) {
      reportStatus('error', response.error || 'YouTube 字幕请求失败。', 'youtube-native');
      return;
    }
    if (getYouTubeVideoId() !== request.expectedVideoId) return;
    const cues = response.cues.filter((cue) => cue && typeof cue.text === 'string' && Number.isFinite(Number(cue.start)));
    const commonOverhead = JSON.stringify({
      eventId: sessionId + '_1', recordId, sessionId, title: getVideoTitle(),
      identityConfirmed, source: 'youtube-native', cue: { text: '', start: 0, capturedAtEpoch: epochNow() },
    }).length * 2;
    const roughBytes = cues.reduce((sum, cue) => sum + cue.text.length * 2 + commonOverhead, 0);
    if (cues.length > MAX_PENDING_EVENTS || pendingEvents.size + cues.length > MAX_PENDING_EVENTS || pendingBytes + roughBytes > MAX_PENDING_BYTES) {
      reportStatus('error', '完整字幕轨超过页面待确认缓存上限，未导入；可继续使用播放中的实时字幕通道。', 'youtube-native');
      return;
    }
    if (!cues.length) {
      nativeTrackImportedFor = request.expectedVideoId;
      reportStatus('no_captions', '字幕请求成功，但响应里没有可用英文字幕。', 'youtube-native');
      return;
    }
    nativeTrackImportedFor = request.expectedVideoId;
    reportStatus('collecting', `已读取 ${cues.length} 条英文字幕，正在合并保存；整轨读取可能提前收集未播放部分。`, 'youtube-native');
    for (const cue of cues) addCue(cue.text, cue.start, 'youtube-native', true);
    flushPending();
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (!message || message.channel !== BRIDGE_CHANNEL || message.type !== 'TRACKS') return;
    const request = pendingTrackRequests.get(message.requestId);
    if (!request) return;
    clearTimeout(request.timeout);
    pendingTrackRequests.delete(message.requestId);
    const responseVideoId = String(message.videoId || '');
    if (responseVideoId !== request.expectedVideoId || getYouTubeVideoId() !== request.expectedVideoId) return;
    void importYouTubeTrack(message, request).catch((error) => {
      reportStatus('error', '读取 YouTube 字幕失败：' + (error.message || '未知错误'), 'youtube-native');
    });
  });

  function checkConnections() {
    lastHealthAt = Date.now();
    title = getVideoTitle();
    const video = getVideo();
    const urlChanged = location.href !== lastUrl;
    let rotatedForNavigation = false;
    if (urlChanged) {
      lastUrl = location.href;
      const newStableId = getYouTubeVideoId();
      if (newStableId && newStableId !== recordId) rotatedForNavigation = setIdentity(false, '检测到视频导航');
      else if (!newStableId) rotatedForNavigation = setIdentity(true, '页面地址已变化，当前视频身份无法确认');
      reconnectSources();
    }
    const source = activeMediaSource(video);
    if (video && source) {
      if (lastMediaSource && source !== lastMediaSource && !getYouTubeVideoId() && !rotatedForNavigation) {
        setIdentity(true, '检测到媒体来源变化，已开始独立记录');
        reconnectSources();
      }
      lastMediaSource = source;
    }
    if (video !== currentVideo) {
      currentVideo = video;
      refreshTextTrackListeners(video);
      if (!video) reportStatus('waiting', '当前页面尚无可读取的视频元素。');
    } else if (video) {
      refreshTextTrackListeners(video);
    }
    const caption = inspectCaptionRoot();
    if (caption.root !== captionRoot) bindCaptionRoot(caption.root);
    if (caption.host && !caption.root) {
      reportStatus('waiting', '字幕宿主存在，但 Shadow DOM 未开放或尚未就绪。', 'immersive-translate');
    }
    if (video && getYouTubeVideoId() && nativeTrackImportedFor !== getYouTubeVideoId()) requestYouTubeTracks(false);
    if (video && captureStatus === 'connecting') reportStatus('waiting', '等待英文字幕文本变得可读。');
  }

  function scheduleHealthCheck() {
    if (healthTimer) clearTimeout(healthTimer);
    const delay = getVideo() ? 1400 : 5000;
    healthTimer = setTimeout(() => {
      healthTimer = null;
      checkConnections();
      scheduleHealthCheck();
    }, delay);
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      checkConnections();
    }, 200);
  }

  function reconnectSources() {
    if (captionObserver) captionObserver.disconnect();
    captionObserver = null;
    captionRoot = null;
    refreshTextTrackListeners(getVideo());
    scheduleReconnect();
  }

  function getCurrentState() {
    const host = getCaptionHost();
    const root = host && host.shadowRoot;
    return {
      recordId: ensureIdentity(),
      videoId: recordId,
      sessionId,
      statusSequence,
      identityConfirmed,
      title: getVideoTitle(),
      status: captureStatus,
      detail: statusDetail,
      pendingCount: pendingEvents.size,
      pendingBytes,
      source: captionRoot ? 'immersive-translate' : (nativeTrackImportedFor ? 'youtube-native' : ''),
      debug: {
        hostFound: !!host,
        hasShadowRoot: !!root,
        sourceCueCount: root ? root.querySelectorAll('.source-cue').length : 0,
        targetCueCount: root ? root.querySelectorAll('.target-cue').length : 0,
        textTrackCount: currentVideo && currentVideo.textTracks ? currentVideo.textTracks.length : 0,
        activeTextTracks: currentVideo && currentVideo.textTracks
          ? Array.from(currentVideo.textTracks).filter((track) => track.mode !== 'disabled').length : 0,
      },
    };
  }

  function recapture() {
    trackAttempts = 0;
    nativeTrackImportedFor = '';
    if (pendingEvents.size < MAX_PENDING_EVENTS && pendingBytes < MAX_PENDING_BYTES) receivingPaused = false;
    for (const item of pendingEvents.values()) {
      item.retries = 0;
      item.ackRetries = 0;
      item.accepted = false;
      item.inFlight = false;
      item.retryAt = 0;
    }
    scheduleFlush(0);
    if (identityConfirmed) chrome.runtime.sendMessage({ type: 'RETRY_SAVE', recordId }, () => void chrome.runtime.lastError);
    reconnectSources();
    reportStatus('connecting', '正在重新连接字幕来源；原有记录会保留。');
    requestYouTubeTracks(true);
    return getCurrentState();
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) return;
    if (message.type === 'GET_STATE') {
      checkConnections();
      sendResponse({ ok: true, state: getCurrentState() });
      return true;
    }
    if (message.type === 'RECAPTURE') {
      const state = recapture();
      sendResponse({ ok: true, state });
      return true;
    }
    if (message.type === 'SEEK_TO') {
      checkConnections();
      const video = getVideo();
      const time = Number(message.time);
      if (!video || message.videoId !== recordId || !Number.isFinite(time) || time < 0) {
        sendResponse({ ok: false, error: '请打开这条记录对应的视频后再回看' });
      } else {
        try { video.currentTime = time; sendResponse({ ok: true, currentTime: video.currentTime }); }
        catch (error) { sendResponse({ ok: false, error: error.message }); }
      }
      return true;
    }
    if (message.type === 'PERSISTED') {
      if (message.recordId !== recordId && !Array.from(pendingEvents.values()).some((item) => item.event.recordId === message.recordId)) return;
      const ids = new Set(Array.isArray(message.eventIds) ? message.eventIds : []);
      for (const eventId of ids) {
        const pending = pendingEvents.get(eventId);
        if (!pending || pending.event.sessionId !== message.sessionId || pending.event.recordId !== message.recordId) continue;
        lastRoundTripMs = Math.round(epochNow() - pending.event.cue.capturedAtEpoch);
        pendingEvents.delete(eventId);
        pendingBytes = Math.max(0, pendingBytes - pending.bytes);
      }
      const isCurrentSession = message.recordId === recordId && message.sessionId === sessionId;
      if (receivingPaused && pendingEvents.size < MAX_PENDING_EVENTS * 0.6 && pendingBytes < MAX_PENDING_BYTES * 0.6) {
        receivingPaused = false;
        reportStatus('collecting', '本地保存已恢复，继续接收字幕。');
      } else if (isCurrentSession && !pendingEvents.size) {
        reportStatus('saved', '字幕已写入本地记录。');
      }
      if (pendingEvents.size) scheduleFlush(100);
      return;
    }
  });

  function onDocumentChanged() {
    scheduleReconnect();
  }

  function onVideoMetadata() {
    const video = getVideo();
    const source = activeMediaSource(video);
    if (video && source && lastMediaSource && source !== lastMediaSource && !getYouTubeVideoId()) {
      lastMediaSource = source;
      setIdentity(true, '视频媒体切换');
      reconnectSources();
    } else if (source) {
      lastMediaSource = source;
    }
    refreshTextTrackListeners(video);
  }

  function startObservers() {
    ensureIdentity();
    documentObserver = new MutationObserver(onDocumentChanged);
    documentObserver.observe(document.documentElement || document, { childList: true, subtree: true });
    document.addEventListener('loadedmetadata', onVideoMetadata, true);
    document.addEventListener('emptied', onVideoMetadata, true);
    window.addEventListener('popstate', scheduleReconnect);
    window.addEventListener('yt-navigate-finish', () => {
      const videoId = getYouTubeVideoId();
      if (videoId && videoId !== recordId) setIdentity(false, 'YouTube 视频导航');
      else if (!videoId) setIdentity(true, '页面导航后视频身份无法确认');
      reconnectSources();
    });
    checkConnections();
    scheduleHealthCheck();
    reportStatus('waiting', '正在等待英文字幕。');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startObservers, { once: true });
  else startObservers();
})();
