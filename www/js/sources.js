// Catalogue sources. Each source implements the same small interface
// (popular, latest, genre, search, book, ping) and returns the same book shape,
// so the app can fall through to the next source when one fails.
//
// Book shape: { id, iaId, lvId, title, author, cover, coverHi, coverCors, secs, lang,
//               src, desc, readers, link, chapters: [{title, url, secs}] }
import { settings, bus, cacheGet, cacheSet, mergeBook } from './store.js';
import { stripHtml } from './util.js';

const IA = 'https://archive.org';
const LV = 'https://librivox.org/api/feed/audiobooks';
export const PAGE = 24;

export const GENRES = [
  { key: 'fiction', label: 'General Fiction', lv: 'General Fiction', ia: 'fiction' },
  { key: 'mystery', label: 'Mystery & Crime', lv: 'Crime & Mystery Fiction', ia: 'mystery OR detective OR crime' },
  { key: 'scifi', label: 'Science Fiction', lv: 'Science Fiction', ia: '"science fiction"' },
  { key: 'fantasy', label: 'Fantasy', lv: 'Fantastic Fiction', ia: 'fantasy OR "fairy tales"' },
  { key: 'adventure', label: 'Adventure', lv: 'Action & Adventure Fiction', ia: 'adventure' },
  { key: 'horror', label: 'Horror & Gothic', lv: 'Horror & Supernatural Fiction', ia: 'horror OR gothic OR supernatural OR ghost' },
  { key: 'romance', label: 'Romance', lv: 'Romance', ia: 'romance' },
  { key: 'children', label: 'Children', lv: "Children's Fiction", ia: 'children OR juvenile' },
  { key: 'poetry', label: 'Poetry', lv: 'Poetry', ia: 'poetry OR poems' },
  { key: 'history', label: 'History', lv: 'History', ia: 'history' },
  { key: 'philosophy', label: 'Philosophy', lv: 'Philosophy', ia: 'philosophy' },
  { key: 'humour', label: 'Humour', lv: 'Humorous Fiction', ia: 'humor OR humour OR comedy OR satire' },
  { key: 'plays', label: 'Plays', lv: 'Plays', ia: 'plays OR drama' },
  { key: 'short', label: 'Short Stories', lv: 'Short Stories', ia: '"short stories"' },
  { key: 'bio', label: 'Biography', lv: 'Biography & Autobiography', ia: 'biography OR autobiography OR memoirs' },
];

export const LANGS = [
  { key: 'any', label: 'Any language' },
  { key: 'en', label: 'English', ia: ['eng', 'English'] },
  { key: 'fr', label: 'French', ia: ['fre', 'fra', 'French'] },
  { key: 'de', label: 'German', ia: ['ger', 'deu', 'German'] },
  { key: 'es', label: 'Spanish', ia: ['spa', 'Spanish'] },
  { key: 'it', label: 'Italian', ia: ['ita', 'Italian'] },
  { key: 'ar', label: 'Arabic', ia: ['ara', 'Arabic'] },
];
const lang = () => LANGS.find(l => l.key === settings.lang) || LANGS[0];
const langName = v => {
  const s = String(Array.isArray(v) ? v[0] : v || '');
  const hit = LANGS.find(l => l.ia && l.ia.some(x => x.toLowerCase() === s.toLowerCase()));
  return hit ? hit.label : s;
};

// archive.org answers cross-origin requests on the bare host only, not on www.
const fixUrl = u => (u ? String(u).replace(/^http:/, 'https:').replace('//www.archive.org/', '//archive.org/') : '');
const iaIdOf = u => { const m = /archive\.org\/(?:details|download)\/([^/?#]+)/.exec(u || ''); return m ? decodeURIComponent(m[1]) : ''; };
const mkId = (iaId, lvId) => (iaId ? 'ia_' + iaId : 'lv_' + lvId);
const iaTile = id => `${IA}/services/img/${encodeURIComponent(id)}`;
const iaFile = (id, name) => `${IA}/download/${encodeURIComponent(id)}/${String(name).split('/').map(encodeURIComponent).join('/')}`;

function parseLen(v) {
  if (v == null) return 0;
  const s = String(Array.isArray(v) ? v[0] : v).trim();
  if (!s) return 0;
  if (s.includes(':')) return s.split(':').reduce((a, p) => a * 60 + (parseFloat(p) || 0), 0);
  return parseFloat(s) || 0;
}

async function getJson(url, ms = 10000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { signal: c.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'timed out' : (e.message || 'network error'));
  } finally { clearTimeout(t); }
}

// LibriVox sends no cross-origin headers, so its documented JSONP format is used.
let cbSeq = 0;
function jsonp(url, ms = 12000) {
  return new Promise((res, rej) => {
    const cb = '__hark_cb' + (++cbSeq);
    const s = document.createElement('script');
    const done = (fn, v) => { clearTimeout(t); delete window[cb]; s.remove(); fn(v); };
    const t = setTimeout(() => { window[cb] = () => {}; done(rej, new Error('timed out')); }, ms);
    window[cb] = d => done(res, d);
    s.onerror = () => done(rej, new Error('no answer'));
    s.src = `${url}&callback=${cb}`;
    document.head.append(s);
  });
}

// ---------- Internet Archive ----------
function iaBase() {
  const l = lang();
  return 'collection:librivoxaudio' + (l.ia ? ` AND language:(${l.ia.map(x => `"${x}"`).join(' OR ')})` : '');
}
const lucene = q => q.replace(/[+\-&|!(){}\[\]^"~*?:\\\/]/g, ' ').trim().split(/\s+/).filter(Boolean).join(' ');

async function iaList(q, sort, page) {
  const fl = ['identifier', 'title', 'creator', 'language', 'runtime'].map(f => 'fl%5B%5D=' + f).join('&');
  const u = `${IA}/advancedsearch.php?q=${encodeURIComponent(q)}&${fl}&sort%5B%5D=${encodeURIComponent(sort)}&rows=${PAGE}&page=${page}&output=json`;
  const d = await getJson(u);
  const docs = d && d.response && d.response.docs;
  if (!Array.isArray(docs)) throw new Error('bad answer');
  return docs.map(x => ({
    id: mkId(x.identifier), iaId: x.identifier, lvId: '',
    title: String(Array.isArray(x.title) ? x.title[0] : x.title || 'Untitled'),
    author: Array.isArray(x.creator) ? x.creator.join(', ') : (x.creator || ''),
    cover: iaTile(x.identifier), secs: parseLen(x.runtime), lang: langName(x.language), src: 'archive',
  }));
}

function cleanIaDesc(html) {
  let t = stripHtml(html);
  const cut = t.search(/For (further|more) information/i);
  if (cut > 40) t = t.slice(0, cut);
  return t.replace(/^LibriVox recording of [^\n]*\n+/i, '').replace(/Download M4B[^\n]*/gi, '').trim();
}

const archive = {
  key: 'archive', name: 'Internet Archive', host: 'archive.org',
  popular: page => iaList(iaBase(), 'downloads desc', page),
  latest: page => iaList(iaBase(), 'publicdate desc', page),
  genre: (g, page) => iaList(`${iaBase()} AND subject:(${g.ia})`, 'downloads desc', page),
  search(q, page) {
    const s = lucene(q);
    if (!s) return Promise.resolve([]);
    return iaList(`${iaBase()} AND (title:(${s}) OR creator:(${s}))`, 'downloads desc', page);
  },
  async book(b) {
    if (!b.iaId) throw new Error('not listed here');
    const d = await getJson(`${IA}/metadata/${encodeURIComponent(b.iaId)}`, 14000);
    const m = d && d.metadata;
    const files = (d && d.files) || [];
    if (!m) throw new Error('not found');
    let set = [];
    for (const f of ['64Kbps MP3', '128Kbps MP3', 'VBR MP3', 'MP3']) {
      set = files.filter(x => x.format === f);
      if (set.length) break;
    }
    if (!set.length) set = files.filter(x => /\.mp3$/i.test(x.name));
    if (!set.length) throw new Error('no audio files');
    const trk = f => parseInt(f.track, 10) || 0;
    const allTracked = set.every(trk);
    set.sort((a, c) => (allTracked ? trk(a) - trk(c) : 0) || a.name.localeCompare(c.name, undefined, { numeric: true }));
    const chapters = set.map((f, i) => ({
      title: String(f.title || f.name.replace(/\.mp3$/i, '').replace(/_/g, ' ') || `Part ${i + 1}`),
      url: iaFile(b.iaId, f.name),
      secs: parseLen(f.length),
    }));
    const pic = fmt => files.find(x => x.format === fmt && /\.(jpe?g|png)$/i.test(x.name));
    const full = pic('JPEG'), thumb = pic('JPEG Thumb');
    const lvId = /^\d+$/.test(String(m.call_number || '')) ? String(m.call_number) : '';
    return {
      id: b.id || mkId(b.iaId), iaId: b.iaId, lvId,
      title: String(Array.isArray(m.title) ? m.title[0] : m.title || b.title || 'Untitled'),
      author: Array.isArray(m.creator) ? m.creator.join(', ') : (m.creator || b.author || ''),
      cover: iaTile(b.iaId),
      coverHi: full ? iaFile(b.iaId, full.name) : '',
      coverCors: thumb ? iaFile(b.iaId, thumb.name) : (full ? iaFile(b.iaId, full.name) : ''),
      desc: cleanIaDesc(Array.isArray(m.description) ? m.description.join('\n') : m.description),
      secs: chapters.reduce((a, c) => a + c.secs, 0) || parseLen(m.runtime),
      lang: langName(m.language), link: `${IA}/details/${encodeURIComponent(b.iaId)}`,
      src: 'archive', chapters,
    };
  },
  ping: () => getJson(`${IA}/advancedsearch.php?q=identifier%3Afrankenstein_shelley&fl%5B%5D=identifier&rows=1&output=json`, 8000),
};

// ---------- LibriVox ----------
const LV_FIELDS = '{id,title,authors,url_iarchive,url_librivox,totaltimesecs,language,num_sections,coverart_thumbnail,coverart_jpg}';
function lvUrl(params, detail) {
  const p = new URLSearchParams(Object.assign({ format: 'jsonp', coverart: '1', extended: '1' }, params));
  return `${LV}?${p}` + (detail ? '' : '&fields=' + encodeURIComponent(LV_FIELDS));
}
function lvBook(x) {
  const iaId = iaIdOf(x.url_iarchive);
  const thumb = fixUrl(x.coverart_thumbnail);
  return {
    id: mkId(iaId, x.id), iaId, lvId: String(x.id),
    title: String(x.title || 'Untitled'),
    author: (x.authors || []).map(a => `${a.first_name || ''} ${a.last_name || ''}`.trim()).filter(Boolean).join(', '),
    cover: thumb || (iaId ? iaTile(iaId) : ''), coverHi: fixUrl(x.coverart_jpg), coverCors: thumb,
    secs: Number(x.totaltimesecs) || 0, lang: x.language || '', link: x.url_librivox || '', src: 'librivox',
  };
}
async function lvList(params) {
  const d = await jsonp(lvUrl(params));
  const arr = Array.isArray(d && d.books) ? d.books : Object.values((d && d.books) || {});
  const l = lang();
  return arr.map(lvBook).filter(b => !l.ia || b.lang === l.label);
}
const lvPage = page => ({ limit: String(PAGE), offset: String((page - 1) * PAGE) });

const librivox = {
  key: 'librivox', name: 'LibriVox', host: 'librivox.org',
  // LibriVox has no popularity ranking, so its newest titles stand in when it is the only source left.
  popular: page => lvList(Object.assign({ sort_order: 'desc' }, lvPage(page))),
  latest: page => lvList(Object.assign({ sort_order: 'desc' }, lvPage(page))),
  genre: (g, page) => lvList(Object.assign({ genre: g.lv, sort_order: 'desc' }, lvPage(page))),
  async search(q, page) {
    // The API matches the start of a title (leading articles dropped) or an author's surname.
    const words = q.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const title = words.join(' ').replace(/^(the|a|an)\s+/i, '');
    const res = await Promise.allSettled([
      lvList(Object.assign({ title: '^' + title }, lvPage(page))),
      lvList(Object.assign({ author: words[words.length - 1] }, lvPage(page))),
    ]);
    if (res.every(r => r.status === 'rejected')) {
      // LibriVox answers "no results" the same way a dead server would, so check it is alive.
      if (res.some(r => r.reason.message !== 'no answer')) throw res[0].reason;
      await librivox.ping();
      return [];
    }
    const seen = new Set(), out = [];
    for (const r of res) if (r.status === 'fulfilled') for (const b of r.value) if (!seen.has(b.id)) { seen.add(b.id); out.push(b); }
    return out;
  },
  async book(b) {
    if (!b.lvId) throw new Error('not listed here');
    const d = await jsonp(lvUrl({ id: b.lvId }, true), 14000);
    const x = Array.isArray(d && d.books) ? d.books[0] : Object.values((d && d.books) || {})[0];
    if (!x) throw new Error('not found');
    const secs = Array.isArray(x.sections) ? x.sections : Object.values(x.sections || {});
    const chapters = secs.filter(s => s.listen_url).map((s, i) => ({
      title: String(s.title || `Part ${i + 1}`), url: fixUrl(s.listen_url), secs: Number(s.playtime) || 0,
    }));
    if (!chapters.length) throw new Error('no audio files');
    const names = [...new Set(secs.flatMap(s => (s.readers || []).map(r => r.display_name)).filter(Boolean))];
    return Object.assign(lvBook(x), {
      id: b.id || lvBook(x).id,
      desc: stripHtml(x.description),
      readers: names.length > 3 ? `${names.slice(0, 2).join(', ')} and ${names.length - 2} others` : names.join(', '),
      chapters,
    });
  },
  ping: () => jsonp(lvUrl({ id: '381' }), 8000),
};

// ---------- manager: ordering, health, fallback, caching ----------
export const providers = { archive, librivox };
export const health = {}; // key -> { ok, ms, err, at }

function mark(key, ok, ms, err) {
  health[key] = { ok, ms: Math.round(ms || 0), err: err ? String(err.message || err) : '', at: Date.now() };
  bus.emit('health', key);
}

/** Enabled sources in the user's order; a source that failed in the last minute is tried last. */
export function order() {
  const on = settings.sourceOrder.filter(k => providers[k] && !settings.sourceOff[k]);
  const sick = k => health[k] && !health[k].ok && Date.now() - health[k].at < 60000;
  return [...on.filter(k => !sick(k)), ...on.filter(sick)];
}

async function run(cap, args) {
  const keys = order();
  if (!keys.length) throw new Error('Every source is switched off in Settings.');
  let last;
  for (const k of keys) {
    const t0 = performance.now();
    try {
      const v = await providers[k][cap](...args);
      mark(k, true, performance.now() - t0);
      return { v, via: k };
    } catch (e) {
      if (e.message !== 'not listed here') mark(k, false, 0, e);
      last = e;
    }
  }
  throw new Error(navigator.onLine === false ? 'You are offline.' : `No source answered (${last ? last.message : 'unknown error'}).`);
}

const mem = new Map();
const FRESH = 6 * 3600 * 1000;

/** kind: 'popular' | 'latest' | 'genre' | 'search'. Returns { items, via, stale }. */
export async function list(kind, arg, page = 1) {
  const key = `${kind}:${arg || ''}:${settings.lang}:${page}`;
  if (mem.has(key)) return mem.get(key);
  const persist = page === 1 && kind !== 'search';
  const cached = persist ? cacheGet(key) : null;
  if (cached && Date.now() - cached.t < FRESH) { mem.set(key, cached.v); return cached.v; }
  try {
    const a = kind === 'genre' ? [GENRES.find(g => g.key === arg), page] : kind === 'search' ? [arg, page] : [page];
    const { v, via } = await run(kind, a);
    const out = { items: v, via };
    mem.set(key, out);
    if (persist && v.length) cacheSet(key, out);
    return out;
  } catch (e) {
    if (cached) return Object.assign({ stale: true }, cached.v); // offline: show the last list we saw
    throw e;
  }
}

/** Last list we saw for a shelf, if any, so the home screen can paint before the network answers. */
export function peek(kind, arg) {
  const c = cacheGet(`${kind}:${arg || ''}:${settings.lang}:1`);
  return c ? c.v : null;
}

export function clearListCache() { mem.clear(); }

/** Fills in description and chapter list, trying each source that knows the book. */
export async function getBook(summary) {
  const { v, via } = await run('book', [summary]);
  const out = mergeBook(summary, v);
  out.id = summary.id;
  out.via = via;
  return out;
}

export function bookFromId(id) {
  return id.startsWith('ia_') ? { id, iaId: id.slice(3), lvId: '' } : { id, iaId: '', lvId: id.slice(3) };
}

export async function testAll() {
  await Promise.all(Object.keys(providers).map(async k => {
    const t0 = performance.now();
    try { await providers[k].ping(); mark(k, true, performance.now() - t0); }
    catch (e) { mark(k, false, 0, e); }
  }));
}
