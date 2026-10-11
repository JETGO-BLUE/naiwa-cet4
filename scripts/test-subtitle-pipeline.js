'use strict';

// Local mock verification for the subtitle merge/save/replay pipeline.
// This does not replace a real Chrome/Edge page test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const storageData = Object.create(null);
const runtimeMessages = [];
const tabMessages = [];
let storageDelayMs = 0;
let failWrites = 0;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

const vocabularies = Object.fromEntries(['cet4', 'cet6', 'ielts'].map((name) => [
  name + '_words.json', JSON.parse(fs.readFileSync(path.join(root, name + '_words.json'), 'utf8')),
]));

function makeBackground() {
  let listener;
  const chrome = {
    runtime: {
      onMessage: { addListener(callback) { listener = callback; } },
      getURL(file) { return 'chrome-extension://test/' + file; },
      sendMessage(message, callback) {
        runtimeMessages.push(clone(message));
        if (callback) callback();
      },
      lastError: null,
    },
    tabs: {
      sendMessage(tabId, message, callback) {
        tabMessages.push({ tabId, message: clone(message) });
        if (callback) callback();
      },
    },
    storage: {
      local: {
        async get(keys) {
          if (keys == null) return clone(storageData);
          const names = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(names.map((key) => [key, clone(storageData[key])]));
        },
        async set(values) {
          if (storageDelayMs) await new Promise((resolve) => setTimeout(resolve, storageDelayMs));
          if (failWrites > 0) {
            failWrites -= 1;
            throw new Error('synthetic storage failure');
          }
          Object.assign(storageData, clone(values));
        },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete storageData[key];
        },
      },
    },
  };
  const context = vm.createContext({
    chrome,
    fetch: async (url) => {
      const file = String(url).split('/').pop();
      if (!vocabularies[file]) return { ok: false, status: 404 };
      return { ok: true, json: async () => vocabularies[file] };
    },
    console,
    URL,
    URLSearchParams,
    AbortController,
    setTimeout,
    clearTimeout,
    performance,
    Date,
    Math,
    Object,
    Array,
    Map,
    Set,
    Promise,
    Number,
    String,
    RegExp,
    Error,
    JSON,
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context, { filename: 'background.js' });
  return {
    async send(message, tabId = 7, url = 'https://www.youtube.com/watch?v=abc12345678') {
      return new Promise((resolve, reject) => {
        try {
          const returned = listener(message, { tab: { id: tabId }, url }, (response) => resolve(response));
          if (returned !== true) resolve(undefined);
        } catch (error) { reject(error); }
      });
    },
  };
}

function event(eventId, text, start, capturedAtEpoch) {
  return { eventId, cue: { text, start, capturedAtEpoch: capturedAtEpoch || Date.now() } };
}

async function waitFor(predicate, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('timed out waiting for the expected state');
}

async function run() {
  const background = makeBackground();
  const first = await background.send({
    type: 'CAPTIONS_DELTA', recordId: 'abc12345678', sessionId: 'tab-a-session',
    identityConfirmed: true, title: 'Merge test', source: 'text-track',
    events: [event('cue-a', 'The animals develop rapidly', 2.2)],
  }, 7);
  assert.equal(first.ok, true, 'first increment is accepted before disk confirmation');
  assert.equal(storageData.video_abc12345678, undefined, 'accepted input is still pending during the merge window');

  const competing = await Promise.all([
    background.send({ type: 'CAPTIONS_DELTA', recordId: 'abc12345678', sessionId: 'tab-a-session', identityConfirmed: true, source: 'text-track', events: [event('cue-b', 'development matters', 4)] }, 7),
    background.send({ type: 'CAPTIONS_DELTA', recordId: 'abc12345678', sessionId: 'tab-b-session', identityConfirmed: true, source: 'immersive-translate', events: [event('cue-c', 'They are developing ideas', 6)] }, 8),
    background.send({ type: 'CAPTIONS_DELTA', recordId: 'other-video', sessionId: 'tab-c-session', identityConfirmed: false, source: 'text-track', events: [event('cue-d', 'a separate record', 1)] }, 9),
  ]);
  assert(competing.every((item) => item.ok), 'concurrent pages and videos are accepted');
  await waitFor(() => !!storageData.video_abc12345678 && !!storageData['video_other-video']);

  const record = storageData.video_abc12345678;
  const words = new Map(record.words.map((item) => [item.word, item]));
  assert(words.has('develop'), 'first word remains after later caption batches');
  assert(words.has('development'), 'new word is appended');
  assert(words.has('developing'), 'a separate subtitle word form remains a separate card');
  assert.deepEqual(Array.from(words.get('develop').times), ['0:02.2'], 'existing word keeps its first subtitle start timestamp');
  assert(record.version >= 3, 'same-video page updates are assigned increasing versions');
  assert.equal(storageData['video_other-video'].identityConfirmed, false, 'unconfirmed video identity is persisted as such');
  assert(runtimeMessages.some((message) => message.type === 'RECORD_UPDATED'), 'merge publishes a live update');
  assert(tabMessages.some((message) => message.message.type === 'PERSISTED' && message.message.eventIds.includes('cue-a')),
    'page receives confirmation only after local storage succeeds');

  const stableVersion = record.version;
  const replay = await background.send({
    type: 'CAPTIONS_DELTA', recordId: 'abc12345678', sessionId: 'tab-a-session',
    identityConfirmed: true, source: 'text-track', events: [event('cue-a', 'The animals develop rapidly', 2.2)],
  }, 7);
  assert.equal(replay.ok, true, 'a confirmed event can be safely resent');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(storageData.video_abc12345678.version, stableVersion, 'persisted replay does not create a new version');

  const history = await background.send({ type: 'GET_ALL_VIDEOS' });
  assert(history.videos.some((item) => item.recordId === 'other-video' && item.identityConfirmed === false),
    'history retains explicitly unconfirmed records');

  // Recreate the service worker with the same durable storage. Replaying an
  // event whose acknowledgement was lost must be idempotent after restart.
  const recoveredBackground = makeBackground();
  const recovered = await recoveredBackground.send({
    type: 'CAPTIONS_DELTA', recordId: 'abc12345678', sessionId: 'tab-a-session',
    identityConfirmed: true, source: 'text-track', events: [event('cue-a', 'The animals develop rapidly', 2.2)],
  }, 7);
  assert.equal(recovered.ok, true, 'a page can re-send after service-worker restart');
  assert(tabMessages.some((message) => message.message.type === 'PERSISTED' && message.message.eventIds.includes('cue-a')),
    'durable event IDs allow immediate recovered acknowledgement');

  // Race a new event against an in-progress storage write. The second snapshot
  // must follow the first and must not be overwritten by it.
  storageDelayMs = 180;
  await recoveredBackground.send({
    type: 'CAPTIONS_DELTA', recordId: 'abc12345678', sessionId: 'tab-a-session',
    identityConfirmed: true, source: 'text-track', events: [event('race-a', 'careful planning', 8)],
  }, 7);
  await new Promise((resolve) => setTimeout(resolve, 550));
  await recoveredBackground.send({
    type: 'CAPTIONS_DELTA', recordId: 'abc12345678', sessionId: 'tab-b-session',
    identityConfirmed: true, source: 'text-track', events: [event('race-b', 'planned carefully', 9)],
  }, 8);
  storageDelayMs = 0;
  await waitFor(() => storageData.video_abc12345678.words.some((item) => item.word === 'planning') &&
    storageData.video_abc12345678.words.some((item) => item.word === 'planned'));

  // Old path-hash records remain readable and are labelled as unconfirmed.
  storageData.video_pabc123 = { videoId: 'pabc123', title: 'Old history', words: [{ word: 'develop', times: ['0:01'] }], capturedAt: 1 };
  const legacy = await recoveredBackground.send({ type: 'GET_VIDEO', videoId: 'pabc123' });
  assert.equal(legacy.ok, true);
  assert.equal(legacy.record.words[0].word, 'develop');
  assert.equal(legacy.record.identityConfirmed, false, 'legacy non-YouTube path hashes are not treated as reliable identity');

  const denseEvents = [];
  for (let i = 0; i < 12; i += 1) denseEvents.push(event('time-' + i, 'develop', 100 - i));
  await recoveredBackground.send({
    type: 'CAPTIONS_DELTA', recordId: 'time-limit', sessionId: 'time-session',
    identityConfirmed: false, source: 'immersive-translate', events: denseEvents,
  }, 11);
  await waitFor(() => !!storageData['video_time-limit']);
  const limitedTimes = storageData['video_time-limit'].words.find((item) => item.word === 'develop').times;
  assert.equal(limitedTimes.length, 10, 'each word keeps at most ten distinct timestamps');
  assert.deepEqual(Array.from(limitedTimes), ['1:29','1:30','1:31','1:32','1:33','1:34','1:35','1:36','1:37','1:38'],
    'the earliest ten timestamps stay sorted after out-of-order playback updates');

  failWrites = 3;
  await recoveredBackground.send({
    type: 'CAPTIONS_DELTA', recordId: 'failure-video', sessionId: 'failure-session',
    identityConfirmed: false, source: 'text-track', events: [event('failure-event', 'develop', 1)],
  }, 12);
  await waitFor(() => runtimeMessages.some((message) => message.type === 'RECORD_SAVE_PAUSED' && message.recordId === 'failure-video'), 6000);
  assert.equal(storageData['video_failure-video'], undefined, 'failed writes are not acknowledged as persisted');
  assert(!tabMessages.some((item) => item.message.eventIds && item.message.eventIds.includes('failure-event')),
    'page receives no durable acknowledgement while storage fails');
  await recoveredBackground.send({ type: 'RETRY_SAVE', recordId: 'failure-video' }, 12);
  await waitFor(() => !!storageData['video_failure-video']);
  assert(tabMessages.some((item) => item.message.eventIds && item.message.eventIds.includes('failure-event')),
    'manual retry releases the retained event after local storage recovers');

  const callbackTimes = [];
  for (let i = 0; i < 1000; i += 1) {
    const started = performance.now();
    await recoveredBackground.send({
      type: 'CAPTIONS_DELTA', recordId: 'benchmark-video', sessionId: 'benchmark-session',
      identityConfirmed: false, source: 'text-track',
      events: [event('benchmark-' + i, 'Development is important', i + 1)],
    }, 13);
    callbackTimes.push(performance.now() - started);
  }
  callbackTimes.sort((a, b) => a - b);
  const benchmark = await recoveredBackground.send({ type: 'GET_PERF' }, 13);

  console.log('Subtitle pipeline mock checks passed: cumulative merge, distinct forms, bounded/sorted timestamps, time dedupe, multi-tab merge, isolated videos, delayed durable acknowledgement, replay/recovery, serial competing writes, save-failure pause/retry, unconfirmed identity, and legacy history.');
  console.log(`Synthetic 1,000 single-cue incremental messages: callback median ${callbackTimes[499].toFixed(3)} ms, P95 ${callbackTimes[949].toFixed(3)} ms; background match P95 ${benchmark.summary.match.p95.toFixed(3)} ms (Node VM + mock storage, excludes browser and popup rendering).`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
