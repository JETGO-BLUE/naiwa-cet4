// background.js —— service worker：字幕分词/四级匹配/词形还原/联网查词/存储

'use strict';

// ============ 1. 四级词表加载 ============
let CET4 = null;
async function loadCET4() {
  if (CET4) return CET4;
  try {
    const url = chrome.runtime.getURL('cet4_words.json');
    const resp = await fetch(url);
    CET4 = await resp.json();
    console.log('[YT-CET4] 四级词表加载完成，共', Object.keys(CET4).length, '词');
    return CET4;
  } catch (e) {
    console.error('[YT-CET4] 词表加载失败', e);
    CET4 = {};
    return CET4;
  }
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
  if (CET4 && CET4[w]) return w;

  // -ies -> -y （studies -> study）
  if (L > 4 && w.endsWith('ies')) {
    const cand = w.slice(0, -3) + 'y';
    if (CET4 && CET4[cand]) return cand;
    return cand;
  }
  // -es：分两种情况
  if (L > 3 && w.endsWith('es')) {
    const base = w.slice(0, -2); // 去掉 es
    // 先试 "去 es" 后的形式（boxes -> box）
    if (CET4 && CET4[base]) return base;
    // 再试 "去 s"（makes -> make，其实是 make 的 s）
    const base2 = w.slice(0, -1); // 去掉 s
    if (CET4 && CET4[base2]) return base2;
    // 补 e（makes -> make）
    const baseE = base + 'e';
    if (CET4 && CET4[baseE]) return baseE;
    return base;
  }
  // -s -> 去掉（复数/三单）
  if (L > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is') && !w.endsWith('ous')) {
    const cand = w.slice(0, -1);
    if (CET4 && CET4[cand]) return cand;
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
      if (CET4 && CET4[c]) return c;
    }
    return stem;
  }
  // -ied -> -y （studied -> study）
  if (L > 4 && w.endsWith('ied')) {
    const cand = w.slice(0, -3) + 'y';
    if (CET4 && CET4[cand]) return cand;
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
      if (CET4 && CET4[c]) return c;
    }
    return stem;
  }
  // -er 比较级（happier -> happy, bigger -> big）
  if (L > 4 && w.endsWith('er') && w.endsWith('ier') === false) {
    const base = w.slice(0, -2);
    if (CET4 && CET4[base]) return base;
    if (CET4 && CET4[base + 'e']) return base + 'e';
  }
  // -ier -> -y（happier -> happy）
  if (L > 4 && w.endsWith('ier')) {
    const cand = w.slice(0, -3) + 'y';
    if (CET4 && CET4[cand]) return cand;
    return cand;
  }
  // 双写+er（bigger -> big）
  if (L > 5 && w.endsWith('er') && w[w.length-3] === w[w.length-4]) {
    const cand = w.slice(0, -3);
    if (CET4 && CET4[cand]) return cand;
  }
  // -est 最高级
  if (L > 5 && w.endsWith('est')) {
    const base = w.slice(0, -3);
    if (CET4 && CET4[base]) return base;
    if (CET4 && CET4[base + 'e']) return base + 'e';
    if (base.endsWith('i')) return base.slice(0, -1) + 'y'; // happiest -> happy
  }
  return w;
}

// ============ 3. 四级词匹配（返回原词 + 匹配到的四级词根） ============
// 匹配：先直接命中，再还原后命中。返回 { surface: 原词, lemma: 词根, meaning }
function matchCET4(word, cet4Map) {
  const w = word.toLowerCase();
  if (cet4Map[w]) return { surface: w, lemma: w, meaning: cet4Map[w] };
  const lemma = lemmatize(w);
  if (lemma !== w && cet4Map[lemma]) {
    return { surface: w, lemma: lemma, meaning: cet4Map[lemma] };
  }
  return null;
}

// 从一条字幕提取四级词，返回原样 surface 词
function extractCET4Words(text, cet4Map) {
  const found = new Set();
  const tokens = text.toLowerCase().split(/[^a-z']+/).filter(Boolean);
  for (const tok of tokens) {
    const clean = tok.replace(/^'+|'+$/g, '');
    if (clean.length < 2) continue;
    const m = matchCET4(clean, cet4Map);
    if (m) found.add(m.surface); // 保留字幕原样
  }
  return Array.from(found);
}

// 时间格式化
function fmtTime(sec) {
  sec = Math.floor(sec);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m + ':' + String(s).padStart(2, '0');
}

// ============ 4. 字幕处理 ============
const MAX_TIMES = 10; // 每个词最多保留前 10 个时间点

async function processCaptions(msg) {
  const cet4Map = await loadCET4();
  const { videoId, title, cues } = msg;

  const wordMap = new Map(); // surface -> { meaning, lemma, times }

  for (const cue of cues) {
    const words = extractCET4Words(cue.text, cet4Map);
    for (const surface of words) {
      const m = matchCET4(surface, cet4Map);
      if (!wordMap.has(surface)) {
        wordMap.set(surface, {
          meaning: m ? m.meaning : '',
          lemma: m ? m.lemma : surface,
          times: [],
        });
      }
      wordMap.get(surface).times.push(fmtTime(cue.start));
    }
  }

  const result = [];
  for (const [word, data] of wordMap) {
    const uniqueTimes = [];
    for (const t of data.times) {
      if (uniqueTimes[uniqueTimes.length - 1] !== t) uniqueTimes.push(t);
    }
    result.push({
      word: word,          // 字幕原样
      lemma: data.lemma,   // 还原词根
      meaning: data.meaning,
      times: uniqueTimes.slice(0, MAX_TIMES), // 只保留前 10 个
    });
  }

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
function findCognates(lemma, cet4Map) {
  const results = new Set();
  const root = lemma.length > 5 ? lemma.slice(0, 5) : lemma;
  // 用前 4~6 个字母做词根前缀匹配，控制误报
  const prefixes = [];
  for (let n = Math.min(6, lemma.length); n >= 3; n--) {
    prefixes.push(lemma.slice(0, n));
  }
  for (const key of Object.keys(cet4Map)) {
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

// ============ 7. 消息路由 ============
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  (async () => {
    switch (msg.type) {
      case 'CAPTIONS': {
        const rec = await processCaptions(msg);
        sendResponse({ ok: true, record: rec });
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

      // 本地数据（秒出）：原型、四级释义（精简）、单词变形、同根词
      case 'LOOKUP_LOCAL': {
        const cet4Map = await loadCET4();
        const word = (msg.word || '').toLowerCase();
        const lemma = lemmatize(word);
        const base = lemma !== word && cet4Map[lemma] ? lemma : (cet4Map[word] ? word : lemma);
        const rawMeaning = cet4Map[base] || '';
        const cognates = findCognates(base, cet4Map);
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

      case 'GET_VIDEO': {
        const videoId = msg.videoId;
        const key = 'video_' + videoId;
        const data = await chrome.storage.local.get([key, 'familiarWords']);
        sendResponse({ ok: true, record: data[key] || null, familiar: data.familiarWords || [] });
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
        sendResponse({ ok: true, record: record, familiar: data.familiarWords || [], lastVideoId: lastId });
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
