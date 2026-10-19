'use strict';

// 只使用内存 storage、合成页面和本地词表；不读取用户浏览器资料或联网。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { stageRuntime, validateRuntime, files } = require('./package-extension');
const root = path.resolve(__dirname, '..');
const source = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const assets = Object.fromEntries(['cet4_words.json', 'cet6_words.json', 'ielts_words.json',
  'vocab_extra_meanings.json', 'quiz_bank.json'].map((file) => [file, JSON.parse(source(file))]));
const quiet = { log() {}, warn() {}, error() {} };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let count = 0;
async function test(name, run) { await run(); count++; console.log('PASS ' + name); }

function background(initial = {}) {
  const data = clone(initial);
  const changes = [];
  const acks = [];
  let listener;
  let delay = 0;
  let failures = 0;
  const chrome = {
    runtime: { lastError: null, getURL: (file) => 'chrome-extension://test/' + file,
      onMessage: { addListener(fn) { listener = fn; } } },
    tabs: { sendMessage(tabId, message, callback) { acks.push({ tabId, message: clone(message) }); if (callback) callback(); },
      onRemoved: { addListener(fn) { chrome.removeTab = fn; } } },
    storage: { onChanged: { addListener(fn) { changes.push(fn); } }, local: {
      async get(keys) {
        const snapshot = clone(data);
        if (keys == null) return snapshot;
        return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, snapshot[key]]));
      },
      async set(values) {
        if (delay) await pause(delay);
        if (failures) { failures--; throw new Error('synthetic write failure'); }
        const event = Object.fromEntries(Object.entries(values).map(([key, value]) => [key,
          { oldValue: clone(data[key]), newValue: clone(value) }]));
        Object.assign(data, clone(values));
        changes.forEach((fn) => fn(event, 'local'));
      },
      async remove(keys) {
        const event = {};
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          event[key] = { oldValue: clone(data[key]) }; delete data[key];
        }
        changes.forEach((fn) => fn(event, 'local'));
      },
    } },
  };
  const context = vm.createContext({ chrome, console: quiet, URL, URLSearchParams, AbortController,
    setTimeout, clearTimeout, performance, fetch: async (url) => {
      const file = String(url).split('/').pop();
      if (!assets[file]) throw new Error('Unexpected network request: ' + url);
      return { ok: true, json: async () => clone(assets[file]) };
    } });
  vm.runInContext(source('background.js'), context, { filename: 'background.js' });
  return { data, chrome, context, acks, changes,
    delay(ms) { delay = ms; }, fail(n) { failures = n; },
    send(message, sender = {}) { return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('No response: ' + message.type)), 1500);
      listener(clone(message), sender, (response) => { clearTimeout(timeout); resolve(clone(response)); });
    }); },
  };
}
const delta = (videoId, text, start = 1) => ({ type: 'CAPTIONS_DELTA', videoId, title: videoId,
  identityConfirmed: true, cues: [{ text, start }] });

function popup(bg) {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '', value: '', dataset: {}, style: {}, scrollTop: 0,
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      handlers: {}, addEventListener(type, fn) { this.handlers[type] = fn; }, querySelectorAll() { return []; },
      querySelector() { return null; }, getBoundingClientRect() { return { left: 0, top: 0, bottom: 0 }; } });
    return nodes.get(id);
  };
  const sent = [];
  const chrome = { runtime: { lastError: null, getURL: (file) => file, sendMessage(message, callback) {
    sent.push(clone(message)); void bg.send(message).then(callback);
  } }, storage: bg.chrome.storage, tabs: {
    query(options, callback) { const tabs = [{ id: 7 }]; if (callback) callback(tabs); return Promise.resolve(tabs); },
    sendMessage(tabId, message, callback) { callback({ ok: true, state: { videoId: 'active', debug: {} } }); },
  } };
  const context = vm.createContext({ chrome, window: {}, console: quiet, setTimeout, clearTimeout,
    alert() {}, confirm() { return true; }, document: { getElementById: node, querySelectorAll() { return []; },
      querySelector() { return null; }, addEventListener() {}, removeEventListener() {} } });
  vm.runInContext(source('popup.js').replace(/init\(\);\s*$/, ''), context, { filename: 'popup.js' });
  return { context, nodes, sent, run: (code) => vm.runInContext(code, context) };
}

function content(bg) {
  const timers = new Map();
  let timerId = 0;
  const observers = [];
  const windowEvents = {};
  let listener;
  const messages = [];
  const documentEvents = {};
  const location = { href: 'https://www.youtube.com/watch?v=NEW12345678', hostname: 'www.youtube.com',
    origin: 'https://www.youtube.com', search: '?v=NEW12345678', pathname: '/watch', host: 'www.youtube.com' };
  let host = null;
  const tracks = [];
  tracks.addEventListener = () => {};
  tracks.removeEventListener = () => {};
  const video = { currentTime: 10, currentSrc: 'blob:first', textTracks: tracks };
  const chrome = { runtime: { lastError: null, onMessage: { addListener(fn) { listener = fn; } },
    sendMessage(message, callback) {
      messages.push(clone(message));
      if (bg) void bg.send(message, { tab: { id: 7 } }).then((response) => { if (callback) callback(response); });
      else if (callback) callback({ ok: true });
    } } };
  const window = { addEventListener(type, fn) { windowEvents[type] = fn; }, postMessage(message) { messages.push(clone(message)); } };
  const context = vm.createContext({ chrome, window, location, URL, URLSearchParams, crypto: webcrypto,
    performance, console: quiet,
    document: { readyState: 'loading', title: 'Synthetic video', documentElement: {},
      addEventListener(type, fn) { documentEvents[type] = fn; },
      querySelector(selector) { return selector === 'video' ? video : selector.includes('caption-window') ? host : null; } },
    MutationObserver: function (callback) { this.callback = callback; this.observe = () => {}; this.disconnect = () => {}; observers.push(this); },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(source('content.js').replace(/\}\)\(\);\s*$/, `globalThis.api = {
    addCue, flushPending, checkConnections, getCurrentState, startObservers, requestYouTubeTracks,
    recapture, readCaptionNow, consumeTextTrack,
    pending: () => Array.from(pendingEvents.values()),
  };})();`), context, { filename: 'content.js' });
  if (bg) {
    const original = bg.chrome.tabs.sendMessage;
    bg.chrome.tabs.sendMessage = (tabId, message, callback) => {
      original(tabId, message, callback);
      listener(message, {}, () => {});
    };
  }
  return { api: context.api, messages, video, tracks, observers, timers, location, window, context,
    setHost(value) { host = value; },
    receive(message) { let response; listener(message, {}, (value) => { response = value; }); return response; },
    bridge(message) { windowEvents.message({ source: window, origin: location.origin, data: message }); },
  };
}

async function main() {
  await test('parallel caption batches retain both word sets', async () => {
    const bg = background();
    const results = await Promise.all([bg.send(delta('race', 'development')), bg.send(delta('race', 'animal', 201))]);
    assert(results.every((result) => result.ok));
    assert.deepEqual(new Set(bg.data.video_race.words.map((word) => word.word)), new Set(['development', 'animal']));
  });
  await test('native full track appends to existing record', async () => {
    const bg = background(); await bg.send(delta('native', 'development'));
    await bg.send({ ...delta('native', 'animal', 201), type: 'CAPTIONS', source: 'youtube-native' });
    assert.equal(bg.data.video_native.words.length, 2);
  });
  await test('legacy fractional timestamps survive subsequent capture', async () => {
    const bg = background({ video_old: { videoId: 'old', capturedAt: 1,
      words: [{ word: 'development', lemma: 'development', times: ['0:02.2', '3:05'] }] } });
    await bg.send(delta('old', 'development', 405));
    assert.deepEqual(bg.data.video_old.words[0].times, [2.2, 185, 405]);
    assert.equal(bg.data.video_old.capturedAt, 1);
  });
  await test('replay and reverse ordering retain earliest point in each bucket', async () => {
    const bg = background();
    for (const time of [188, 185, 2, 2, ...Array.from({ length: 15 }, (_, i) => 400 + i * 180)]) {
      await bg.send(delta('times', 'development', time));
    }
    const times = bg.data.video_times.words[0].times;
    assert.equal(times.length, 10); assert.deepEqual(times.slice(0, 2), [2, 185]);
  });
  await test('durable acknowledgement follows successful disk write', async () => {
    const bg = background(); bg.delay(20);
    const event = { eventId: 'e1', cue: { text: 'animal', start: 2 } };
    const pending = bg.send({ type: 'CAPTIONS_DELTA', videoId: 'ack', sessionId: 's1', events: [event] }, { tab: { id: 7 } });
    await pause(2); assert.equal(bg.acks.length, 0); assert.equal(bg.data.video_ack, undefined);
    assert.equal((await pending).ok, true);
    assert.equal(bg.acks[0].message.type, 'PERSISTED'); assert(bg.data.video_ack);
  });
  await test('storage failure returns an error without durable acknowledgement; retry succeeds', async () => {
    const bg = background(); bg.fail(1);
    assert.equal((await bg.send(delta('failure', 'animal'))).ok, false);
    assert.equal(bg.data.video_failure, undefined); assert.equal(bg.acks.length, 0);
    assert.equal((await bg.send(delta('failure', 'animal'))).ok, true);
  });
  await test('service worker restart replays safely', async () => {
    const first = background(); await first.send(delta('restart', 'animal', 2));
    const second = background(first.data);
    await second.send(delta('restart', 'animal', 2)); await second.send(delta('restart', 'development', 201));
    assert.equal(second.data.video_restart.words.length, 2);
  });
  await test('filtered progress and simultaneous videos keep every answer', async () => {
    const bg = background();
    await bg.send({ type: 'SAVE_PROGRESS', videoId: 'A', done: { animal: true, development: true }, wrong: { development: [1] } });
    await Promise.all([
      bg.send({ type: 'SAVE_PROGRESS', videoId: 'A', done: { animal: true }, wrong: { animal: [0] } }),
      bg.send({ type: 'SAVE_PROGRESS', videoId: 'B', done: { study: true } }),
    ]);
    assert.deepEqual(bg.data.quizProgress.A.done, { animal: true, development: true });
    assert.deepEqual(bg.data.quizProgress.A.wrong.development, [1]); assert(bg.data.quizProgress.B.done.study);
  });
  await test('explicit word reset clears only that word', async () => {
    const bg = background({ quizProgress: { A: { done: { animal: true, development: true }, wrong: { animal: [0] } } } });
    await bg.send({ type: 'SAVE_PROGRESS', videoId: 'A', resetWords: ['animal'] });
    assert.deepEqual(bg.data.quizProgress.A.done, { development: true }); assert.equal(bg.data.quizProgress.A.wrong.animal, undefined);
  });
  await test('changed quiz options invalidate old answer indexes', async () => {
    const bg = background({ quizProgress: { A: { done: { animal: true }, wrong: { animal: [1] }, signatures: { animal: 'old' } } } });
    await bg.send({ type: 'SAVE_PROGRESS', videoId: 'A', signatures: { animal: 'new' } });
    assert.equal(bg.data.quizProgress.A.done.animal, undefined); assert.equal(bg.data.quizProgress.A.wrong.animal, undefined);
  });
  await test('deletion removes one record and its progress, leaving others intact', async () => {
    const bg = background({ video_A: { videoId: 'A' }, video_B: { videoId: 'B' }, lastVideoId: 'A',
      familiarWords: ['animal'], quizProgress: { A: { done: {} }, B: { done: { study: true } } } });
    assert.equal((await bg.send({ type: 'DELETE_VIDEO', videoId: 'A' })).ok, true);
    assert.equal(bg.data.video_A, undefined); assert.equal(bg.data.quizProgress.A, undefined);
    assert(bg.data.video_B); assert(bg.data.quizProgress.B); assert.deepEqual(bg.data.familiarWords, ['animal']);
  });
  await test('actively capturing video cannot be deleted', async () => {
    const bg = background(); await bg.send(delta('active', 'animal'), { tab: { id: 7 } });
    assert.equal((await bg.send({ type: 'DELETE_VIDEO', videoId: 'active' })).ok, false);
    bg.chrome.removeTab(7);
    assert.equal((await bg.send({ type: 'DELETE_VIDEO', videoId: 'active' })).ok, true);
  });
  await test('concurrent familiar-word operations do not overwrite', async () => {
    const bg = background(); await Promise.all(['animal', 'development'].map((word) => bg.send({ type: 'SLASH_WORD', word })));
    assert.equal(bg.data.familiarWords.length, 2);
  });
  await test('custom dictionaries redecorate old cards and override quiz meanings', async () => {
    const bg = background({ selectedVocabulary: 'ielts' });
    assert.equal((await bg.send({ type: 'GET_VOCABULARIES' })).selected, 'ielts');
    await bg.send(delta('custom', 'animal'));
    const imported = await bg.send({ type: 'IMPORT_DICT', name: 'Mine', words: { animal: '自定义释义', 'x-ray': '射线' } });
    const id = imported.dict.id;
    const card = (await bg.send({ type: 'GET_VIDEO', videoId: 'custom' })).record.words[0];
    assert(card.cats.includes(id));
    assert.equal(card.meaning, '自定义释义');
    const quiz = (await bg.send({ type: 'GET_QUIZ_BATCH', words: ['animal'] })).quizzes.animal;
    assert.equal(quiz.correct, '自定义释义');
    await bg.send(delta('custom', 'x-ray', 200));
    assert(bg.data.video_custom.words.some((word) => word.word === 'x-ray'));
    await bg.send({ type: 'DELETE_DICT', id });
    const old = (await bg.send({ type: 'GET_VIDEO', videoId: 'custom' })).record.words.find((word) => word.word === 'animal');
    assert(!old.cats.includes(id));
    assert.notEqual(old.meaning, '自定义释义');
  });
  await test('local quizzes cover all three vocabulary heads and preserve phrase compatibility', async () => {
    const bg = background();
    const heads = Array.from(new Set(['cet4_words.json', 'cet6_words.json', 'ielts_words.json'].flatMap((file) => Object.keys(assets[file]))));
    const response = await bg.send({ type: 'GET_QUIZ_BATCH', words: heads });
    assert.equal(Object.keys(response.quizzes).length, 6043);
    for (const quiz of Object.values(response.quizzes)) {
      assert.equal(quiz.options.length, 4); assert.equal(new Set(quiz.options).size, 4); assert.equal(quiz.options[quiz.answer], quiz.correct);
    }
    await bg.send(delta('phrase', 'inasmuch as'));
    assert(bg.data.video_phrase.words.some((word) => word.word === 'inasmuchas'));
  });
  await test('stale or unrelated native subtitle URL is rejected before fetch', async () => {
    const bg = background();
    const result = await bg.send({ type: 'FETCH_YOUTUBE_CAPTIONS', expectedVideoId: 'NEW12345678',
      trackUrl: 'https://www.youtube.com/api/timedtext?v=OLD12345678' });
    assert.equal(result.ok, false);
  });
  await test('popup saves hidden answers and parses fractional legacy timestamps', async () => {
    const bg = background(); const ui = popup(bg);
    ui.run("currentRecord={videoId:'A'};lastLoadedVideoId='A';deckWords=[{word:'animal'}];quizState.set('animal',{solved:true,wrong:new Set()});quizState.set('development',{solved:true,wrong:new Set([1])});");
    await ui.run('saveProgress()');
    assert(bg.data.quizProgress.A.done.development); assert.equal(ui.run("timeToSec('3:05.4')"), 185.4);
  });
  await test('popup record subscription updates cards while retaining current anchor', async () => {
    const bg = background(); await bg.send(delta('active', 'animal', 2));
    const ui = popup(bg); await ui.run('loadDicts()');
    ui.run("activeVideoId='active';currentRecord=null;");
    await ui.run("refreshCurrentRecord('active')"); await ui.run('renderCurrent()');
    await bg.send(delta('active', 'development', 201)); await pause(20);
    assert(ui.run("currentRecord.words.some(w=>w.word==='development')"));
    assert.equal(ui.run('deckWords[deckIndex].word'), 'animal');
  });
  await test('normal mode exposes meanings; quiz mode and all-category labels remain available', async () => {
    const bg = background(); const ui = popup(bg); await ui.run('loadDicts()');
    const html = ui.run("vocabularyTags(['cet4','cet6','ielts'])");
    assert(html.includes('四级') && html.includes('六级') && html.includes('雅思'));
    const host = { innerHTML: '' };
    ui.context.card = { querySelector() { return host; }, getAttribute() { return '0'; }, classList: { toggle() {} } };
    ui.run("learningMode='normal';renderQuizBlock(card,{word:'animal',meaning:'动物'})");
    assert(host.innerHTML.includes('动物')); assert(!host.innerHTML.includes('class="opt'));
    assert(source('popup.html').includes('id="learningModeSelect"'));
  });
  await test('pending content events are retained until matching durable acknowledgement', async () => {
    const page = content(); page.api.addCue('animal', 1, 'text-track', true); page.api.flushPending();
    assert.equal(page.api.pending().length, 1);
    const event = page.api.pending()[0].event;
    page.receive({ type: 'PERSISTED', recordId: event.recordId, sessionId: 'other', eventIds: [event.eventId] });
    assert.equal(page.api.pending().length, 1);
    page.receive({ type: 'PERSISTED', recordId: event.recordId, sessionId: event.sessionId, eventIds: [event.eventId] });
    assert.equal(page.api.pending().length, 0);
  });
  await test('production content and worker acknowledge saved events across video navigation', async () => {
    const bg = background(); bg.delay(10);
    const page = content(bg);
    page.api.addCue('animal', 1, 'text-track', true);
    page.location.href = 'https://www.youtube.com/watch?v=OTHER123456';
    page.location.search = '?v=OTHER123456';
    page.api.checkConnections();
    page.api.addCue('development', 201, 'text-track', true);
    page.api.flushPending();
    assert.equal(page.api.pending().length, 2);
    await pause(40); page.api.flushPending(); await pause(40);
    assert.equal(page.api.pending().length, 0);
    assert.deepEqual(bg.data.video_NEW12345678.words.map((word) => word.word), ['animal']);
    assert.deepEqual(bg.data.video_OTHER123456.words.map((word) => word.word), ['development']);
  });
  await test('unknown page identity separates episodes and survives recapture within the session', async () => {
    const page = content();
    Object.assign(page.location, { hostname: 'www.bilibili.com', href: 'https://www.bilibili.com/video/BV123?p=1' });
    page.api.checkConnections(); const first = page.api.getCurrentState().recordId;
    page.api.recapture(); assert.equal(page.api.getCurrentState().recordId, first);
    page.location.href = 'https://www.bilibili.com/video/BV123?p=2'; page.api.checkConnections();
    assert.notEqual(page.api.getCurrentState().recordId, first);
    assert.equal(page.api.getCurrentState().identityConfirmed, false);
  });
  await test('caption host replacement is rebound and standard cuechange is observed', async () => {
    const page = content();
    const host = (text) => ({ shadowRoot: { querySelectorAll(selector) { return selector === '.source-cue' ? [{ textContent: text }] : []; } } });
    page.setHost(host('animal')); page.api.checkConnections(); page.api.readCaptionNow();
    const firstObservers = page.observers.length;
    page.setHost(host('development')); page.api.checkConnections(); page.api.readCaptionNow();
    assert(page.observers.length > firstObservers);
    let cuechange;
    page.tracks.push({ mode: 'showing', language: 'en', activeCues: [{ text: 'planning', startTime: 201 }],
      addEventListener(type, callback) { if (type === 'cuechange') cuechange = callback; }, removeEventListener() {} });
    page.api.checkConnections(); assert.equal(typeof cuechange, 'function'); cuechange();
    assert(page.api.pending().some((item) => item.event.cue.text === 'planning'));
  });
  await test('stale bridge response is rejected and seeking checks record identity', async () => {
    const page = content(); page.api.checkConnections(); page.api.requestYouTubeTracks(true);
    const request = page.messages.filter((message) => message.type === 'GET_TRACKS').pop();
    page.bridge({ channel: request.channel, type: 'TRACKS', requestId: request.requestId, videoId: 'OLD12345678',
      tracks: [{ baseUrl: 'https://www.youtube.com/api/timedtext?v=OLD12345678', languageCode: 'en' }] });
    assert(!page.messages.some((message) => message.type === 'FETCH_YOUTUBE_CAPTIONS'));
    assert.equal(page.receive({ type: 'SEEK_TO', videoId: 'OTHER123456', time: 20 }).ok, false);
    assert.equal(page.receive({ type: 'SEEK_TO', videoId: 'NEW12345678', time: 20 }).ok, true);
  });
  await test('bridge uses current player data instead of stale initial response after SPA navigation', async () => {
    let onMessage;
    let response;
    const playerResponse = (id) => ({ videoDetails: { videoId: id }, captions: { playerCaptionsTracklistRenderer: {
      captionTracks: [{ baseUrl: 'https://www.youtube.com/api/timedtext?v=' + id, languageCode: 'en' }],
    } } });
    const window = { ytInitialPlayerResponse: playerResponse('OLD12345678'),
      addEventListener(type, fn) { onMessage = fn; }, postMessage(value) { response = value; } };
    const context = vm.createContext({ window, URL, location: { hostname: 'www.youtube.com', origin: 'https://www.youtube.com',
      href: 'https://www.youtube.com/watch?v=NEW12345678' },
      document: { getElementById() { return { getPlayerResponse: () => playerResponse('NEW12345678') }; } } });
    vm.runInContext(source('youtube-bridge.js'), context);
    onMessage({ source: window, origin: 'https://www.youtube.com', data: {
      channel: 'naiwa-youtube-caption-bridge-v1', type: 'GET_TRACKS', requestId: 'request' } });
    assert.equal(response.videoId, 'NEW12345678'); assert(response.tracks[0].baseUrl.includes('NEW12345678'));
  });
  await test('staged release contains every manifest reference, data file and notice', async () => {
    const output = fs.mkdtempSync(path.join(os.tmpdir(), 'cet4-package-test-'));
    // 只创建临时产物，不删除任何用户目录。
    stageRuntime(output); assert.equal(validateRuntime(output), files.length);
    for (const file of files) assert(fs.readFileSync(path.join(output, file)).equals(fs.readFileSync(path.join(root, file))));
  });
  console.log('\n' + count + ' regression checks passed (Node VM + mock storage/page; not Chrome/Edge acceptance).');
}
if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { background };
