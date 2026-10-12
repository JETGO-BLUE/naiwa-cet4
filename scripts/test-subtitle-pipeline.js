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
const quizAssets = Object.fromEntries(['quiz_bank.json', 'quiz_extras.json'].map((name) => [
  name, JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')),
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
      const data = vocabularies[file] || quizAssets[file];
      if (!data) return { ok: false, status: 404 };
      return { ok: true, json: async () => data };
    },
    console: { log() {}, warn() {}, error() {} },
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
  const initialSettings = await background.send({ type: 'GET_VOCABULARY' });
  assert.equal(initialSettings.learningMode, 'normal', 'users without a saved mode start in normal mode');
  assert.equal(initialSettings.selectedVocabulary, 'cet4', 'legacy users retain the default CET4 selection');

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

  // Old raw records keep basic words. The display projection labels them so
  // normal mode can hide them while quiz mode can still show them.
  const basicRaw = {
    videoId: 'basic-legacy', title: 'Legacy basic words', capturedAt: 1,
    words: [{ word: 'a', times: ['0:01'] }, { word: 'I', times: ['0:02'] }],
  };
  storageData['video_basic-legacy'] = basicRaw;
  const basicView = await recoveredBackground.send({ type: 'GET_VIDEO', videoId: 'basic-legacy' });
  assert.deepEqual(Array.from(basicView.record.words, (word) => word.word), ['a', 'I'], 'basic words remain available in the display projection');
  assert(basicView.record.words.every((word) => word.isBasic), 'basic words are marked for normal-mode display filtering');
  assert.deepEqual(Array.from(storageData['video_basic-legacy'].words, (word) => word.word), ['a', 'I'], 'reading a legacy record never rewrites its raw words');

  const phraseRecord = await recoveredBackground.send({
    type: 'CAPTIONS_DELTA', recordId: 'quiz-word-forms', sessionId: 'quiz-session',
    identityConfirmed: false, source: 'text-track',
    events: [event('quiz-phrase', 'Inasmuch as the student studies', 12.34)],
  }, 14);
  assert.equal(phraseRecord.ok, true);
  await waitFor(() => !!storageData['video_quiz-word-forms']);
  const phraseWords = storageData['video_quiz-word-forms'].words;
  assert(phraseWords.some((word) => word.word === 'inasmuch as' && word.lemma === 'inasmuchas'), 'the repaired IELTS phrase maps to the preserved legacy headword');
  assert(phraseWords.some((word) => word.word === 'studies' && word.lemma === 'study'), 'subtitle cards retain the surface form and record the prototype');
  assert(phraseWords.find((word) => word.word === 'inasmuch as').times.includes('0:12.3'), 'phrase timestamps retain the existing tenth-second precision');

  const studiesQuestion = await recoveredBackground.send({ type: 'GET_QUIZ_BATCH', vocabulary: 'cet4', words: ['study'] });
  assert.equal(studiesQuestion.ok, true);
  assert.equal(studiesQuestion.quizzes.study.lemma, 'study', 'the quiz API returns the prototype question for a surface-form card');
  assert.equal(studiesQuestion.quizzes.study.options.length, 4, 'the quiz API returns four answer options');
  assert.equal(new Set(studiesQuestion.quizzes.study.options).size, 4, 'the quiz API options are distinct');
  const basicQuestion = await recoveredBackground.send({ type: 'GET_QUIZ_BATCH', vocabulary: 'cet4', words: ['a'] });
  assert.equal(basicQuestion.quizzes.a.options.length, 4, 'a basic word still has its question in quiz mode');
  for (const word of ['cigar', 'mysterious']) {
    const repaired = await recoveredBackground.send({ type: 'GET_QUIZ_BATCH', vocabulary: 'cet4', words: [word] });
    const question = repaired.quizzes[word];
    assert(question, `upstream question ${word} remains available after duplicate-gloss repair`);
    assert.equal(new Set(question.options.map((option) => option.replace(/[\s，,。；;：:、\/（）()\[\]【】]/g, '').toLowerCase())).size, 4,
      `upstream question ${word} has four non-equivalent options at runtime`);
    assert.equal(question.options[question.correctIndex], question.correct, `upstream question ${word} has exactly one indexed correct answer`);
    assert.equal(question.meaningSource, 'upstream-cet4-quiz-bank+runtime-dedup', `upstream question ${word} records its runtime repair`);
  }
  const wrongCategory = await recoveredBackground.send({ type: 'GET_QUIZ_BATCH', vocabulary: 'cet6', words: ['study'] });
  assert.equal(wrongCategory.quizzes.study, undefined, 'a question cannot leak into a vocabulary where the word does not match');
  const phraseQuestion = await recoveredBackground.send({ type: 'GET_QUIZ_BATCH', vocabulary: 'ielts', words: ['inasmuchas'] });
  assert.equal(phraseQuestion.quizzes.inasmuchas.lemma, 'inasmuchas', 'the repaired phrase has a local quiz question');

  const modeSaved = await recoveredBackground.send({ type: 'SET_LEARNING_MODE', learningMode: 'quiz' });
  assert.equal(modeSaved.learningMode, 'quiz');
  assert.equal(storageData.learningMode, 'quiz', 'mode selection persists without changing collection records');
  assert.deepEqual(Array.from(storageData['video_quiz-word-forms'].words, (word) => word.word), ['inasmuch as', 'student', 'studies'], 'switching modes leaves newly collected raw cards untouched');
  const invalidMode = await recoveredBackground.send({ type: 'SET_LEARNING_MODE', learningMode: 'unknown' });
  assert.equal(invalidMode.ok, false, 'unsupported mode values are rejected');

  // Concurrent familiar-word changes are serialized and can be undone.
  await Promise.all([
    recoveredBackground.send({ type: 'SLASH_WORD', word: 'study' }),
    recoveredBackground.send({ type: 'SLASH_WORD', word: 'animal' }),
  ]);
  assert.deepEqual(new Set(storageData.familiarWords), new Set(['study', 'animal']), 'parallel slash operations do not overwrite each other');
  await recoveredBackground.send({ type: 'UNSLASH_WORD', word: 'study' });
  assert.deepEqual(storageData.familiarWords, ['animal'], 'undo removes the selected familiar word');

  const popupSource = fs.readFileSync(path.join(root, 'popup.js'), 'utf8');
  const popupFunction = (name) => {
    const match = popupSource.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
    assert(match, `popup function ${name} exists`);
    return match[0];
  };
  const popupSandbox = {
    selectedVocabulary: 'cet4', learningMode: 'normal', familiarWords: ['studies'], quizState: new Map(),
  };
  vm.runInNewContext([
    popupFunction('selectedWords'), popupFunction('modeWords'), popupFunction('activeWords'),
    popupFunction('questionLemma'), popupFunction('questionKey'), popupFunction('getQuizState'),
    'this.modeWords = modeWords; this.activeWords = activeWords; this.questionKey = questionKey; this.questionLemma = questionLemma; this.getQuizState = getQuizState;',
  ].join('\n'), popupSandbox);
  const uiWords = [
    { word: 'a', lemma: 'a', categories: ['cet4'], isBasic: true },
    { word: 'studies', lemma: 'study', categories: ['cet4', 'ielts'], isBasic: false },
    { word: 'aberration', lemma: 'aberration', categories: ['ielts'], isBasic: false },
  ];
  assert.deepEqual(Array.from(popupSandbox.modeWords(uiWords), (word) => word.word), ['studies'], 'normal mode hides basic words while keeping the selected vocabulary');
  popupSandbox.learningMode = 'quiz';
  assert.deepEqual(Array.from(popupSandbox.modeWords(uiWords), (word) => word.word), ['a', 'studies'], 'quiz mode includes basic words in the selected vocabulary');
  assert.deepEqual(Array.from(popupSandbox.activeWords(uiWords), (word) => word.word), ['a'], 'a familiar word remains hidden immediately in quiz mode');
  popupSandbox.selectedVocabulary = 'ielts';
  assert.deepEqual(Array.from(popupSandbox.modeWords(uiWords), (word) => word.word), ['studies', 'aberration'], 'mode filtering respects the selected IELTS vocabulary');
  assert.equal(popupSandbox.questionLemma(uiWords[1]), 'study', 'the question uses the prototype while the card keeps the surface form');
  assert.equal(popupSandbox.questionKey(uiWords[1]), 'ielts:study', 'quiz answer state is namespaced by selected vocabulary');
  const sessionState = popupSandbox.getQuizState('ielts:study');
  sessionState.wrong.add(1);
  assert.equal(popupSandbox.getQuizState('ielts:study').wrong.has(1), true, 'quiz interaction state survives rerenders within the popup session');
  assert(popupSource.includes("item.localService === true && /^en(?:-|$)/i.test(item.lang || '')"), 'speech only selects a local English voice');
  assert(popupSource.includes('没有可用的本地英语音色'), 'unavailable local voice has a visible explanation');
  assert(popupSource.includes('contextVersion !== quizContextVersion'), 'late quiz responses are ignored after mode or vocabulary changes');
  assert(popupSource.includes('navigationId !== navigationRequest'), 'late record responses are ignored after navigation');
  assert(popupSource.includes('!familiarWords.includes(word.word)'), 'live card updates suppress words already marked familiar');
  assert(popupSource.includes('const entries = selectedWords(familiarEntries)'), 'the undo page keeps familiar basic words reachable in normal mode');
  assert(popupSource.includes('该词暂无题目，可以点「详解」正常查词'), 'a missing question leaves the normal detail entry point available');

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

  console.log('Learning and subtitle pipeline mock checks passed: normal default, legacy/basic retention, phrase compatibility, lemma quiz lookup, category isolation, persistent mode, familiar undo/concurrency, cumulative merge, distinct forms, bounded/sorted timestamps, multi-tab merge, isolated videos, delayed durable acknowledgement, replay/recovery, serial competing writes, save-failure pause/retry, and legacy history.');
  console.log(`Synthetic 1,000 single-cue incremental messages: callback median ${callbackTimes[499].toFixed(3)} ms, P95 ${callbackTimes[949].toFixed(3)} ms; background match P95 ${benchmark.summary.match.p95.toFixed(3)} ms (Node VM + mock storage, excludes browser and popup rendering).`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
