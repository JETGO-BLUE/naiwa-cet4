// background.js —— service worker：字幕分词/多词库匹配/词形还原/联网查词/存储

'use strict';

// ============ 1. 本地词表加载 ============
const VOCABULARIES = ['cet4', 'cet6', 'ielts'];
const LEARNING_MODES = ['normal', 'quiz'];
let WORD_INDEX = null;
let vocabularyLoad = null;
let vocabularyLoadDurationMs = null;
async function loadVocabularies() {
  if (WORD_INDEX) return WORD_INDEX;
  if (!vocabularyLoad) {
    vocabularyLoad = (async () => {
      const loadStartedAt = Date.now();
      const maps = await Promise.all(VOCABULARIES.map(async (category) => {
        const response = await fetch(chrome.runtime.getURL(category + '_words.json'));
        if (!response.ok) throw new Error(category + ' 词表加载失败，请重新加载扩展');
        const map = await response.json();
        if (!map || Array.isArray(map) || typeof map !== 'object' || !Object.keys(map).length ||
            Object.values(map).some((meaning) => typeof meaning !== 'string')) {
          throw new Error(category + ' 词表格式错误');
        }
        return map;
      }));
      const index = Object.create(null);
      maps.forEach((map, i) => {
        for (const [word, meaning] of Object.entries(map)) {
          if (!index[word]) index[word] = { meaning: '', categories: [] };
          index[word].categories.push(VOCABULARIES[i]);
          if (!index[word].meaning && meaning) index[word].meaning = meaning;
        }
      });
      WORD_INDEX = index;
      vocabularyLoadDurationMs = Date.now() - loadStartedAt;
      return index;
    })().catch((error) => {
      vocabularyLoad = null; // 修复文件后允许重试，避免把失败当成空词表。
      throw error;
    });
  }
  return vocabularyLoad;
}

// ============ 2. 基础词过滤 ============
// 词表保留完整内容；只在返回给界面时隐藏这些过于基础的词及其变形。
const BASIC_WORDS = new Set(
  `a an the i you he she it we they me him her us them
my your his its our their mine yours hers ours theirs
this that these those and or but so if as
to of in on at for from with by
be go have do get come take make say see know think
can could may might must shall should will would
not no yes very`.split(/\s+/)
);

function isBasicWord(word, lemma) {
  return BASIC_WORDS.has(String(word || '').toLowerCase()) ||
    BASIC_WORDS.has(String(lemma || '').toLowerCase());
}

async function filterRecordForDisplay(record) {
  if (!record) return null;
  const index = await loadVocabularies();
  const recordId = record.recordId || record.videoId || '';
  // 旧记录只补已有词的标签，不回写原始记录，也不假造未采集的词。
  // 普通/测试模式过滤只发生在 popup 展示层；基础词始终留在原始数据中。
  const words = (record.words || []).map((item) => {
    const match = matchVocabulary(item.word, index);
    const lemma = match ? match.lemma : item.lemma || item.word;
    return {
      ...item,
      lemma: match ? match.lemma : item.lemma,
      meaning: match ? match.meaning || item.meaning || '' : item.meaning || '',
      categories: match ? match.categories : item.categories || [],
      isBasic: isBasicWord(item.word, lemma),
    };
  });
  return {
    ...record,
    recordId: recordId,
    identityConfirmed: record.identityConfirmed == null
      ? !/^p[0-9a-z]{1,8}$/.test(recordId)
      : record.identityConfirmed !== false,
    words: words,
    totalWords: words.length,
    isLegacyVocabulary: !record.vocabularyVersion,
  };
}

async function getFamiliarWordsForDisplay() {
  const data = await chrome.storage.local.get('familiarWords');
  const index = await loadVocabularies();
  const entries = (data.familiarWords || []).map((word) => matchVocabulary(word, index))
    .filter(Boolean)
    .map((match) => ({
      word: match.surface,
      lemma: match.lemma,
      meaning: match.meaning,
      categories: match.categories,
      isBasic: isBasicWord(match.surface, match.lemma),
    }));
  return { familiar: entries.map((item) => item.word), familiarEntries: entries };
}

// ============ 3. 词形还原（强化版） ============
// 不规则动词完整表
const IRREGULAR = {
  // be
  am:'be',is:'be',are:'be',was:'be',were:'be',been:'be',being:'be',
  // have/do/go
  has:'have',had:'have',having:'have',does:'do',did:'do',done:'do',doing:'do',
  went:'go',gone:'go',going:'go',goes:'go',
  // 常见不规则动词
  became:'become',become:'become',began:'begin',begun:'begin',beginning:'begin',
  broke:'break',broken:'break',brought:'bring',built:'build',bought:'buy',
  caught:'catch',chose:'choose',chosen:'choose',came:'come',coming:'come',
  cost:'cost',cut:'cut',dealt:'deal',dug:'dig',drew:'draw',drawn:'draw',
  dreamt:'dream',dreamed:'dream',drank:'drink',drunk:'drink',drove:'drive',driven:'drive',
  ate:'eat',eaten:'eat',fell:'fall',fallen:'fall',felt:'feel',fought:'fight',
  found:'find',flew:'fly',flown:'fly',forgot:'forget',forgotten:'forget',
  forgave:'forgive',forgiven:'forgive',froze:'freeze',frozen:'freeze',
  got:'get',gotten:'get',getting:'get',gave:'give',given:'give',giving:'give',
  grew:'grow',grown:'grow',hung:'hang',heard:'hear',hid:'hide',hidden:'hide',
  hit:'hit',held:'hold',hurt:'hurt',kept:'keep',knew:'know',known:'know',
  laid:'lay',led:'lead',left:'leave',lent:'lend',let:'let',lay:'lie',
  lain:'lie',lying:'lie',lit:'light',lost:'lose',made:'make',making:'make',
  meant:'mean',met:'meet',paid:'pay',put:'put',read:'read',rode:'ride',ridden:'ride',
  rang:'ring',rung:'ring',rose:'rise',risen:'rise',ran:'run',running:'run',
  said:'say',saw:'see',seen:'see',sold:'sell',sent:'send',set:'set',
  shook:'shake',shaken:'shake',shone:'shine',shot:'shoot',showed:'show',shown:'show',
  shut:'shut',sang:'sing',sung:'sing',sank:'sink',sunk:'sink',sat:'sit',
  slept:'sleep',slid:'slide',spoke:'speak',spoken:'speak',spent:'spend',
  stood:'stand',stole:'steal',stolen:'steal',stuck:'stick',swam:'swim',swum:'swim',
  took:'take',taken:'take',taking:'take',taught:'teach',tore:'tear',torn:'tear',
  told:'tell',thought:'think',threw:'throw',thrown:'throw',understood:'understand',
  woke:'wake',woken:'wake',wore:'wear',worn:'wear',won:'win',wrote:'write',
  written:'write',writing:'write',
  // 常见不规则复数
  children:'child',men:'man',women:'woman',feet:'foot',teeth:'tooth',
  mice:'mouse',geese:'goose',people:'person',sheep:'sheep',fish:'fish',
  // 不规则比较级
  better:'good',best:'good',worse:'bad',worst:'bad',more:'much',most:'much',
  less:'little',least:'little',further:'far',furthest:'far',
};

// 规则还原（用词表查证兜底，避免误还原）
function lemmatize(word) {
  const w = word.toLowerCase();
  if (WORD_INDEX && WORD_INDEX[w]) return w;
  if (IRREGULAR[w]) return IRREGULAR[w];
  for (const [lemma, plural] of Object.entries(IRREG_NOUN)) {
    if (plural === w && WORD_INDEX && WORD_INDEX[lemma]) return lemma;
  }
  const L = w.length;
  const candidates = [];
  if (w.endsWith("'s")) candidates.push(w.slice(0, -2));
  if (L > 4 && /(?:ies|ied)$/.test(w)) candidates.push(w.slice(0, -3) + 'y');
  if (L > 3 && w.endsWith('es')) candidates.push(w.slice(0, -2), w.slice(0, -1));
  if (L > 3 && w.endsWith('s') && !/(?:ss|us|is|ous)$/.test(w)) candidates.push(w.slice(0, -1));
  for (const suffix of ['ing', 'ed', 'er', 'est']) {
    if (L <= suffix.length + 2 || !w.endsWith(suffix)) continue;
    const stem = w.slice(0, -suffix.length);
    candidates.push(stem, stem + 'e');
    if (stem.endsWith('i')) candidates.push(stem.slice(0, -1) + 'y');
    if (stem.length > 2 && stem.at(-1) === stem.at(-2)) candidates.push(stem.slice(0, -1));
  }
  for (const candidate of candidates) {
    if (WORD_INDEX && WORD_INDEX[candidate]) return candidate;
  }
  return w;
}

// ============ 3. 多词库匹配（一次返回全部命中类别） ============
const WORD_ALIASES = Object.freeze({
  'inasmuch as': 'inasmuchas',
  inasmuchas: 'inasmuchas',
});
const MEANING_OVERRIDES = Object.freeze({
  inasmuchas: '由于；鉴于；因为（字幕短语：inasmuch as）',
});

function matchVocabulary(word, index) {
  const w = word.toLowerCase();
  const lookup = WORD_ALIASES[w] || w;
  const lemma = index[lookup] ? lookup : lemmatize(lookup);
  return index[lemma] ? {
    surface: w,
    lemma: lemma,
    ...index[lemma],
    meaning: MEANING_OVERRIDES[lemma] || index[lemma].meaning,
  } : null;
}

// 从一条字幕提取词库并集，保留 surface 和连字符词。
function extractVocabularyWords(text, index) {
  const found = new Set();
  let normalized = text.toLowerCase().replace(/’/g, "'");
  // 兼容雅思来源中的历史词头 inasmuchas；字幕中的正常短语映射回旧词头。
  for (const phrase of ['inasmuch as']) {
    const matcher = /\binasmuch\s+as\b/g;
    if (matcher.test(normalized)) found.add(phrase);
    normalized = normalized.replace(matcher, ' ');
  }
  const tokens = normalized.match(/[a-z]+(?:['-][a-z]+)*/g) || [];
  for (const tok of tokens) {
    const parts = matchVocabulary(tok, index) ? [tok] : tok.split('-');
    for (const part of parts) {
      if (part.length < 1) continue;
      const match = matchVocabulary(part, index);
      if (match) found.add(match.surface);
    }
  }
  return Array.from(found);
}

// 时间格式化
function fmtTime(sec) {
  const rounded = Math.max(0, Math.round(Number(sec) * 10) / 10);
  const whole = Math.floor(rounded);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  const tenth = Math.round((rounded - whole) * 10);
  return m + ':' + String(s).padStart(2, '0') + (tenth ? '.' + tenth : '');
}

// ============ 4. 字幕处理 ============
const MAX_TIMES = 10; // 每个词最多保留前 10 个时间点

// Records are cached only while actively used/dirty. The worker may stop at any
// time; the page keeps unconfirmed events and re-sends them after reconnection.
const RECORD_SAVE_DELAY_MS = 500;
const RECORD_SAVE_MAX_WAIT_MS = 1000;
const MAX_SAVE_RETRIES = 3;
const MAX_CACHED_RECORDS = 32;
const MAX_EVENT_IDS = 2048;
const recordEntries = new Map();
const recordLoads = new Map();
const perfSamples = [];
const MAX_PERF_SAMPLES = 256;

function nowEpoch() {
  return typeof performance !== 'undefined' && Number.isFinite(performance.timeOrigin)
    ? performance.timeOrigin + performance.now()
    : Date.now();
}

function recordKey(recordId) {
  return 'video_' + recordId;
}

function validRecordId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value);
}

function addPerfSample(sample) {
  perfSamples.push(sample);
  if (perfSamples.length > MAX_PERF_SAMPLES) perfSamples.shift();
}

function percentile(values, pct) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * pct) - 1)];
}

function getPerfSummary() {
  const metric = (field) => {
    const values = perfSamples.filter((item) => Number.isFinite(item[field])).map((item) => item[field]);
    return { sampleCount: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95) };
  };
  return {
    captureToPopup: metric('captureToPopupMs'),
    captureToBackground: metric('inputLagMs'),
    match: metric('matchMs'),
    normalIncrementalMatch: metricForSource('matchMs', 'youtube-native', false),
    youtubeNativeMatch: metricForSource('matchMs', 'youtube-native', true),
    captureToSave: metric('captureToSaveMs'),
    save: metric('saveMs'),
    recordRestore: metric('recordRestoreMs'),
    youtubeCaptionFetch: metric('youtubeFetchMs'),
    vocabularyColdStartMs: vocabularyLoadDurationMs,
    clock: '跨上下文 epoch 毫秒；受浏览器时间精度限制，按回调采集起点计时',
  };
}

function metricForSource(field, source, matchesSource) {
  const values = perfSamples.filter((item) => Number.isFinite(item[field]) &&
    ((item.source === source) === matchesSource)).map((item) => item[field]);
  return { sampleCount: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95) };
}

function cloneRecord(record) {
  return JSON.parse(JSON.stringify(record));
}

function parseTimeSeconds(value) {
  const match = String(value || '').match(/^(\d+):(\d{2})(?:\.(\d))?$/);
  return match ? Number(match[1]) * 60 + Number(match[2]) + Number('0.' + (match[3] || '0')) : null;
}

function cleanRecord(record, recordId) {
  const base = record && typeof record === 'object' ? record : {};
  return {
    ...base,
    videoId: recordId,
    recordId: recordId,
    title: base.title || '',
    words: Array.isArray(base.words) ? base.words : [],
    totalWords: Array.isArray(base.words) ? base.words.length : 0,
    capturedAt: Number(base.capturedAt) || 0,
    version: Number(base.version) || 0,
    identityConfirmed: base.identityConfirmed == null
      ? !/^p[0-9a-z]{1,8}$/.test(recordId)
      : base.identityConfirmed !== false,
    processedEventIds: Array.isArray(base.processedEventIds) ? base.processedEventIds.slice(-MAX_EVENT_IDS) : [],
    vocabularyVersion: base.vocabularyVersion || 1,
  };
}

function trimRecordCache() {
  while (recordEntries.size > MAX_CACHED_RECORDS) {
    let removed = false;
    for (const [recordId, entry] of recordEntries) {
      if (entry.saveTimer || entry.savePromise || entry.dirty || entry.mergePromise) continue;
      recordEntries.delete(recordId);
      removed = true;
      break;
    }
    if (!removed) break;
  }
}

async function getRecordEntry(recordId) {
  if (recordEntries.has(recordId)) {
    const entry = recordEntries.get(recordId);
    recordEntries.delete(recordId);
    recordEntries.set(recordId, entry);
    return entry;
  }
  if (recordLoads.has(recordId)) return recordLoads.get(recordId);
  const loading = (async () => {
    trimRecordCache();
    if (recordEntries.size >= MAX_CACHED_RECORDS) {
      throw new Error('采集队列已满，先等待本地保存完成再继续。');
    }
    const key = recordKey(recordId);
    const restoreStartedAt = Date.now();
    const data = await chrome.storage.local.get(key);
    addPerfSample({ recordRestoreMs: Date.now() - restoreStartedAt });
    const record = cleanRecord(data[key], recordId);
    const wordIndex = new Map(record.words.map((word) => [String(word.word || '').toLowerCase(), word]));
    const processedEventIds = new Set(record.processedEventIds);
    const entry = {
      recordId,
      key,
      record,
      wordIndex,
      version: record.version,
      persistedVersion: record.version,
      dirty: false,
      dirtySince: 0,
      saveTimer: null,
      savePromise: null,
      saveRetries: 0,
      retryDelay: 0,
      savePaused: false,
      mergePromise: null,
      processedEventIds,
      eventOrder: record.processedEventIds.slice(),
      pendingEventIds: new Map(),
    };
    recordEntries.set(recordId, entry);
    return entry;
  })().finally(() => recordLoads.delete(recordId));
  recordLoads.set(recordId, loading);
  return loading;
}

function rememberEventId(entry, eventId) {
  const fingerprint = eventFingerprint(eventId);
  if (entry.processedEventIds.has(fingerprint)) return;
  entry.processedEventIds.add(fingerprint);
  entry.eventOrder.push(fingerprint);
  if (entry.eventOrder.length > MAX_EVENT_IDS) {
    const removed = entry.eventOrder.splice(0, entry.eventOrder.length - MAX_EVENT_IDS);
    for (const id of removed) entry.processedEventIds.delete(id);
  }
}

function eventFingerprint(eventId) {
  const value = String(eventId);
  let left = 2166136261;
  let right = 0x9e3779b9;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    left = Math.imul(left ^ code, 16777619);
    right = Math.imul(right ^ code, 2246822519);
  }
  return (left >>> 0).toString(16).padStart(8, '0') + (right >>> 0).toString(16).padStart(8, '0');
}

function getOwner(sender, sessionId) {
  return {
    tabId: sender && sender.tab ? sender.tab.id : null,
    sessionId: String(sessionId || ''),
  };
}

function sameOwner(a, b) {
  return a.tabId === b.tabId && a.sessionId === b.sessionId;
}

function addOwner(list, owner) {
  if (!list.some((item) => sameOwner(item, owner))) list.push(owner);
}

function sendPersisted(entry, eventIds, version) {
  const groups = new Map();
  for (const eventId of eventIds) {
    const pending = entry.pendingEventIds.get(eventId);
    if (!pending || pending.version > version) continue;
    for (const owner of pending.owners) {
      if (owner.tabId == null) continue;
      const key = owner.tabId + ':' + owner.sessionId;
      if (!groups.has(key)) groups.set(key, { owner, eventIds: [] });
      groups.get(key).eventIds.push(eventId);
    }
    entry.pendingEventIds.delete(eventId);
  }
  for (const { owner, eventIds: ids } of groups.values()) {
    chrome.tabs.sendMessage(owner.tabId, {
      type: 'PERSISTED',
      recordId: entry.recordId,
      sessionId: owner.sessionId,
      eventIds: ids,
      version,
    }, () => void chrome.runtime.lastError);
  }
}

function notifyPopup(message) {
  try {
    chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
  } catch (_) {}
}

function scheduleSave(entry, delayOverride) {
  if (entry.savePaused || entry.savePromise) return;
  clearTimeout(entry.saveTimer);
  const now = Date.now();
  const remainingMax = Math.max(0, entry.dirtySince + RECORD_SAVE_MAX_WAIT_MS - now);
  const delay = delayOverride == null ? Math.min(RECORD_SAVE_DELAY_MS, remainingMax) : delayOverride;
  entry.saveTimer = setTimeout(() => {
    entry.saveTimer = null;
    void persistRecord(entry);
  }, delay);
}

async function persistRecord(entry) {
  if (!entry.dirty || entry.savePaused) return;
  if (entry.savePromise) return entry.savePromise;
  clearTimeout(entry.saveTimer);
  entry.saveTimer = null;
  const version = entry.version;
  const eventIds = Array.from(entry.pendingEventIds.entries())
    .filter(([, pending]) => pending.version <= version)
    .map(([id]) => id);
  const snapshot = cloneRecord(entry.record);
  snapshot.processedEventIds = entry.eventOrder.slice(-MAX_EVENT_IDS);
  snapshot.words.sort((a, b) => (b.times || []).length - (a.times || []).length);
  snapshot.totalWords = snapshot.words.length;
  snapshot.version = version;
  const startedAt = nowEpoch();
  entry.savePromise = (async () => {
    try {
      await chrome.storage.local.set({ [entry.key]: snapshot, lastVideoId: entry.recordId });
      entry.persistedVersion = Math.max(entry.persistedVersion, version);
      entry.saveRetries = 0;
      entry.retryDelay = 0;
      entry.dirty = entry.version > version;
      if (!entry.dirty) entry.dirtySince = 0;
      const persistedEpoch = nowEpoch();
      for (const id of eventIds) {
        const pending = entry.pendingEventIds.get(id);
        if (!pending) continue;
        const duration = persistedEpoch - pending.capturedAtEpoch;
        if (Number.isFinite(duration) && duration >= 0) {
          addPerfSample({ saveMs: persistedEpoch - startedAt, captureToSaveMs: duration });
        }
      }
      sendPersisted(entry, eventIds, version);
      notifyPopup({
        type: 'RECORD_PERSISTED',
        recordId: entry.recordId,
        version: version,
        persistedVersion: entry.persistedVersion,
        savedAtEpoch: nowEpoch(),
      });
      if (entry.dirty) scheduleSave(entry, 0);
      else trimRecordCache();
    } catch (error) {
      entry.saveRetries += 1;
      entry.dirty = true;
      notifyPopup({
        type: 'RECORD_SAVE_FAILED',
        recordId: entry.recordId,
        version: version,
        error: '本地保存失败：' + (error && error.message ? error.message : '未知错误'),
        retries: entry.saveRetries,
      });
      if (entry.saveRetries >= MAX_SAVE_RETRIES) {
        entry.savePaused = true;
        notifyPopup({
          type: 'RECORD_SAVE_PAUSED',
          recordId: entry.recordId,
          error: '本地保存连续失败，采集已暂停。旧记录和未确认输入仍保留在打开的页面中。',
        });
      } else {
        entry.retryDelay = 500 * Math.pow(2, entry.saveRetries - 1);
      }
    } finally {
      entry.savePromise = null;
      if (entry.dirty && !entry.savePaused && !entry.saveTimer) {
        scheduleSave(entry, entry.retryDelay || 0);
        entry.retryDelay = 0;
      }
    }
  })();
  return entry.savePromise;
}

function cueTimeKey(seconds) {
  return Math.round(seconds * 10) / 10;
}

function mergeCueIntoEntry(entry, cue, index, changedWords) {
  const surfaces = extractVocabularyWords(cue.text, index);
  const timeKey = cueTimeKey(cue.start);
  const timeLabel = fmtTime(timeKey);
  for (const surface of surfaces) {
    const match = matchVocabulary(surface, index);
    if (!match) continue;
    let word = entry.wordIndex.get(surface);
    if (!word) {
      word = {
        word: surface,
        lemma: match.lemma,
        meaning: match.meaning || '',
        categories: match.categories || [],
        times: [],
      };
      entry.wordIndex.set(surface, word);
      entry.record.words.push(word);
    }
    const timeValues = (word.times || []).map(parseTimeSeconds).filter((value) => value != null);
    if (!timeValues.includes(timeKey)) {
      timeValues.push(timeKey);
      timeValues.sort((a, b) => a - b);
      word.times = timeValues.slice(0, MAX_TIMES).map(fmtTime);
      changedWords.set(surface, cloneRecord(word));
    } else if (!word.meaning || !word.categories || !word.categories.length) {
      word.lemma = match.lemma;
      word.meaning = match.meaning || word.meaning || '';
      word.categories = match.categories || [];
      changedWords.set(surface, cloneRecord(word));
    }
  }
}

function validCaptionEvents(events) {
  if (!Array.isArray(events) || events.length === 0 || events.length > 100) {
    throw new Error('字幕增量消息格式错误或单批数量超限');
  }
  const normalized = [];
  const seen = new Set();
  for (const item of events) {
    const cue = item && item.cue;
    if (!item || typeof item.eventId !== 'string' || item.eventId.length > 180 || seen.has(item.eventId)) continue;
    if (!cue || typeof cue.text !== 'string' || cue.text.length > 4000 || !Number.isFinite(Number(cue.start)) || Number(cue.start) < 0) continue;
    const text = cue.text.trim();
    if (!text) continue;
    seen.add(item.eventId);
    normalized.push({ eventId: item.eventId, cue: {
      text,
      start: Number(cue.start),
      capturedAtEpoch: Number.isFinite(Number(cue.capturedAtEpoch)) ? Number(cue.capturedAtEpoch) : undefined,
    } });
  }
  if (!normalized.length) throw new Error('没有有效字幕内容');
  return normalized;
}

async function ingestCaptionEvents(msg, sender, events) {
  const recordId = msg.recordId || msg.videoId;
  if (!validRecordId(recordId)) throw new Error('当前视频身份无效，字幕未保存');
  const owner = getOwner(sender, msg.sessionId);
  const entry = await getRecordEntry(recordId);
  if (entry.savePaused) throw new Error('本地保存连续失败，已暂停接收字幕。请先检查扩展存储空间后重新抓取。');
  const previousMerge = entry.mergePromise || Promise.resolve();
  const mergeTask = previousMerge.then(async () => {
    const acceptedIds = [];
    const replayIds = [];
    const newEvents = [];
    for (const item of events) {
      acceptedIds.push(item.eventId);
      if (entry.processedEventIds.has(eventFingerprint(item.eventId))) {
        if (entry.pendingEventIds.has(item.eventId)) {
          addOwner(entry.pendingEventIds.get(item.eventId).owners, owner);
        } else {
          replayIds.push(item.eventId);
        }
      } else if (!newEvents.some((event) => event.eventId === item.eventId)) {
        newEvents.push(item);
      }
    }
    if (replayIds.length && owner.tabId != null) {
      chrome.tabs.sendMessage(owner.tabId, {
        type: 'PERSISTED', recordId, sessionId: owner.sessionId,
        eventIds: replayIds, version: entry.persistedVersion,
      }, () => void chrome.runtime.lastError);
    }
    const receivedAtEpoch = nowEpoch();
    const matchStarted = nowEpoch();
    const index = await loadVocabularies();
    const changedWords = new Map();
    const capturedEpochs = [];
    if (newEvents.length) {
      for (const item of newEvents) {
        const capturedAtEpoch = Number(item.cue.capturedAtEpoch);
        if (Number.isFinite(capturedAtEpoch)) capturedEpochs.push(capturedAtEpoch);
        mergeCueIntoEntry(entry, item.cue, index, changedWords);
        rememberEventId(entry, item.eventId);
        entry.pendingEventIds.set(item.eventId, {
          version: 0,
          owners: [owner],
          capturedAtEpoch: Number.isFinite(capturedAtEpoch) ? capturedAtEpoch : receivedAtEpoch,
        });
      }
      entry.version += 1;
      entry.record.version = entry.version;
      entry.record.title = String(msg.title || entry.record.title || '').slice(0, 500);
      entry.record.identityConfirmed = msg.identityConfirmed !== false;
      entry.record.source = String(msg.source || entry.record.source || 'unknown').slice(0, 80);
      const sources = new Set(Array.isArray(entry.record.sources) ? entry.record.sources : []);
      sources.add(entry.record.source);
      entry.record.sources = Array.from(sources).slice(-8);
      entry.record.capturedAt = Date.now();
      entry.record.totalWords = entry.record.words.length;
      entry.record.processedEventIds = entry.eventOrder.slice(-MAX_EVENT_IDS);
      for (const item of newEvents) {
        const pending = entry.pendingEventIds.get(item.eventId);
        if (pending) pending.version = entry.version;
      }
      if (!entry.dirty) entry.dirtySince = Date.now();
      entry.dirty = true;
      scheduleSave(entry);
    }
    const matchedAtEpoch = nowEpoch();
    const earliestCapture = capturedEpochs.length ? Math.min(...capturedEpochs) : receivedAtEpoch;
    const matchMs = matchedAtEpoch - matchStarted;
    const inputLagMs = receivedAtEpoch - earliestCapture;
    addPerfSample({ matchMs, inputLagMs, source: String(msg.source || 'unknown') });
    const displayDelta = await filterRecordForDisplay({
      videoId: recordId,
      recordId,
      identityConfirmed: entry.record.identityConfirmed,
      words: Array.from(changedWords.values()),
    });
    const changedAtEpoch = nowEpoch();
    notifyPopup({
      type: 'RECORD_UPDATED',
      recordId,
      videoId: recordId,
      sessionId: msg.sessionId || '',
      tabId: sender && sender.tab ? sender.tab.id : null,
      title: entry.record.title,
      identityConfirmed: entry.record.identityConfirmed,
      version: entry.version,
      persistedVersion: entry.persistedVersion,
      totalWords: entry.record.words.length,
      changedWords: displayDelta ? displayDelta.words : [],
      matchedAtEpoch,
      capturedAtEpoch: earliestCapture,
      changedAtEpoch,
      source: entry.record.source,
      hadNewMatches: changedWords.size > 0,
    });
    return {
      ok: true,
      acceptedIds,
      recordId,
      version: entry.version,
      persistedVersion: entry.persistedVersion,
      matchedAtEpoch,
      hadNewMatches: changedWords.size > 0,
    };
  });
  entry.mergePromise = mergeTask;
  mergeTask.then(() => {
    if (entry.mergePromise === mergeTask) entry.mergePromise = null;
  }, () => {
    if (entry.mergePromise === mergeTask) entry.mergePromise = null;
  });
  return mergeTask;
}

async function processLegacyCaptions(msg, sender) {
  const cues = Array.isArray(msg.cues) ? msg.cues : [];
  if (!cues.length) throw new Error('没有字幕内容');
  const events = [];
  const prefix = 'legacy_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  for (let i = 0; i < cues.length; i += 1) {
    events.push({
      eventId: prefix + '_' + i,
      cue: { text: String(cues[i].text || ''), start: Number(cues[i].start) || 0, capturedAtEpoch: nowEpoch() },
    });
  }
  const recordId = msg.recordId || msg.videoId;
  return ingestCaptionEvents({
    ...msg,
    recordId,
    identityConfirmed: msg.identityConfirmed !== false,
    source: msg.source || 'legacy-batch',
  }, sender, events);
}

function youtubeVideoIdFromUrl(value) {
  try {
    const url = new URL(value);
    return url.searchParams.get('v') || (url.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]+)/) || [])[1] || '';
  } catch (_) { return ''; }
}

async function fetchYoutubeCaptionCues(trackUrl, expectedVideoId, sender) {
  const pageUrl = String(sender && (sender.url || sender.origin) || '');
  let page;
  let url;
  try {
    page = new URL(pageUrl);
    url = new URL(trackUrl);
  } catch (_) { throw new Error('YouTube 页面或字幕地址无效'); }
  if (page.protocol !== 'https:' || !/(^|\.)youtube\.com$/.test(page.hostname)) {
    throw new Error('字幕请求只允许从 YouTube 页面发起');
  }
  const pageVideoId = youtubeVideoIdFromUrl(page.href);
  if (!pageVideoId || pageVideoId !== expectedVideoId) throw new Error('当前 YouTube 视频已切换，已取消旧字幕请求');
  if (url.protocol !== 'https:' || !/(^|\.)youtube\.com$/.test(url.hostname) || url.pathname !== '/api/timedtext') {
    throw new Error('字幕地址未通过 YouTube 域名和路径校验');
  }
  if (!url.searchParams.has('fmt')) url.searchParams.set('fmt', 'json3');
  const response = await fetchWithTimeout(url.href, 20000);
  if (!response.ok) throw new Error('YouTube 字幕请求失败 HTTP ' + response.status);
  const contentLength = Number(response.headers && response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > 8 * 1024 * 1024) throw new Error('字幕轨响应超过 8 MB 上限');
  const text = await response.text();
  if (text.length > 8 * 1024 * 1024) throw new Error('字幕轨响应超过 8 MB 上限');
  let data;
  try { data = JSON.parse(text); } catch (_) { throw new Error('YouTube 字幕响应不是可读的 JSON3 格式'); }
  const cues = [];
  for (const event of (Array.isArray(data.events) ? data.events : [])) {
    if (!event || !Array.isArray(event.segs) || !Number.isFinite(Number(event.tStartMs))) continue;
    const cueText = event.segs.map((segment) => String(segment && segment.utf8 || '')).join(' ').replace(/\s+/g, ' ').trim();
    if (cueText) cues.push({ start: Number(event.tStartMs) / 1000, text: cueText });
    if (cues.length > 5000) throw new Error('字幕轨超过 5,000 条上限，未导入');
  }
  return cues;
}

// ============ 5. 词形变化生成器（本地，秒出，不联网） ============
// 不规则动词：lemma -> [过去式, 过去分词]
const IRREG_VERB = {
  be:['was','been'], have:['had','had'], do:['did','done'], go:['went','gone'],
  say:['said','said'], get:['got','got'], make:['made','made'], know:['knew','known'],
  take:['took','taken'], see:['saw','seen'], come:['came','come'], think:['thought','thought'],
  give:['gave','given'], find:['found','found'], tell:['told','told'], become:['became','become'],
  show:['showed','shown'], leave:['left','left'], feel:['felt','felt'], put:['put','put'],
  bring:['brought','brought'], begin:['began','begun'], keep:['kept','kept'], hold:['held','held'],
  write:['wrote','written'], stand:['stood','stood'], hear:['heard','heard'], let:['let','let'],
  mean:['meant','meant'], set:['set','set'], meet:['met','met'], run:['ran','run'],
  pay:['paid','paid'], sit:['sat','sat'], speak:['spoke','spoken'], lie:['lay','lain'],
  lead:['led','led'], read:['read','read'], grow:['grew','grown'], lose:['lost','lost'],
  fall:['fell','fallen'], send:['sent','sent'], build:['built','built'],
  understand:['understood','understood'], draw:['drew','drawn'], break:['broke','broken'],
  spend:['spent','spent'], cut:['cut','cut'], rise:['rose','risen'], drive:['drove','driven'],
  buy:['bought','bought'], wear:['wore','worn'], choose:['chose','chosen'], eat:['ate','eaten'],
  teach:['taught','taught'], catch:['caught','caught'], fight:['fought','fought'],
  throw:['threw','thrown'], forget:['forgot','forgotten'], sell:['sold','sold'],
  sleep:['slept','slept'], win:['won','won'], fly:['flew','flown'], steal:['stole','stolen'],
  shake:['shook','shaken'], sing:['sang','sung'], drink:['drank','drunk'], swim:['swam','swum'],
  ring:['rang','rung'], sink:['sank','sunk'], blow:['blew','blown'], freeze:['froze','frozen'],
  forgive:['forgave','forgiven'], hide:['hid','hidden'], ride:['rode','ridden'],
  wake:['woke','woken'], hang:['hung','hung'], dig:['dug','dug'], stick:['stuck','stuck'],
  deal:['dealt','dealt'], shine:['shone','shone'], shoot:['shot','shot'], slide:['slid','slid'],
  tear:['tore','torn'], shut:['shut','shut'], hit:['hit','hit'], hurt:['hurt','hurt'],
  cost:['cost','cost'], beat:['beat','beaten'], bite:['bit','bitten'], bind:['bound','bound'],
  bend:['bent','bent'], bet:['bet','bet'], bleed:['bled','bled'], breed:['bred','bred'],
  broadcast:['broadcast','broadcast'], burn:['burnt','burnt'], burst:['burst','burst'],
  cast:['cast','cast'], cling:['clung','clung'], creep:['crept','crept'],
  dream:['dreamt','dreamt'], feed:['fed','fed'], flee:['fled','fled'], fling:['flung','flung'],
  forbid:['forbade','forbidden'], forecast:['forecast','forecast'], grind:['ground','ground'],
  kneel:['knelt','knelt'], lean:['leant','leant'], leap:['leapt','leapt'], lend:['lent','lent'],
  light:['lit','lit'], overhear:['overheard','overheard'], quit:['quit','quit'],
  seek:['sought','sought'], shine2:null, shrink:['shrank','shrunk'], slay:['slew','slain'],
  smell:['smelt','smelt'], speed:['sped','sped'], spell:['spelt','spelt'],
  spill:['spilt','spilt'], spin:['spun','spun'], spit:['spat','spat'], split:['split','split'],
  spoil:['spoilt','spoilt'], spread:['spread','spread'], spring:['sprang','sprung'],
  strike:['struck','struck'], string:['strung','strung'], strive:['strove','striven'],
  swear:['swore','sworn'], sweep:['swept','swept'], swing:['swung','swung'],
  undertake:['undertook','undertaken'], upset:['upset','upset'], weave:['wove','woven'],
  weep:['wept','wept'], withdraw:['withdrew','withdrawn'], withstand:['withstood','withstood'],
  wring:['wrung','wrung'],
};
delete IRREG_VERB.shine2;

// 不规则名词复数
const IRREG_NOUN = {
  child:'children', man:'men', woman:'women', foot:'feet', tooth:'teeth',
  mouse:'mice', goose:'geese', person:'people', ox:'oxen', sheep:'sheep',
  deer:'deer', fish:'fish', knife:'knives', wife:'wives', life:'lives',
  leaf:'leaves', wolf:'wolves', half:'halves', self:'selves', shelf:'shelves',
  thief:'thieves', loaf:'loaves', calf:'calves', potato:'potatoes',
  tomato:'tomatoes', hero:'heroes', echo:'echoes', veto:'vetoes',
  phenomenon:'phenomena', criterion:'criteria', analysis:'analyses',
  basis:'bases', crisis:'crises', thesis:'theses', medium:'media',
  bacterium:'bacteria', curriculum:'curricula', appendix:'appendices',
  nucleus:'nuclei', stimulus:'stimuli', alumnus:'alumni', cactus:'cacti',
  fungus:'fungi', radius:'radii', syllabus:'syllabi',
};

// 不规则形容词比较级/最高级
const IRREG_ADJ = {
  good:['better','best'], well:['better','best'], bad:['worse','worst'],
  ill:['worse','worst'], far:['further','furthest'], little:['less','least'],
  many:['more','most'], much:['more','most'], old:['older','oldest'],
};

// 词尾是否是"辅音+元音+辅音"（双写规则），w/x/y 结尾不双写
function isCVC(w) {
  return /[^aeiou][aeiou][^aeiouwxy]$/.test(w);
}

function pluralize(w) {
  if (/[sxz]$|[cs]h$/.test(w)) return w + 'es';        // box→boxes, watch→watches
  if (/[^aeiou]y$/.test(w)) return w.slice(0,-1) + 'ies'; // city→cities
  if (/f$/.test(w)) return w.slice(0,-1) + 'ves';       // scarf→scarves（兜底规则）
  if (/fe$/.test(w)) return w.slice(0,-2) + 'ves';      // knife→knives
  return w + 's';
}

// 动词三单：在复数规则基础上，o 结尾 +es（go→goes, do→does）
function thirdForm(w) {
  if (/o$/.test(w)) return w + 'es';
  return pluralize(w);
}

function pastForm(w) {
  if (/e$/.test(w)) return w + 'd';                     // make→made(不规则表里), use→used
  if (/[^aeiou]y$/.test(w)) return w.slice(0,-1) + 'ied'; // study→studied
  if (w.length >= 3 && w.length <= 8 && isCVC(w)) return w + w.slice(-1) + 'ed'; // stop→stopped
  return w + 'ed';
}

function ingForm(w) {
  if (/ie$/.test(w)) return w.slice(0,-2) + 'ying';     // die→dying, lie→lying
  if (/[^e]e$/.test(w) && !/ee$|ye$|oe$/.test(w)) return w.slice(0,-1) + 'ing'; // make→making
  if (w.length >= 3 && w.length <= 8 && isCVC(w)) return w + w.slice(-1) + 'ing'; // run→running
  return w + 'ing';
}

function compForms(w) {
  if (/e$/.test(w)) return [w + 'r', w + 'st'];         // nice→nicer
  if (/[^aeiou]y$/.test(w)) return [w.slice(0,-1) + 'ier', w.slice(0,-1) + 'iest']; // happy→happier
  if (w.length >= 3 && w.length <= 5 && isCVC(w)) {
    return [w + w.slice(-1) + 'er', w + w.slice(-1) + 'est']; // big→bigger
  }
  if (w.length <= 5) return [w + 'er', w + 'est'];      // fast→faster
  return ['more ' + w, 'most ' + w];                    // beautiful→more beautiful
}

// 生成单词变形。meaning 用来判断词性，只展示相关变形
function inflect(word, meaning) {
  const w = word.toLowerCase();
  const out = {};
  const m = meaning || '';
  const isNoun = /(^|\s|&)(n)\./.test(m) || !m;
  const isVerb = /(^|\s|&)(v|vt|vi)\./.test(m) || !m;
  const isAdj = /(^|\s|&)(adj|a)\./.test(m);
  const isAdv = /(^|\s|&)(adv|ad)\./.test(m);

  if (isNoun) out['复数'] = IRREG_NOUN[w] || pluralize(w);
  if (isVerb) {
    out['第三人称单数'] = thirdForm(w);
    if (IRREG_VERB[w]) {
      out['过去式'] = IRREG_VERB[w][0];
      out['过去分词'] = IRREG_VERB[w][1];
    } else {
      out['过去式'] = pastForm(w);
      out['过去分词'] = out['过去式'];
    }
    out['现在分词'] = ingForm(w);
  }
  if (isAdj || isAdv) {
    if (IRREG_ADJ[w]) {
      out['比较级'] = IRREG_ADJ[w][0];
      out['最高级'] = IRREG_ADJ[w][1];
    } else if (w.length <= 7 || isAdj) {
      const c = compForms(w);
      out['比较级'] = c[0];
      out['最高级'] = c[1];
    }
  }
  return out;
}

// ============ 6. 释义精简（只留常用，删掉偏门） ============
// 每个词性只保留前 2 个释义；删掉带【】/(archaic)/(dated)/(obsolete)/(rare)/"古"/"废"标记的
const OBSCURE_RE = /【|\(archaic\)|\(dated\)|\(obsolete\)|\(rare\)|古[语旧]|废[语词]/i;

function trimMeaning(meaning, maxPerPos) {
  if (!meaning) return '';
  maxPerPos = maxPerPos || 2;
  // 按词性标记切段：n. v. vt. vi. adj. adv. prep. conj. pron. num. det. aux. int.
  const POS_RE = '(?:vt|vi|adj|adv|prep|conj|pron|num|det|aux|abbr|int|ad|n|v|a)';
  // 只在「段首 或 空格后」的词性标记处切段，n&vt. 这种复合标记不会被切开
  const segs = meaning.split(new RegExp('(?:(?<=^)|(?<=\\s))(?=' + POS_RE + '\\.)'));
  const kept = [];
  for (const seg of segs) {
    const s = seg.trim();
    if (!s) continue;
    // 先提取词性标记（如 "n." "vt." "n&vt."），防止删释义时把词性一起丢了
    const posMatch = s.match(new RegExp('^(' + POS_RE + '(?:&' + POS_RE + ')?\\.)\\s*'));
    const posTag = posMatch ? posMatch[1] : '';
    const body = posMatch ? s.slice(posMatch[0].length) : s;
    // 段内按 ； 分释义
    const senses = body.split(/[；;]/).map((x) => x.trim()).filter(Boolean);
    const good = [];
    for (const sense of senses) {
      if (OBSCURE_RE.test(sense)) continue;   // 偏门自动删
      good.push(sense);
      if (good.length >= maxPerPos) break;
    }
    if (good.length > 0) kept.push((posTag ? posTag + ' ' : '') + good.join('；'));
  }
  return kept.join(' ');
}

// ============ 7. 联网查词（双词典兜底 + 超时） ============
function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(t));
}

function trimOnlineMeanings(meanings, maxPos, maxDefPerPos) {
  const out = [];
  for (const m of (meanings || [])) {
    const defs = [];
    for (const d of (m.definitions || [])) {
      if (OBSCURE_RE.test(d.definition)) continue;
      defs.push(d);
      if (defs.length >= maxDefPerPos) break;
    }
    if (defs.length > 0) out.push({ partOfSpeech: m.partOfSpeech, definitions: defs });
    if (out.length >= maxPos) break;
  }
  return out;
}

const POS_SHORT = {
  Noun:'n.', Verb:'v.', Adjective:'adj.', Adverb:'adv.', Pronoun:'pron.',
  Preposition:'prep.', Conjunction:'conj.', Interjection:'int.', Numeral:'num.',
  Determiner:'det.', Article:'art.', Particle:'part.',
};

function stripHtml(s) {
  return String(s || '').replace(/<[^>]*>/g, '').trim();
}

// 源1：Free Dictionary API
async function lookupDictApi(word) {
  const url = 'https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(word);
  const resp = await fetchWithTimeout(url, 4000);
  if (!resp.ok) return { ok: false, error: 'HTTP ' + resp.status };
  const data = await resp.json();
  if (!Array.isArray(data) || data.length === 0) return { ok: false, error: 'empty' };
  const entry = data[0];
  const phonetic = entry.phonetic ||
    (entry.phonetics && entry.phonetics[0] && entry.phonetics[0].text) || '';
  const meanings = (entry.meanings || []).map((m) => ({
    partOfSpeech: m.partOfSpeech,
    definitions: (m.definitions || []).map((d) => ({
      definition: d.definition,
      example: d.example || '',
    })),
  }));
  return { ok: true, source: 'dictionaryapi', word: entry.word, phonetic: phonetic, meanings: trimOnlineMeanings(meanings, 4, 2) };
}

// 源2：Wiktionary REST（兜底，免费无需 key）
async function lookupWiktionary(word) {
  const url = 'https://en.wiktionary.org/api/rest_v1/page/definition/' + encodeURIComponent(word);
  const resp = await fetchWithTimeout(url, 5000);
  if (!resp.ok) return { ok: false, error: 'HTTP ' + resp.status };
  const data = await resp.json();
  const en = data.en || data['en'];
  if (!en || !Array.isArray(en) || en.length === 0) return { ok: false, error: 'empty' };
  const meanings = [];
  for (const block of en) {
    const pos = POS_SHORT[block.partOfSpeech] || block.partOfSpeech;
    const defs = (block.definitions || []).map((d) => ({
      definition: stripHtml(d.definition),
      example: '',
    })).filter((d) => d.definition);
    if (defs.length > 0) meanings.push({ partOfSpeech: pos, definitions: defs });
  }
  if (meanings.length === 0) return { ok: false, error: 'empty' };
  return { ok: true, source: 'wiktionary', word: word, phonetic: '', meanings: trimOnlineMeanings(meanings, 4, 2) };
}

// 主入口：先试源1，404/失败切源2，都挂返回失败（前端用本地释义兜底）
async function lookupWordOnline(word) {
  try {
    const r1 = await lookupDictApi(word);
    if (r1.ok) return r1;
  } catch (e) { /* 超时/网络错，走兜底 */ }
  try {
    const r2 = await lookupWiktionary(word);
    if (r2.ok) return r2;
    return { ok: false, error: '两个词典都未收录该词（404）' };
  } catch (e) {
    return { ok: false, error: '联网查询失败：' + e.message };
  }
}

// 找内置词表中的同根候选词（按前缀匹配）。
function findCognates(lemma, index) {
  const results = new Set();
  // 用前 4~6 个字母做词根前缀匹配，控制误报
  const prefixes = [];
  for (let n = Math.min(6, lemma.length); n >= 3; n--) {
    prefixes.push(lemma.slice(0, n));
  }
  for (const key of Object.keys(index)) {
    if (key === lemma) continue;
    for (const p of prefixes) {
      if (key.startsWith(p) && Math.abs(key.length - lemma.length) <= 6) {
        results.add(key);
        break;
      }
    }
  }
  // 限制数量，按长度接近排序取前 12 个
  const arr = Array.from(results);
  arr.sort((a, b) => Math.abs(a.length - lemma.length) - Math.abs(b.length - lemma.length));
  return arr.slice(0, 12);
}

// ============ 6. 斩词 ============
let familiarMutationQueue = Promise.resolve();

function updateFamiliarWords(mutator) {
  const task = familiarMutationQueue.then(async () => {
    const data = await chrome.storage.local.get('familiarWords');
    const list = Array.isArray(data.familiarWords) ? data.familiarWords.slice() : [];
    const next = mutator(list);
    await chrome.storage.local.set({ familiarWords: next });
    return next;
  });
  familiarMutationQueue = task.catch(() => {});
  return task;
}

async function slashWord(word) {
  return updateFamiliarWords((list) => {
    if (!list.includes(word)) list.push(word);
    return list;
  });
}

async function unslashWord(word) {
  return updateFamiliarWords((list) => list.filter((item) => item !== word));
}

async function clearFamiliarWords() {
  return updateFamiliarWords(() => []);
}

let QUIZ_BANK = null;
let QUIZ_EXTRAS = null;
let quizDataLoad = null;

async function loadQuizData() {
  if (QUIZ_BANK && QUIZ_EXTRAS) return { bank: QUIZ_BANK, extras: QUIZ_EXTRAS };
  if (!quizDataLoad) {
    quizDataLoad = Promise.all(['quiz_bank.json', 'quiz_extras.json'].map(async (file) => {
      const response = await fetch(chrome.runtime.getURL(file));
      if (!response.ok) throw new Error(file + ' 加载失败');
      return response.json();
    })).then(([bank, extras]) => {
      if (!bank || Array.isArray(bank) || typeof bank !== 'object' ||
          !extras || Array.isArray(extras) || typeof extras !== 'object') {
        throw new Error('题库文件格式错误');
      }
      QUIZ_BANK = bank;
      QUIZ_EXTRAS = extras;
      return { bank, extras };
    }).catch((error) => {
      quizDataLoad = null;
      throw error;
    });
  }
  return quizDataLoad;
}

function deterministicShuffle(values, seedText) {
  const shuffled = values.slice();
  let seed = 2166136261;
  for (const character of String(seedText)) seed = Math.imul(seed ^ character.charCodeAt(0), 16777619);
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function normalizeQuizMeaning(value) {
  return String(value || '').replace(/[\s，,。；;：:、\/（）()\[\]【】]/g, '').toLowerCase();
}

function quizPartOfSpeech(meaning) {
  const match = String(meaning || '').match(/^(vt|vi|adj|adv|prep|conj|pron|num|det|aux|abbr|int|ad|n|v|a)(?:&(?:vt|vi|adj|adv|prep|conj|pron|num|det|aux|abbr|int|ad|n|v|a))?\./i);
  return match ? match[0].toLowerCase() : '';
}

function meaningForQuizWord(word, index) {
  const item = index[word];
  return item ? trimMeaning(item.meaning, 2) || item.meaning || '' : '';
}

function buildQuizQuestion(surface, category, index, bank, extras) {
  const match = matchVocabulary(surface, index);
  if (!match || !match.categories.includes(category)) return null;
  const lemma = match.lemma;
  const extra = extras[lemma];
  let correct;
  let distractors;
  let source;
  let distractorWords = [];
  if (extra && typeof extra.correct === 'string' && Array.isArray(extra.distractors)) {
    correct = extra.correct;
    distractors = extra.distractors;
    source = extra.meaningSource || 'generated';
    distractorWords = extra.distractorWords || [];
  } else {
    const sourceDistractorWords = bank[lemma];
    if (!Array.isArray(sourceDistractorWords) || sourceDistractorWords.length !== 3) return null;
    correct = meaningForQuizWord(lemma, index);
    const selectedWords = [];
    distractors = [];
    const usedMeanings = new Set([normalizeQuizMeaning(correct)]);
    const addDistractor = (word) => {
      const meaning = meaningForQuizWord(word, index);
      const key = normalizeQuizMeaning(meaning);
      if (!meaning || !key || usedMeanings.has(key)) return false;
      selectedWords.push(word);
      distractors.push(meaning);
      usedMeanings.add(key);
      return true;
    };
    sourceDistractorWords.forEach(addDistractor);
    if (distractors.length < 3) {
      const correctPos = quizPartOfSpeech(correct);
      const candidates = deterministicShuffle(Object.keys(index).filter((word) =>
        word !== lemma && index[word].categories.includes('cet4') && !sourceDistractorWords.includes(word)),
      'cet4-fallback:' + lemma);
      for (const candidate of candidates) {
        if (correctPos && quizPartOfSpeech(meaningForQuizWord(candidate, index)) !== correctPos) continue;
        addDistractor(candidate);
        if (distractors.length === 3) break;
      }
      if (distractors.length < 3) {
        for (const candidate of candidates) {
          addDistractor(candidate);
          if (distractors.length === 3) break;
        }
      }
    }
    if (distractors.length !== 3) return null;
    source = selectedWords.some((word) => !sourceDistractorWords.includes(word))
      ? 'upstream-cet4-quiz-bank+runtime-dedup'
      : 'upstream-cet4-quiz-bank';
    distractorWords = selectedWords;
  }
  const unique = new Set([correct, ...distractors].map(normalizeQuizMeaning));
  if (!correct || distractors.length !== 3 || unique.size !== 4 || Array.from(unique).some((value) => !value)) return null;
  const options = deterministicShuffle([correct, ...distractors], category + ':' + lemma);
  return {
    lemma,
    correct,
    options,
    correctIndex: options.indexOf(correct),
    meaningSource: source,
    distractorWords,
  };
}

// ============ 7. 消息路由 ============
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  (async () => {
    switch (msg.type) {
      case 'CAPTIONS': {
        const result = await processLegacyCaptions(msg, sender);
        sendResponse(result);
        break;
      }

      case 'CAPTIONS_DELTA': {
        const events = validCaptionEvents(msg.events);
        const result = await ingestCaptionEvents(msg, sender, events);
        sendResponse(result);
        break;
      }

      case 'CAPTURE_STATUS': {
        notifyPopup({
          type: 'CAPTURE_STATUS',
          tabId: sender && sender.tab ? sender.tab.id : null,
          recordId: msg.recordId || msg.videoId || null,
          sessionId: msg.sessionId || null,
          statusSequence: Number(msg.statusSequence) || 0,
          title: String(msg.title || '').slice(0, 500),
          identityConfirmed: msg.identityConfirmed !== false,
          status: msg.status || 'waiting',
          source: msg.source || '',
          detail: String(msg.detail || '').slice(0, 300),
          atEpoch: nowEpoch(),
        });
        sendResponse({ ok: true });
        break;
      }

      case 'FETCH_YOUTUBE_CAPTIONS': {
        if (typeof msg.trackUrl !== 'string' || typeof msg.expectedVideoId !== 'string') {
          throw new Error('YouTube 字幕请求参数无效');
        }
        const startedAt = Date.now();
        let cues;
        try {
          cues = await fetchYoutubeCaptionCues(msg.trackUrl, msg.expectedVideoId, sender);
        } finally {
          addPerfSample({ youtubeFetchMs: Date.now() - startedAt });
        }
        sendResponse({ ok: true, cues: cues, count: cues.length });
        break;
      }

      case 'RETRY_SAVE': {
        const recordId = msg.recordId;
        const entry = recordId && recordEntries.get(recordId);
        if (entry) {
          entry.savePaused = false;
          entry.saveRetries = 0;
          if (entry.dirty) scheduleSave(entry, 0);
        }
        sendResponse({ ok: true });
        break;
      }

      case 'PERF_SAMPLE': {
        const captureToPopupMs = Number(msg.captureToPopupMs);
        if (Number.isFinite(captureToPopupMs) && captureToPopupMs >= 0 && captureToPopupMs < 60000) {
          addPerfSample({ captureToPopupMs });
        }
        const inputToBackgroundMs = Number(msg.inputToBackgroundMs);
        if (Number.isFinite(inputToBackgroundMs) && inputToBackgroundMs >= 0 && inputToBackgroundMs < 60000) {
          addPerfSample({ inputToBackgroundMs });
        }
        sendResponse({ ok: true });
        break;
      }

      case 'GET_PERF': {
        sendResponse({ ok: true, summary: getPerfSummary() });
        break;
      }

      case 'NO_CAPTIONS': {
        // 记录"无字幕"状态，让 popup 能显示原因
        await chrome.storage.local.set({
          lastStatus: { type: 'no_captions', videoId: msg.videoId, title: msg.title, at: Date.now() },
        });
        sendResponse({ ok: true });
        break;
      }

      case 'ERROR': {
        await chrome.storage.local.set({
          lastStatus: { type: 'error', videoId: msg.videoId, error: msg.error, at: Date.now() },
        });
        sendResponse({ ok: true });
        break;
      }

      case 'GET_STATUS': {
        const d = await chrome.storage.local.get('lastStatus');
        sendResponse({ ok: true, status: d.lastStatus || null });
        break;
      }

      case 'GET_VOCABULARY': {
        await loadVocabularies();
        const data = await chrome.storage.local.get(['selectedVocabulary', 'learningMode']);
        const selectedVocabulary = VOCABULARIES.includes(data.selectedVocabulary) ? data.selectedVocabulary : 'cet4';
        const learningMode = LEARNING_MODES.includes(data.learningMode) ? data.learningMode : 'normal';
        sendResponse({ ok: true, selectedVocabulary, learningMode });
        break;
      }

      case 'SET_VOCABULARY': {
        if (!VOCABULARIES.includes(msg.selectedVocabulary)) throw new Error('不支持的词库');
        await chrome.storage.local.set({ selectedVocabulary: msg.selectedVocabulary });
        sendResponse({ ok: true, selectedVocabulary: msg.selectedVocabulary });
        break;
      }

      case 'SET_LEARNING_MODE': {
        if (!LEARNING_MODES.includes(msg.learningMode)) throw new Error('不支持的学习模式');
        await chrome.storage.local.set({ learningMode: msg.learningMode });
        sendResponse({ ok: true, learningMode: msg.learningMode });
        break;
      }

      case 'GET_QUIZ_BATCH': {
        const category = VOCABULARIES.includes(msg.vocabulary) ? msg.vocabulary : 'cet4';
        const index = await loadVocabularies();
        const { bank, extras } = await loadQuizData();
        const words = Array.isArray(msg.words) ? msg.words.slice(0, 500) : [];
        const quizzes = {};
        for (const rawWord of words) {
          const word = String(rawWord || '').toLowerCase();
          const match = matchVocabulary(word, index);
          if (!match) continue;
          const question = buildQuizQuestion(word, category, index, bank, extras);
          if (question) quizzes[word] = question;
        }
        sendResponse({ ok: true, vocabulary: category, quizzes });
        break;
      }

      // 本地数据：原型、全部类别、词表释义、单词变形、同根词
      case 'LOOKUP_LOCAL': {
        const index = await loadVocabularies();
        const word = (msg.word || '').toLowerCase();
        const match = matchVocabulary(word, index);
        const base = match ? match.lemma : word;
        const rawMeaning = match ? match.meaning : '';
        const cognates = findCognates(base, index);
        sendResponse({
          ok: true,
          surface: word,
          lemma: base !== word ? base : null,
          base: base,
          categories: match ? match.categories : [],
          localMeaning: trimMeaning(rawMeaning, 2),
          inflections: rawMeaning ? inflect(base, rawMeaning) : {},
          cognates: cognates,
        });
        break;
      }

      // 联网数据（慢）：各词性精简释义，双词典兜底
      case 'LOOKUP_ONLINE': {
        const word = (msg.word || '').toLowerCase();
        const online = await lookupWordOnline(word);
        sendResponse({ ok: true, online: online });
        break;
      }

      case 'GET_VIDEO': {
        const videoId = msg.recordId || msg.videoId;
        if (!validRecordId(videoId)) throw new Error('视频记录标识无效');
        const key = recordKey(videoId);
        let rawRecord;
        const cached = recordEntries.get(videoId);
        if (cached) rawRecord = cached.record;
        else {
          const data = await chrome.storage.local.get(key);
          rawRecord = data[key] || null;
        }
        sendResponse({
          ok: true,
          record: await filterRecordForDisplay(rawRecord),
          version: cached ? cached.version : (rawRecord && rawRecord.version) || 0,
          persistedVersion: cached ? cached.persistedVersion : (rawRecord && rawRecord.version) || 0,
          saveFailed: !!(cached && cached.savePaused),
          ...await getFamiliarWordsForDisplay(),
        });
        break;
      }

      case 'GET_LAST_VIDEO': {
        const data = await chrome.storage.local.get(['lastVideoId', 'familiarWords']);
        const lastId = data.lastVideoId;
        let record = null;
        if (lastId) {
          const cached = recordEntries.get(lastId);
          if (cached) record = await filterRecordForDisplay(cached.record);
          else {
            const d2 = await chrome.storage.local.get(recordKey(lastId));
            record = await filterRecordForDisplay(d2[recordKey(lastId)] || null);
          }
        }
        sendResponse({ ok: true, record: record, ...await getFamiliarWordsForDisplay(), lastVideoId: lastId });
        break;
      }

      case 'SLASH_WORD': {
        await slashWord(msg.word);
        sendResponse({ ok: true, ...await getFamiliarWordsForDisplay() });
        break;
      }

      case 'UNSLASH_WORD': {
        await unslashWord(msg.word);
        sendResponse({ ok: true, ...await getFamiliarWordsForDisplay() });
        break;
      }

      case 'GET_FAMILIAR': {
        sendResponse({ ok: true, ...await getFamiliarWordsForDisplay() });
        break;
      }

      case 'CLEAR_FAMILIAR': {
        await clearFamiliarWords();
        sendResponse({ ok: true, familiar: [], familiarEntries: [] });
        break;
      }

      case 'GET_ALL_VIDEOS': {
        const all = await chrome.storage.local.get(null);
        const raw = new Map(Object.keys(all)
          .filter((k) => k.startsWith('video_'))
          .map((key) => [key.slice(6), all[key]]));
        for (const [recordId, entry] of recordEntries) raw.set(recordId, entry.record);
        const videos = await Promise.all(Array.from(raw.values()).map((item) => filterRecordForDisplay(item)));
        videos.sort((a, b) => b.capturedAt - a.capturedAt);
        sendResponse({ ok: true, videos: videos });
        break;
      }

      default:
        sendResponse({ ok: false, error: 'unknown type' });
    }
  })().catch((error) => {
    console.error('[Naiwa] 消息处理失败', error);
    sendResponse({ ok: false, error: error.message || '处理失败，请重新加载扩展' });
  });

  return true;
});
