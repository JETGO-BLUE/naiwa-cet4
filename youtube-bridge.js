// youtube-bridge.js —— 只在 YouTube 页面、跑在 MAIN world（页面世界）里的桥。
//
// 为什么需要它：
//   content script 跑在「隔离世界」里，window 是扩展自己的全局对象，
//   **读不到页面 JS 定义的 window.ytInitialPlayerResponse**。
//   所以 content.js 里那句 `if (window.ytInitialPlayerResponse)` 永远是 undefined，
//   「YouTube 原生字幕兜底」这条通道以前从来没成功过一次。
//
// 这个脚本挂在 MAIN world，能正常读页面变量；它把「字幕轨的元数据」通过 postMessage
// 递给隔离世界的 content.js，再由 background 去下载字幕。
//
// 安全边界：
//   - 只匹配 youtube.com（manifest 里限制），其他站点根本不会注入
//   - 只处理同 window、同 origin、channel 与 requestId 都合法的消息
//   - 只回传 baseUrl / languageCode / kind / label 四个字段，且全部截断长度
//   - 不 eval、不注入任何远程内容、不碰 DOM
(function () {
  'use strict';

  const CHANNEL = 'naiwa-yt-bridge-v1';
  const MAX_TRACKS = 40;
  const MAX_REQUEST_ID = 120;

  if (!/(^|\.)youtube\.com$/i.test(location.hostname)) return;

  function clip(value, limit) {
    return String(value == null ? '' : value).slice(0, limit);
  }

  // 页面世界的播放器数据：优先新接口，其次老接口
  function playerResponse() {
    try {
      if (window.ytInitialPlayerResponse && typeof window.ytInitialPlayerResponse === 'object') {
        return window.ytInitialPlayerResponse;
      }
      const args = window.ytplayer && window.ytplayer.config && window.ytplayer.config.args;
      if (args && typeof args.player_response === 'string') {
        return JSON.parse(args.player_response);
      }
    } catch (e) {
      /* 页面结构变化时静默失败，交给其他通道 */
    }
    return null;
  }

  function videoIdFromLocation() {
    try {
      const url = new URL(location.href);
      const v = url.searchParams.get('v');
      if (v) return v;
      const m = url.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]+)/);
      return m ? m[1] : '';
    } catch (e) {
      return '';
    }
  }

  function readTracks() {
    const pr = playerResponse();
    let videoId = videoIdFromLocation();
    let tracks = [];
    try {
      const list = pr.captions.playerCaptionsTracklistRenderer.captionTracks || [];
      tracks = list.slice(0, MAX_TRACKS).map((t) => {
        const name = t.name || {};
        const label = name.simpleText ||
          (Array.isArray(name.runs) ? name.runs.map((r) => r.text || '').join(' ') : '');
        return {
          baseUrl: clip(t.baseUrl, 4000),
          languageCode: clip(t.languageCode, 24),
          kind: clip(t.kind, 32),
          label: clip(label, 100),
        };
      }).filter((t) => t.baseUrl && t.languageCode);
      if (pr.videoDetails && pr.videoDetails.videoId) videoId = pr.videoDetails.videoId;
    } catch (e) {
      tracks = [];
    }
    return { videoId: clip(videoId, 32), tracks: tracks };
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    if (event.origin !== location.origin) return;

    const msg = event.data;
    if (!msg || msg.channel !== CHANNEL || msg.type !== 'GET_TRACKS') return;
    if (typeof msg.requestId !== 'string' || !msg.requestId || msg.requestId.length > MAX_REQUEST_ID) return;

    const data = readTracks();
    window.postMessage({
      channel: CHANNEL,
      type: 'TRACKS',
      requestId: msg.requestId,
      videoId: data.videoId,
      tracks: data.tracks,
    }, location.origin);
  }, false);
})();
