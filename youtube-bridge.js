// Runs in the YouTube page world only. It exposes caption-track metadata to
// the isolated extension content script; it never evaluates remote content.
(function () {
  'use strict';

  const CHANNEL = 'naiwa-youtube-caption-bridge-v1';
  if (!/(^|\.)youtube\.com$/.test(location.hostname)) return;

  function playerResponse() {
    try {
      // SPA 导航后初始全局变量可能仍属于上一条视频，优先问当前播放器。
      const player = document.getElementById('movie_player');
      if (player && typeof player.getPlayerResponse === 'function') {
        const current = player.getPlayerResponse();
        if (current && current.videoDetails && current.videoDetails.videoId === videoIdFromPage()) return current;
      }
      if (window.ytInitialPlayerResponse && typeof window.ytInitialPlayerResponse === 'object') {
        return window.ytInitialPlayerResponse;
      }
      const args = window.ytplayer && window.ytplayer.config && window.ytplayer.config.args;
      if (args && typeof args.player_response === 'string') return JSON.parse(args.player_response);
    } catch (_) {}
    return null;
  }

  function videoIdFromPage() {
    try {
      const url = new URL(location.href);
      return url.searchParams.get('v') || (url.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]+)/) || [])[1] || '';
    } catch (_) {
      return '';
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (!message || message.channel !== CHANNEL || message.type !== 'GET_TRACKS' ||
        typeof message.requestId !== 'string' || message.requestId.length > 120) return;
    const response = playerResponse();
    let tracks = [];
    let responseVideoId = videoIdFromPage();
    try {
      const captions = response.captions.playerCaptionsTracklistRenderer;
      tracks = (captions.captionTracks || []).slice(0, 40).map((track) => ({
        baseUrl: String(track.baseUrl || '').slice(0, 4000),
        languageCode: String(track.languageCode || '').slice(0, 24),
        kind: String(track.kind || '').slice(0, 32),
        label: String((track.name && (track.name.simpleText || track.name.runs && track.name.runs.map((part) => part.text).join(' '))) || '').slice(0, 100),
      })).filter((track) => track.baseUrl && track.languageCode);
      responseVideoId = (response.videoDetails && response.videoDetails.videoId) || responseVideoId;
    } catch (_) {
      tracks = [];
    }
    window.postMessage({
      channel: CHANNEL,
      type: 'TRACKS',
      requestId: message.requestId,
      videoId: String(responseVideoId || '').slice(0, 32),
      tracks,
    }, location.origin);
  }, false);
})();
