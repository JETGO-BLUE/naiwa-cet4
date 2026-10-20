// background.js —— service worker：字幕分词/四级匹配/词形还原/联网查词/存储

'use strict';

// ============ 1. 词表加载（多词库合并） ============
// 把四级 / 六级 / 雅思 / 用户导入的词表合并成一张 {词: 释义}，另存一张 {词: [类别]}。
// 这样后面所有「匹配 / 词形还原 / 出题」都还按原来的写法跑，只是词表变大了。
let VOCAB = null;       // {词: 释义}
let VOCAB_CATS = null;  // {词: ['cet4','cet6','ielts','user:xxx']}
let CAT_COUNTS = null;  // {类别: 词数}
let USER_DICTS = null;  // {id: {id,name,words,count,importedAt}}
let vocabLoad = null;

// 内置词库（顺序即释义优先级：四级中文 > 补充中文 > 雅思英文）
const BUILTIN_DICTS = [
  { id: 'cet4', label: '四级', file: 'cet4_words.json' },
  { id: 'cet6', label: '六级', file: 'cet6_words.json' },
  { id: 'ielts', label: '雅思', file: 'ielts_words.json' },
];
const USER_DICTS_KEY = 'userDicts';
const PROGRESS_KEY = 'quizProgress'; // { [videoId]: {index, anchor, done, wrong} }
const MAX_USER_DICTS = 5;
const MAX_USER_DICT_BYTES = 3 * 1024 * 1024;

async function fetchJson(file) {
  const resp = await fetch(chrome.runtime.getURL(file));
  if (!resp.ok) throw new Error(file + ' 加载失败 ' + resp.status);
  return resp.json();
}

async function loadUserDicts() {
  if (USER_DICTS) return USER_DICTS;
  const d = await chrome.storage.local.get(USER_DICTS_KEY);
  USER_DICTS = d[USER_DICTS_KEY] || {};
  return USER_DICTS;
}

// 词表变了（导入 / 删除）就把所有缓存清掉，下次用到时重建
function invalidateVocab() {
  VOCAB = null;
  VOCAB_CATS = null;
  CAT_COUNTS = null;
  VOCAB_KEYS = null;
  USER_DICTS = null;
  vocabLoad = null;
}

async function loadVocab() {
  if (VOCAB) return VOCAB;
  if (vocabLoad) return vocabLoad;

  vocabLoad = (async () => {
    const vocab = Object.create(null);
    const cats = Object.create(null);
    const counts = Object.create(null);

    const pushCat = (w, c) => {
      if (!cats[w]) cats[w] = [];
      if (cats[w].indexOf(c) < 0) {
        cats[w].push(c);
        counts[c] = (counts[c] || 0) + 1;
      }
    };
    // force=true 才覆盖已有释义（只有四级中文有资格强制）
    const setMeaning = (w, m, force) => {
      if (!m) return;
      if (force || !vocab[w]) vocab[w] = m;
    };

    // 1) 四级：中文释义，优先级最高
    try {
      const cet4 = await fetchJson('cet4_words.json');
      for (const w of Object.keys(cet4)) {
        const k = w.toLowerCase();
        setMeaning(k, cet4[w], true);
        pushCat(k, 'cet4');
      }
    } catch (e) {
      console.error('[YT-CET4] 四级词表加载失败', e);
    }

    // 2) 补充中文释义：四级以外那些词的中文（让六级/雅思能离线出中文题）
    try {
      const extra = await fetchJson('vocab_extra_meanings.json');
      for (const w of Object.keys(extra)) setMeaning(w.toLowerCase(), extra[w], false);
    } catch (e) {
      /* 没有也能跑，只是六级/雅思会用英文释义 */
    }

    // 3) 六级：源数据只有词头，这里只提供「属于六级」这个事实
    try {
      const cet6 = await fetchJson('cet6_words.json');
      for (const w of Object.keys(cet6)) pushCat(w.toLowerCase(), 'cet6');
    } catch (e) {
      /* noop */
    }

    // 4) 雅思：英文释义作为兜底（已经有中文就不覆盖）
    try {
      const ielts = await fetchJson('ielts_words.json');
      for (const w of Object.keys(ielts)) {
        const k = w.toLowerCase();
        setMeaning(k, ielts[w], false);
        pushCat(k, 'ielts');
      }
    } catch (e) {
      /* noop */
    }

    // 5) 用户导入的词表：**以用户自己的释义为准**（force=true），
    //    因为是用户主动导入的，被内置释义盖掉会让人以为没导进来
    const users = await loadUserDicts();
    for (const id of Object.keys(users)) {
      const words = (users[id] && users[id].words) || {};
      for (const w of Object.keys(words)) {
        const k = w.toLowerCase();
        setMeaning(k, String(words[w] || '').slice(0, 200), true);
        pushCat(k, 'user:' + id);
      }
      counts['user:' + id] = Object.keys(words).length;
    }

    VOCAB = vocab;
    VOCAB_CATS = cats;
    CAT_COUNTS = counts;
    console.log(
      '[YT-CET4] 词表加载完成：合并 ' +
        Object.keys(vocab).length +
        ' 词（四级 ' + (counts.cet4 || 0) +
        ' / 六级 ' + (counts.cet6 || 0) +
        ' / 雅思 ' + (counts.ielts || 0) + '）'
    );
    return VOCAB;
  })();

  try {
    return await vocabLoad;
  } catch (e) {
    console.error('[YT-CET4] 词表加载失败', e);
    VOCAB = VOCAB || Object.create(null);
    VOCAB_CATS = VOCAB_CATS || Object.create(null);
    return VOCAB;
  }
}

// 当前选中的词库（存在本地，默认四级）
async function getSelectedDict() {
  const d = await chrome.storage.local.get('selectedDict');
  const sel = String(d.selectedDict || 'cet4');
  if (sel.indexOf('user:') === 0) {
    const users = await loadUserDicts();
    return users[sel.slice(5)] ? sel : 'cet4';
  }
  return BUILTIN_DICTS.some((m) => m.id === sel) ? sel : 'cet4';
}

// 给记录里的词补上「属于哪些词库」和缺失的释义。
// 这样旧记录不用重抓也能在六级/雅思模式下显示重叠的那部分词。
function decorateRecord(record) {
  if (!record || !Array.isArray(record.words) || !VOCAB_CATS) return record;
  for (const w of record.words) {
    if (!w || !w.word) continue;
    const key = String(w.word).toLowerCase();
    const lemmaKey = w.lemma ? String(w.lemma).toLowerCase() : key;
    w.cats = VOCAB_CATS[lemmaKey] || VOCAB_CATS[key] || [];
    if (!w.meaning) w.meaning = (VOCAB && (VOCAB[lemmaKey] || VOCAB[key])) || '';
  }
  return record;
}

// ============ 2. 词形还原（强化版） ============
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
  if (IRREGULAR[w]) return IRREGULAR[w];
  const L = w.length;

  // 优先用词表验证：如果原词就在词表，直接返回
  if (VOCAB && VOCAB[w]) return w;

  // -ies -> -y （studies -> study）
  if (L > 4 && w.endsWith('ies')) {
    const cand = w.slice(0, -3) + 'y';
    if (VOCAB && VOCAB[cand]) return cand;
    return cand;
  }
  // -es：分两种情况
  if (L > 3 && w.endsWith('es')) {
    const base = w.slice(0, -2); // 去掉 es
    // 先试 "去 es" 后的形式（boxes -> box）
    if (VOCAB && VOCAB[base]) return base;
    // 再试 "去 s"（makes -> make，其实是 make 的 s）
    const base2 = w.slice(0, -1); // 去掉 s
    if (VOCAB && VOCAB[base2]) return base2;
    // 补 e（makes -> make）
    const baseE = base + 'e';
    if (VOCAB && VOCAB[baseE]) return baseE;
    return base;
  }
  // -s -> 去掉（复数/三单）
  if (L > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is') && !w.endsWith('ous')) {
    const cand = w.slice(0, -1);
    if (VOCAB && VOCAB[cand]) return cand;
    return cand;
  }
  // -ing
  if (L > 5 && w.endsWith('ing')) {
    let stem = w.slice(0, -3);
    if (stem.length > 2 && stem[stem.length-1] === stem[stem.length-2]) {
      stem = stem.slice(0, -1); // running -> run
    }
    const candidates = [stem, stem + 'e'];
    for (const c of candidates) {
      if (VOCAB && VOCAB[c]) return c;
    }
    return stem;
  }
  // -ied -> -y （studied -> study）
  if (L > 4 && w.endsWith('ied')) {
    const cand = w.slice(0, -3) + 'y';
    if (VOCAB && VOCAB[cand]) return cand;
    return cand;
  }
  // -ed
  if (L > 4 && w.endsWith('ed')) {
    let stem = w.slice(0, -2);
    if (stem.length > 2 && stem[stem.length-1] === stem[stem.length-2]) {
      stem = stem.slice(0, -1); // stopped -> stop
    }
    const candidates = [stem, stem + 'e'];
    for (const c of candidates) {
      if (VOCAB && VOCAB[c]) return c;
    }
    return stem;
  }
  // -er 比较级（happier -> happy, bigger -> big）
  if (L > 4 && w.endsWith('er') && w.endsWith('ier') === false) {
    const base = w.slice(0, -2);
    if (VOCAB && VOCAB[base]) return base;
    if (VOCAB && VOCAB[base + 'e']) return base + 'e';
  }
  // -ier -> -y（happier -> happy）
  if (L > 4 && w.endsWith('ier')) {
    const cand = w.slice(0, -3) + 'y';
    if (VOCAB && VOCAB[cand]) return cand;
    return cand;
  }
  // 双写+er（bigger -> big）
  if (L > 5 && w.endsWith('er') && w[w.length-3] === w[w.length-4]) {
    const cand = w.slice(0, -3);
    if (VOCAB && VOCAB[cand]) return cand;
  }
  // -est 最高级
  if (L > 5 && w.endsWith('est')) {
    const base = w.slice(0, -3);
    if (VOCAB && VOCAB[base]) return base;
    if (VOCAB && VOCAB[base + 'e']) return base + 'e';
    if (base.endsWith('i')) return base.slice(0, -1) + 'y'; // happiest -> happy
  }
  return w;
}

// ============ 3. 四级词匹配（返回原词 + 匹配到的四级词根） ============
// 匹配：先直接命中，再还原后命中。返回 { surface: 原词, lemma: 词根, meaning }
function matchWord(word, vocabMap) {
  const w = word.toLowerCase();
  const catsOf = (k) => (VOCAB_CATS && VOCAB_CATS[k]) || [];
  if (vocabMap[w]) return { surface: w, lemma: w, meaning: vocabMap[w], cats: catsOf(w) };
  const lemma = lemmatize(w);
  if (lemma !== w && vocabMap[lemma]) {
    return { surface: w, lemma: lemma, meaning: vocabMap[lemma], cats: catsOf(lemma) };
  }
  return null;
}

// 从一条字幕提取四级词，返回原样 surface 词
function extractWords(text, vocabMap) {
  const found = new Set();
  const tokens = text.toLowerCase().split(/[^a-z']+/).filter(Boolean);
  for (const tok of tokens) {
    const clean = tok.replace(/^'+|'+$/g, '');
    if (clean.length < 2) continue;
    const m = matchWord(clean, vocabMap);
    if (m) found.add(m.surface); // 保留字幕原样
  }
  return Array.from(found);
}

// 秒数保留 1 位小数（时间点要用来跳转，所以存数值不存字符串；
// 显示成 "3:47" 这种格式交给 popup 做）
function round1(sec) {
  const n = Number(sec);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : 0;
}

// ============ 4. 字幕处理 ============
const MAX_TIMES = 10;        // 每个词最多保留 10 个时间点
const TIME_BUCKET_SEC = 180; // 时间点按「每 3 分钟」记录一次（3*60 秒一个区）

// 把一批 cues 分词/词形还原/分桶，产出 surface -> { word, lemma, meaning, cats, times[] }
// times 已经是「每 3 分钟区取最早、按区排序、最多 10 个」的数值秒。
// 全量重建和增量合并都复用它，保证两种路径算出来的结果一模一样。
function buildWordEntries(cues, vocabMap) {
  const wordMap = new Map(); // surface -> { meaning, lemma, cats, buckets: Map<区号, 精确秒> }

  for (const cue of cues) {
    const words = extractWords(cue.text, vocabMap);
    const bucket = Math.floor(cue.start / TIME_BUCKET_SEC); // 落在第几个 3 分钟区
    const at = round1(cue.start);                           // 这一句的精确起始秒
    for (const surface of words) {
      const m = matchWord(surface, vocabMap);
      if (!wordMap.has(surface)) {
        wordMap.set(surface, {
          meaning: m ? m.meaning : '',
          lemma: m ? m.lemma : surface,
          cats: m ? m.cats : [],
          buckets: new Map(),
        });
      }
      const bm = wordMap.get(surface).buckets;
      const prev = bm.get(bucket);
      // 一个 3 分钟区只记一次 —— 取该区里**最早出现那一句的精确时间**，不是区首
      if (prev === undefined || at < prev) bm.set(bucket, at);
    }
  }

  const entries = new Map();
  for (const [word, data] of wordMap) {
    const bucketIds = Array.from(data.buckets.keys()).sort((a, b) => a - b);
    entries.set(word, {
      word: word,          // 字幕原样
      lemma: data.lemma,   // 还原词根
      meaning: data.meaning,
      cats: data.cats,     // 命中哪些词库（四级/六级/雅思/自定义）
      // 每 3 分钟区一个时间点，记的是区内**精确出现时间**（如 3:47），最多 10 个
      // 存数值秒（number），popup 负责格式化成 "3:47" 并支持点击跳转
      times: bucketIds.slice(0, MAX_TIMES).map((b) => data.buckets.get(b)),
    });
  }
  return entries;
}

// 把已经存好的 times[]（数值秒）反推回「区号 -> 最早时间」，供增量合并用。
// 注意：如果某句字幕正好落在 3 分钟边界 ±0.05s 内，round1 可能把它推到相邻区，
// 反推会差一个区 —— 影响微乎其微（只对边界±50ms 的字幕），不值得为此改存储格式。
function timesToBuckets(times) {
  const m = new Map();
  for (const t of times || []) {
    const n = Number(t);
    if (!Number.isFinite(n)) continue;
    const b = Math.floor(n / TIME_BUCKET_SEC);
    if (!m.has(b) || n < m.get(b)) m.set(b, n);
  }
  return m;
}

function bucketsToTimes(bm) {
  return Array.from(bm.entries())
    .sort((a, b) => a[0] - b[0])
    .slice(0, MAX_TIMES)
    .map((e) => e[1]);
}

async function processCaptions(msg) {
  const vocabMap = await loadVocab();
  const { videoId, title, cues } = msg;

  const result = Array.from(buildWordEntries(cues, vocabMap).values());
  result.sort((a, b) => b.times.length - a.times.length);

  const key = 'video_' + videoId;
  const record = {
    videoId: videoId,
    title: title,
    words: result,
    totalWords: result.length,
    capturedAt: Date.now(),
    source: msg.source || 'unknown',
  };

  chrome.storage.local.set({ [key]: record });
  chrome.storage.local.set({ lastVideoId: videoId });
  return record;
}

// 增量采集：把「新句子」合并进已有记录，而不是每次全量重建。
// 合并按 (3分钟区, 时间) 取最早 —— **天然幂等**：同一条句子被重复发过来，
// 产生的还是同一个时间点，不会重复，所以这里不需要 wwj 那套 eventId/确认队列。
async function ingestDelta(msg) {
  const vocabMap = await loadVocab();
  const { videoId, title, cues } = msg;

  const delta = buildWordEntries(cues, vocabMap);

  const key = 'video_' + videoId;
  const data = await chrome.storage.local.get([key, 'lastVideoId']);
  const prev = data[key] || null;

  // 这一批没命中任何词，也把「当前视频」指针记一下，避免 popup 以为没在采
  if (delta.size === 0) {
    if (data.lastVideoId !== videoId) await chrome.storage.local.set({ lastVideoId: videoId });
    return prev ? decorateRecord(prev) : null;
  }

  const byWord = new Map();
  if (prev && Array.isArray(prev.words)) {
    for (const w of prev.words) if (w && w.word) byWord.set(w.word, w);
  }

  for (const [surface, entry] of delta) {
    const existing = byWord.get(surface);
    if (existing) {
      const bm = timesToBuckets(existing.times);
      for (const t of entry.times) {
        const b = Math.floor(Number(t) / TIME_BUCKET_SEC);
        if (!bm.has(b) || t < bm.get(b)) bm.set(b, t);
      }
      existing.times = bucketsToTimes(bm);
      if (!existing.meaning) existing.meaning = entry.meaning;
      if (!existing.cats || !existing.cats.length) existing.cats = entry.cats;
      if (!existing.lemma || existing.lemma === surface) existing.lemma = entry.lemma;
    } else {
      byWord.set(surface, entry);
    }
  }

  const words = Array.from(byWord.values());
  words.sort((a, b) => (b.times ? b.times.length : 0) - (a.times ? a.times.length : 0));

  const record = {
    videoId: videoId,
    title: title || (prev && prev.title) || '',
    words: words,
    totalWords: words.length,
    capturedAt: prev && prev.capturedAt ? prev.capturedAt : Date.now(),
    source: msg.source || (prev && prev.source) || 'immersive-translate',
  };

  await chrome.storage.local.set({ [key]: record, lastVideoId: videoId });
  return decorateRecord(record);
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

// 找词表内的同根词（共享词根，且存在于四级词表中）
function findCognates(lemma, vocabMap) {
  const results = new Set();
  const root = lemma.length > 5 ? lemma.slice(0, 5) : lemma;
  // 用前 4~6 个字母做词根前缀匹配，控制误报
  const prefixes = [];
  for (let n = Math.min(6, lemma.length); n >= 3; n--) {
    prefixes.push(lemma.slice(0, n));
  }
  for (const key of Object.keys(vocabMap)) {
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

// ============ 6. 出题（四选一，题库全本地、不联网） ============
let QUIZ = null;
async function loadQuiz() {
  if (QUIZ) return QUIZ;
  try {
    const url = chrome.runtime.getURL('quiz_bank.json');
    const resp = await fetch(url);
    QUIZ = await resp.json();
    console.log('[YT-CET4] 题库加载完成，共', Object.keys(QUIZ).length, '词');
    return QUIZ;
  } catch (e) {
    console.error('[YT-CET4] 题库加载失败，将用词表兜底出题', e);
    QUIZ = {};
    return QUIZ;
  }
}

let VOCAB_KEYS = null;
function vocabKeys(vocabMap) {
  if (!VOCAB_KEYS) VOCAB_KEYS = Object.keys(vocabMap);
  return VOCAB_KEYS;
}

// 确定性打乱：同一个词每次生成的选项顺序都一样。
// 不用 Math.random —— 否则每开一次弹窗答案位置就跳一次，
// 昨天记的「B 是答案」今天变 C，既影响记忆又让人怀疑自己。
// 做法：FNV-1a 把词本身哈希成种子，再跑固定种子的 Fisher-Yates。
function seededShuffle(values, seedText) {
  const arr = values.slice();
  let seed = 2166136261;
  const s = String(seedText || '');
  for (let i = 0; i < s.length; i++) {
    seed = Math.imul(seed ^ s.charCodeAt(i), 16777619) >>> 0;
  }
  for (let i = arr.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

// 给一个词生成单选题：正确的四级释义 1 个 + 形近/易混干扰释义 3 个，打乱顺序
function buildQuiz(word, vocabMap, bank) {
  const w = String(word || '').toLowerCase();
  const lemma = lemmatize(w);
  let base;
  if (vocabMap[w]) base = w;
  else if (vocabMap[lemma]) base = lemma;
  else return null;

  const correct = trimMeaning(vocabMap[base], 2) || vocabMap[base];
  const opts = [];
  const seen = new Set([correct]);

  // 1) 优先用预生成题库里的形近干扰词
  const ds = (bank && (bank[base] || bank[w])) || [];
  for (const d of ds) {
    if (opts.length >= 3) break;
    const dm = vocabMap[d];
    if (!dm) continue;
    const t = trimMeaning(dm, 2) || dm;
    if (seen.has(t)) continue;
    seen.add(t);
    opts.push(t);
  }

  // 2) 兜底：题库缺失或不足时，现场从词表按「首字母相同 → 长度相同」补
  const fill = (pred) => {
    for (const k of vocabKeys(vocabMap)) {
      if (opts.length >= 3) return;
      if (k === base || k === w) continue;
      if (pred && !pred(k)) continue;
      const t = trimMeaning(vocabMap[k], 2) || vocabMap[k];
      if (!t || seen.has(t)) continue;
      seen.add(t);
      opts.push(t);
    }
  };
  fill((k) => k[0] === base[0]);
  fill((k) => k[0] === base[0] || k.length === base.length);
  fill(null);

  const options = seededShuffle(opts.concat([correct]), base);
  return {
    word: w,
    base: base,
    lemma: lemma !== w ? lemma : null,
    correct: correct,
    options: options,
    answer: options.indexOf(correct),
  };
}

// ============ 6. 斩词 ============
async function slashWord(word) {
  const key = 'familiarWords';
  const data = await chrome.storage.local.get(key);
  let list = data[key] || [];
  if (!list.includes(word)) {
    list.push(word);
    await chrome.storage.local.set({ [key]: list });
  }
  return list;
}

async function unslashWord(word) {
  const key = 'familiarWords';
  const data = await chrome.storage.local.get(key);
  let list = (data[key] || []).filter((w) => w !== word);
  await chrome.storage.local.set({ [key]: list });
  return list;
}

// ============ 7. YouTube 原生字幕下载（备用通道的最后一步） ============
// 轨道地址由 youtube-bridge.js（跑在页面 MAIN world）提供 —— content script 在隔离世界，
// 读不到页面的 window.ytInitialPlayerResponse，以前那条路是死的。
// 下载放在这里而不是 content script：baseUrl 不一定与当前页面同源，
// service worker 有 host_permissions 兜底，不受页面 CORS 限制。
const YT_URL_RE = /^https:\/\/([\w-]+\.)?youtube(-nocookie)?\.com\//i;

function parseJson3Cues(data) {
  const out = [];
  const events = (data && data.events) || [];
  for (const ev of events) {
    if (!ev || !ev.segs || ev.tStartMs == null) continue;
    const text = ev.segs
      .map((s) => (s && s.utf8) || '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    const start = Number(ev.tStartMs) / 1000;
    if (!Number.isFinite(start) || start < 0) continue;
    out.push({ start: start, text: text.slice(0, 2000) });
    if (out.length >= 20000) break; // 防跑飞：超长字幕轨也不无限存
  }
  return out;
}

async function fetchYoutubeCaptionCues(trackUrl, expectedVideoId) {
  if (!YT_URL_RE.test(trackUrl)) throw new Error('字幕地址不在 YouTube 域名内');
  if (!/^[\w-]{6,32}$/.test(String(expectedVideoId || ''))) throw new Error('视频 ID 无效');
  const url = trackUrl + (trackUrl.indexOf('?') === -1 ? '?' : '&') + 'fmt=json3';
  const resp = await fetch(url, { credentials: 'omit' });
  if (!resp.ok) throw new Error('字幕请求失败 ' + resp.status);
  const cues = parseJson3Cues(await resp.json());
  if (cues.length === 0) throw new Error('字幕轨里没有可读文本');
  return cues;
}

// ============ 8. 消息路由 ============
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  (async () => {
    switch (msg.type) {
      case 'CAPTIONS': {
        const rec = await processCaptions(msg);
        sendResponse({ ok: true, record: decorateRecord(rec) });
        break;
      }

      // 增量：content 只发新句子，这里合并进已有记录（幂等，重复发不产生重复点）
      case 'CAPTIONS_DELTA': {
        const rec = await ingestDelta(msg);
        sendResponse({ ok: true, record: rec });
        break;
      }

      // 备用通道：桥接脚本给出轨道地址后，由这里下载并解析成 cues
      case 'FETCH_YOUTUBE_CAPTIONS': {
        try {
          const cues = await fetchYoutubeCaptionCues(msg.trackUrl, msg.expectedVideoId);
          sendResponse({ ok: true, cues: cues, count: cues.length });
        } catch (e) {
          sendResponse({ ok: false, error: String((e && e.message) || e) });
        }
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

      // 采集状态：content script 上报，popup 读出来显示成一行状态
      case 'CAPTURE_STATUS': {
        const st = {
          videoId: String(msg.videoId || '').slice(0, 64),
          title: String(msg.title || '').slice(0, 300),
          status: String(msg.status || 'waiting').slice(0, 24),
          detail: String(msg.detail || '').slice(0, 200),
          cueCount: Math.max(0, Number(msg.cueCount) || 0),
          saved: !!msg.saved,
          roundTripMs:
            msg.roundTripMs != null && Number.isFinite(Number(msg.roundTripMs))
              ? Math.round(Number(msg.roundTripMs))
              : null,
          at: Date.now(),
        };
        await chrome.storage.local.set({ captureStatus: st });
        sendResponse({ ok: true });
        break;
      }

      case 'GET_CAPTURE_STATUS': {
        const d = await chrome.storage.local.get('captureStatus');
        sendResponse({ ok: true, status: d.captureStatus || null });
        break;
      }

      // ---- 词库：列表 / 切换 / 导入 / 删除 ----
      case 'GET_VOCABULARIES': {
        await loadVocab();
        const users = await loadUserDicts();
        const selected = await getSelectedDict();
        const dicts = BUILTIN_DICTS.map((m) => ({
          id: m.id,
          label: m.label,
          kind: 'builtin',
          count: (CAT_COUNTS && CAT_COUNTS[m.id]) || 0,
        }));
        for (const id of Object.keys(users)) {
          dicts.push({
            id: 'user:' + id,
            label: String((users[id] && users[id].name) || '自定义'),
            kind: 'user',
            count: (CAT_COUNTS && CAT_COUNTS['user:' + id]) || 0,
          });
        }
        sendResponse({ ok: true, selected: selected, dicts: dicts });
        break;
      }

      case 'SET_VOCABULARY': {
        const id = String(msg.dictId || '');
        await loadVocab();
        const users = await loadUserDicts();
        const exists =
          BUILTIN_DICTS.some((m) => m.id === id) ||
          (id.indexOf('user:') === 0 && !!users[id.slice(5)]);
        if (!exists) {
          sendResponse({ ok: false, error: '词库不存在' });
          break;
        }
        await chrome.storage.local.set({ selectedDict: id });
        sendResponse({ ok: true, selected: id });
        break;
      }

      // 导入用户词表：popup 解析好 {词: 释义} 再发过来，这里只负责清洗和存
      case 'IMPORT_DICT': {
        const raw = msg.words;
        if (!raw || typeof raw !== 'object') {
          sendResponse({ ok: false, error: '词表数据无效' });
          break;
        }
        const clean = Object.create(null);
        let skipped = 0;
        for (const k of Object.keys(raw)) {
          const w = String(k).trim().toLowerCase();
          const m = String(raw[k] == null ? '' : raw[k]).trim();
          if (!/^[a-z][a-z'’-]{0,40}$/.test(w) || !m) {
            skipped++;
            continue;
          }
          clean[w] = m.slice(0, 200);
        }
        const count = Object.keys(clean).length;
        if (count === 0) {
          sendResponse({ ok: false, error: '没有解析出有效词条（需要「英文单词 + 释义」）' });
          break;
        }
        if (count > 5000) {
          sendResponse({ ok: false, error: '单次最多 5000 条，这次有 ' + count + ' 条' });
          break;
        }

        const users = await loadUserDicts();
        if (Object.keys(users).length >= MAX_USER_DICTS) {
          sendResponse({ ok: false, error: '最多同时保留 ' + MAX_USER_DICTS + ' 个自定义词表，先删一个再导入' });
          break;
        }
        const id = 'u' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
        const name =
          String(msg.name || '').trim().slice(0, 40) || '我的词表 ' + (Object.keys(users).length + 1);
        const next = Object.assign({}, users, {
          [id]: { id: id, name: name, words: clean, count: count, importedAt: Date.now() },
        });
        const bytes = JSON.stringify(next).length;
        if (bytes > MAX_USER_DICT_BYTES) {
          sendResponse({
            ok: false,
            error: '词表太大（约 ' + Math.round(bytes / 1024) + ' KB，上限约 3 MB），请精简后再导入',
          });
          break;
        }
        try {
          await chrome.storage.local.set({ [USER_DICTS_KEY]: next });
        } catch (e) {
          sendResponse({ ok: false, error: '保存失败，浏览器本地存储可能已满' });
          break;
        }
        invalidateVocab();
        sendResponse({
          ok: true,
          dict: { id: 'user:' + id, label: name, count: count, skipped: skipped },
        });
        break;
      }

      case 'DELETE_DICT': {
        const id = String(msg.id || '').replace(/^user:/, '');
        const users = await loadUserDicts();
        if (!users[id]) {
          sendResponse({ ok: false, error: '词表不存在' });
          break;
        }
        // 必须在删除前判断「当前选中的是不是它」，删完就查不出来了
        const selectedBefore = await getSelectedDict();
        const next = Object.assign({}, users);
        delete next[id];
        await chrome.storage.local.set({ [USER_DICTS_KEY]: next });
        invalidateVocab();
        if (selectedBefore === 'user:' + id) {
          await chrome.storage.local.set({ selectedDict: 'cet4' });
        }
        sendResponse({ ok: true });
        break;
      }

      // ---- 做题进度（每个视频一份：做到第几个 + 哪些答对/答错过） ----
      case 'GET_PROGRESS': {
        const videoId = String(msg.videoId || '');
        if (!videoId) {
          sendResponse({ ok: false, error: '视频 ID 无效' });
          break;
        }
        const d = await chrome.storage.local.get(PROGRESS_KEY);
        const all = d[PROGRESS_KEY] || {};
        sendResponse({ ok: true, progress: all[videoId] || null });
        break;
      }

      case 'SAVE_PROGRESS': {
        const videoId = String(msg.videoId || '');
        if (!/^[\w-]{1,64}$/.test(videoId)) {
          sendResponse({ ok: false, error: '视频 ID 无效' });
          break;
        }
        const done = {};
        const wrong = {};
        if (msg.done && typeof msg.done === 'object') {
          for (const k of Object.keys(msg.done)) {
            if (msg.done[k]) done[String(k).slice(0, 40)] = true; // 只收 truthy，防脏数据
          }
        }
        if (msg.wrong && typeof msg.wrong === 'object') {
          for (const k of Object.keys(msg.wrong)) {
            const arr = msg.wrong[k];
            if (Array.isArray(arr)) {
              wrong[String(k).slice(0, 40)] = arr
                .filter((n) => Number.isInteger(n) && n >= 0 && n < 4)
                .slice(0, 4);
            }
          }
        }
        // 尺寸保护：一个视频的进度不该大到离谱
        if (Object.keys(done).length > 5000 || Object.keys(wrong).length > 5000) {
          sendResponse({ ok: false, error: '进度数据过大' });
          break;
        }
        const index = Number.isFinite(Number(msg.index)) ? Math.max(0, Math.floor(Number(msg.index))) : 0;
        const anchor = String(msg.anchor || '').slice(0, 40);

        const d = await chrome.storage.local.get(PROGRESS_KEY);
        const all = d[PROGRESS_KEY] || {};
        all[videoId] = { index: index, anchor: anchor, done: done, wrong: wrong, at: Date.now() };
        await chrome.storage.local.set({ [PROGRESS_KEY]: all });
        sendResponse({ ok: true });
        break;
      }

      // ---- 学习方式：普通（直接看释义）/ 测试（四选一） ----
      case 'GET_LEARNING_MODE': {
        const d = await chrome.storage.local.get('learningMode');
        sendResponse({ ok: true, mode: d.learningMode === 'normal' ? 'normal' : 'quiz' });
        break;
      }

      case 'SET_LEARNING_MODE': {
        const mode = msg.mode === 'normal' ? 'normal' : 'quiz';
        await chrome.storage.local.set({ learningMode: mode });
        sendResponse({ ok: true, mode: mode });
        break;
      }

      case 'GET_STATUS': {
        const d = await chrome.storage.local.get('lastStatus');
        sendResponse({ ok: true, status: d.lastStatus || null });
        break;
      }

      // 本地数据（秒出）：原型、四级释义（精简）、单词变形、同根词
      case 'LOOKUP_LOCAL': {
        const vocabMap = await loadVocab();
        const word = (msg.word || '').toLowerCase();
        const lemma = lemmatize(word);
        const base = lemma !== word && vocabMap[lemma] ? lemma : (vocabMap[word] ? word : lemma);
        const rawMeaning = vocabMap[base] || '';
        const cognates = findCognates(base, vocabMap);
        sendResponse({
          ok: true,
          surface: word,
          lemma: lemma !== word ? lemma : null,
          base: base,
          cet4Meaning: trimMeaning(rawMeaning, 2),   // 精简：每词性最多 2 个常用释义
          inflections: inflect(base, rawMeaning),    // 单词变形（本地算，秒出）
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

      // 出题（本地题库）：给一批词各出 4 个中文释义选项
      case 'GET_QUIZ_BATCH': {
        const vocabMap = await loadVocab();
        const bank = await loadQuiz();
        const list = Array.isArray(msg.words) ? msg.words : [];
        const quizzes = {};
        for (const w of list) {
          const q = buildQuiz(w, vocabMap, bank);
          if (q) quizzes[w] = q;
        }
        sendResponse({ ok: true, quizzes: quizzes });
        break;
      }

      case 'GET_VIDEO': {
        const videoId = msg.videoId;
        const key = 'video_' + videoId;
        const data = await chrome.storage.local.get([key, 'familiarWords']);
        sendResponse({ ok: true, record: decorateRecord(data[key] || null), familiar: data.familiarWords || [] });
        break;
      }

      // 删除一条历史记录：只删「这条视频收集到的词」，不动已斩词
      case 'DELETE_VIDEO': {
        const videoId = String(msg.videoId || '');
        if (!/^[\w-]{1,64}$/.test(videoId)) {
          sendResponse({ ok: false, error: '视频 ID 无效' });
          break;
        }
        await chrome.storage.local.remove('video_' + videoId);
        // 同步删掉它的做题进度，避免留一份孤儿进度
        const pd = await chrome.storage.local.get(PROGRESS_KEY);
        const pall = pd[PROGRESS_KEY] || {};
        if (pall[videoId]) {
          delete pall[videoId];
          await chrome.storage.local.set({ [PROGRESS_KEY]: pall });
        }
        // 如果它正好是"上次打开的"，一并清掉指针，否则 popup 会一直去捞一个不存在的记录
        const d = await chrome.storage.local.get('lastVideoId');
        if (d.lastVideoId === videoId) await chrome.storage.local.remove('lastVideoId');
        sendResponse({ ok: true, videoId: videoId });
        break;
      }

      case 'GET_LAST_VIDEO': {
        const data = await chrome.storage.local.get(['lastVideoId', 'familiarWords']);
        const lastId = data.lastVideoId;
        let record = null;
        if (lastId) {
          const d2 = await chrome.storage.local.get('video_' + lastId);
          record = d2['video_' + lastId] || null;
        }
        sendResponse({ ok: true, record: decorateRecord(record), familiar: data.familiarWords || [], lastVideoId: lastId });
        break;
      }

      case 'SLASH_WORD': {
        const list = await slashWord(msg.word);
        sendResponse({ ok: true, familiar: list });
        break;
      }

      case 'UNSLASH_WORD': {
        const list = await unslashWord(msg.word);
        sendResponse({ ok: true, familiar: list });
        break;
      }

      case 'GET_FAMILIAR': {
        const data = await chrome.storage.local.get('familiarWords');
        sendResponse({ ok: true, familiar: data.familiarWords || [] });
        break;
      }

      case 'CLEAR_FAMILIAR': {
        await chrome.storage.local.remove('familiarWords');
        sendResponse({ ok: true, familiar: [] });
        break;
      }

      case 'GET_ALL_VIDEOS': {
        const all = await chrome.storage.local.get(null);
        const videos = Object.keys(all)
          .filter((k) => k.startsWith('video_'))
          .map((k) => all[k]);
        videos.sort((a, b) => b.capturedAt - a.capturedAt);
        sendResponse({ ok: true, videos: videos });
        break;
      }

      default:
        sendResponse({ ok: false, error: 'unknown type' });
    }
  })();

  return true;
});
