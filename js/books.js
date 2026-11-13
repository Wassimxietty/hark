// Ebooks: two free catalogues (Standard Ebooks, and Project Gutenberg as mirrored by the
// Internet Archive), turning their files into clean chapters, and importing your own files.
//
// Ebook shape: { id, kind:'text', src:'se'|'pg'|'file', title, author, cover, lang, link, desc, subjects }
// Stored text: { id, sections: [{ title, html, len }], chars }
import { settings, cacheGet, cacheSet, mergeBook, texts } from './store.js';
import { GENRES } from './sources.js';

const SE = 'https://standardebooks.org';
const IA = 'https://archive.org';
export const PAGE = 24;
export const isTextId = id => /^(se|pg|file)_/.test(id);

async function getRaw(url, ms = 20000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { signal: c.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r;
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'timed out' : (e.message || 'network error'));
  } finally { clearTimeout(t); }
}
const iaFile = (id, name) => `${IA}/download/${encodeURIComponent(id)}/${String(name).split('/').map(encodeURIComponent).join('/')}`;
const one = v => String(Array.isArray(v) ? v[0] : v || '');
const squash = s => String(s || '').replace(/\s+/g, ' ').trim();

// ---------- Standard Ebooks (English, carefully typeset) ----------
const seOn = () => settings.lang === 'any' || settings.lang === 'en';

async function seList(params, page) {
  if (!seOn()) return [];
  // Built by hand: the site redirects other spellings of the same address, and those redirects cannot be followed from an app.
  const q = Object.keys(params).map(k => k + '=' + encodeURIComponent(params[k]).replace(/%20/g, '+'));
  q.push('per-page=' + PAGE);
  if (page > 1) q.push('page=' + page);
  const u = SE + '/ebooks?' + q.join('&');
  const doc = new DOMParser().parseFromString(await (await getRaw(u)).text(), 'text/html');
  return [...doc.querySelectorAll('ol.ebooks-list > li[about]')].map(li => {
    const path = li.getAttribute('about');
    if (!/^\/ebooks\/[\w.~-]+(\/[\w.~-]+)+$/.test(path)) return null;
    const name = li.querySelector('p:not(.author) [property="schema:name"]');
    const img = li.querySelector('img');
    const src = img && img.getAttribute('src');
    return {
      id: 'se_' + path.slice(8).replace(/\//g, '~'), kind: 'text', src: 'se', path,
      title: squash(name && name.textContent) || 'Untitled',
      author: [...li.querySelectorAll('p.author [property="schema:name"]')].map(x => squash(x.textContent)).join(', '),
      cover: src && src.startsWith('/images/') ? SE + src : '',
      lang: 'English', link: SE + path,
    };
  }).filter(Boolean);
}

async function seDetail(b) {
  const doc = new DOMParser().parseFromString(await (await getRaw(SE + b.path)).text(), 'text/html');
  const txt = sel => { const x = doc.querySelector(sel); return x ? squash(x.textContent) : ''; };
  const desc = [...doc.querySelectorAll('#description [property="schema:description"] > p')].map(p => squash(p.textContent)).filter(Boolean).join('\n\n');
  const subjects = [...doc.querySelectorAll('.tags a')].map(x => squash(x.textContent)).filter(Boolean).slice(0, 6);
  const authors = [...doc.querySelectorAll('hgroup [property="schema:author"] [property="schema:name"]')].map(x => squash(x.textContent)).join(', ');
  const og = doc.querySelector('meta[property="og:image"]');
  const cover = og && String(og.getAttribute('content')).startsWith(SE + '/') ? og.getAttribute('content') : '';
  return { desc, subjects, title: txt('hgroup h1'), author: authors, cover: b.cover || cover };
}

async function seText(b) {
  const doc = new DOMParser().parseFromString(await (await getRaw(`${SE}${b.path}/text/single-page`, 40000)).text(), 'text/html');
  const main = doc.querySelector('main') || doc.body;
  const out = [];
  const skip = /titlepage|halftitlepage|imprint|loi|copyright-page/;
  (function walk(node) {
    const kids = [...node.children].filter(c => /^(SECTION|ARTICLE)$/.test(c.tagName));
    if (!kids.length) {
      if (skip.test(node.getAttribute('epub:type') || '') && !/chapter|bodymatter/.test(node.getAttribute('epub:type') || '')) return;
      const blocks = [];
      flatten(node, b2 => blocks.push(b2), null);
      if (blocks.length) out.push(blocks);
      return;
    }
    // A part or volume: its own heading becomes a short section, then its chapters follow.
    const own = [];
    for (const c of node.childNodes) if (!kids.includes(c)) flatten(c, b2 => own.push(b2), null);
    if (own.some(x => squash(x.textContent))) out.push(own);
    kids.forEach(walk);
  })(main);
  return finish(out.map(blocks => ({ blocks })));
}

// ---------- Project Gutenberg, served by the Internet Archive ----------
const PG_LANG = { en: 'en', fr: 'fr', de: 'de', es: 'es', it: 'it', ar: 'ar' };
function pgBase() {
  const l = PG_LANG[settings.lang];
  return 'collection:gutenberg AND mediatype:texts' + (l ? ` AND language:(${l})` : '');
}
const lucene = q => q.replace(/[+\-&|!(){}\[\]^"~*?:\\\/]/g, ' ').trim().split(/\s+/).filter(Boolean).join(' ');
const LNAME = { en: 'English', fr: 'French', de: 'German', es: 'Spanish', it: 'Italian', ar: 'Arabic', pt: 'Portuguese', nl: 'Dutch', fi: 'Finnish', la: 'Latin', el: 'Greek' };
// "Shelley, Mary Wollstonecraft, 1797-1851" -> "Mary Wollstonecraft Shelley"
function tidyAuthor(a) {
  const s = one(a).replace(/,?\s*\(?\d{3,4}\??\s*-\s*\d{0,4}\??\)?\s*$/, '').replace(/,\s*(Sir|Mrs\.|Mr\.|Dr\.|Baron|Lord|Saint|graf|Jr\.)\s*$/i, '').trim();
  const m = /^([^,]+),\s*(.+)$/.exec(s);
  return m ? `${m[2]} ${m[1]}`.replace(/\s+/g, ' ') : s;
}

async function pgList(q, sort, page) {
  const fl = ['identifier', 'title', 'creator', 'language'].map(f => 'fl%5B%5D=' + f).join('&');
  const u = `${IA}/advancedsearch.php?q=${encodeURIComponent(q)}&${fl}&sort%5B%5D=${encodeURIComponent(sort)}&rows=${PAGE}&page=${page}&output=json`;
  const d = await (await getRaw(u, 12000)).json();
  const docs = d && d.response && d.response.docs;
  if (!Array.isArray(docs)) throw new Error('bad answer');
  return docs.map(x => ({
    id: 'pg_' + x.identifier, kind: 'text', src: 'pg', iaId: x.identifier,
    title: squash(one(x.title)) || 'Untitled', author: tidyAuthor(x.creator), cover: '',
    lang: LNAME[one(x.language)] || one(x.language), link: `${IA}/details/${encodeURIComponent(x.identifier)}`,
  }));
}

async function pgMeta(b) {
  const d = await (await getRaw(`${IA}/metadata/${encodeURIComponent(b.iaId)}`, 14000)).json();
  if (!d || !d.metadata) throw new Error('not found');
  return d;
}

async function pgText(b) {
  const d = await pgMeta(b);
  const files = d.files || [];
  const html = files.find(f => f.format === 'HTML' && /-h\.html?$/i.test(f.name)) || files.find(f => f.format === 'HTML' && !/index\.html?$/i.test(f.name));
  const txt = files.find(f => /-0\.txt$/i.test(f.name)) || files.find(f => /-8\.txt$/i.test(f.name)) || files.find(f => f.format === 'Text' && /\.txt$/i.test(f.name) && !/readme/i.test(f.name));
  const pick = txt || html; // the Archive only lets apps fetch the plain-text files
  if (!pick) throw new Error('this item has no readable text');
  const buf = await (await getRaw(iaFile(b.iaId, pick.name), 40000)).arrayBuffer();
  if (pick === html) {
    const head = new TextDecoder('ascii').decode(buf.slice(0, 3000));
    const cs = /charset\s*=\s*["']?([\w-]+)/i.exec(head);
    const doc = new DOMParser().parseFromString(decode(buf, cs && cs[1]), 'text/html');
    const dir = pick.name.includes('/') ? pick.name.slice(0, pick.name.lastIndexOf('/') + 1) : '';
    const blocks = [];
    flatten(doc.body, x => blocks.push(x), src => (/^[\w./-]+\.(jpe?g|png|gif)$/i.test(src) && !src.includes('..') ? iaFile(b.iaId, dir + src) : ''));
    return finish(splitByHeadings(trimGutenberg(blocks)));
  }
  return finish(splitByHeadings(trimGutenberg(plainToBlocks(decode(buf, /-8\.txt$/i.test(pick.name) ? 'iso-8859-1' : 'utf-8')))));
}

function decode(buf, charset) {
  try { return new TextDecoder(charset || 'utf-8').decode(buf); } catch { return new TextDecoder('utf-8').decode(buf); }
}

// ---------- making safe, tidy chapters out of any HTML ----------
// Everything is rebuilt from an allow-list: no scripts, styles, links or attributes survive.
const DROP = new Set(['SCRIPT', 'STYLE', 'NAV', 'HEAD', 'HEADER', 'FOOTER', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'SVG', 'LINK', 'META', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'NOSCRIPT', 'AUDIO', 'VIDEO', 'TITLE', 'TEMPLATE']);
const INLINE = { EM: 'em', I: 'em', CITE: 'em', DFN: 'em', STRONG: 'strong', B: 'strong', SUP: 'sup', SUB: 'sub', CODE: 'code', SMALL: 'small', S: 's', DEL: 's' };
const BLOCKS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'UL', 'OL', 'DL', 'TABLE', 'HR', 'FIGURE', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'ASIDE', 'CENTER', 'ADDRESS', 'FIGCAPTION', 'LI', 'DD', 'DT']);
const el = tag => document.createElement(tag);

function inline(node, out, img) {
  for (const c of node.childNodes) {
    if (c.nodeType === 3) { out.append(c.data); continue; }
    if (c.nodeType !== 1 || DROP.has(c.tagName.toUpperCase())) continue;
    const tag = c.tagName.toUpperCase();
    if (tag === 'BR') out.append(el('br'));
    else if (tag === 'IMG') { const i = image(c, img); if (i) out.append(i); }
    else if (INLINE[tag]) { const e = el(INLINE[tag]); inline(c, e, img); if (e.childNodes.length) out.append(e); }
    else inline(c, out, img); // span, a, abbr, nested blocks…: keep the words, drop the wrapper
  }
}
function image(node, img) {
  const src = img ? img(node.getAttribute('src') || '') : '';
  if (!src) return null;
  const i = el('img');
  i.setAttribute('src', src);
  i.setAttribute('alt', squash(node.getAttribute('alt')).slice(0, 200));
  i.setAttribute('loading', 'lazy');
  return i;
}
const hasBlockKids = node => [...node.children].some(c => BLOCKS.has(c.tagName.toUpperCase()));
const filled = e => squash(e.textContent) || e.querySelector('img');

/** Walks any HTML and emits clean block elements in reading order. */
function flatten(node, emit, img) {
  if (node.nodeType === 3) {
    if (squash(node.data)) { const p = el('p'); p.textContent = node.data; emit(p); }
    return;
  }
  if (node.nodeType !== 1) return;
  const tag = node.tagName.toUpperCase();
  if (DROP.has(tag)) return;
  if (/^H[1-6]$/.test(tag)) {
    const e = el(tag === 'H1' || tag === 'H2' ? 'h2' : tag === 'H3' ? 'h3' : 'h4');
    inline(node, e, null);
    if (filled(e)) emit(e);
  } else if (tag === 'HR') emit(el('hr'));
  else if (tag === 'IMG') { const i = image(node, img); if (i) { const p = el('p'); p.className = 'pic'; p.append(i); emit(p); } }
  else if (tag === 'PRE') { const e = el('pre'); e.textContent = node.textContent; if (filled(e)) emit(e); }
  else if (tag === 'UL' || tag === 'OL') {
    const e = el(tag.toLowerCase());
    for (const li of node.children) if (li.tagName.toUpperCase() === 'LI') { const x = el('li'); inline(li, x, img); if (filled(x)) e.append(x); }
    if (e.children.length) emit(e);
  } else if (tag === 'TABLE') {
    const e = el('table');
    for (const tr of node.querySelectorAll('tr')) {
      const row = el('tr');
      for (const td of tr.children) { const cell = el(td.tagName.toUpperCase() === 'TH' ? 'th' : 'td'); inline(td, cell, img); row.append(cell); }
      if (filled(row)) e.append(row);
    }
    if (e.children.length) emit(e);
  } else if (tag === 'BLOCKQUOTE') {
    const e = el('blockquote');
    if (hasBlockKids(node)) for (const c of node.childNodes) flatten(c, x => e.append(x), img);
    else { const p = el('p'); inline(node, p, img); if (filled(p)) e.append(p); }
    if (e.childNodes.length) emit(e);
  } else if (tag === 'P' || !hasBlockKids(node)) {
    const p = el('p');
    inline(node, p, img);
    if (filled(p)) emit(p);
  } else for (const c of node.childNodes) flatten(c, emit, img);
}

function trimGutenberg(blocks) {
  let a = 0, b = blocks.length;
  for (let i = 0; i < Math.min(blocks.length, 200); i++) {
    if (/\*\*\*\s*START OF (THE|THIS) PROJECT GUTENBERG|\*END\*THE SMALL PRINT/i.test(blocks[i].textContent)) a = i + 1;
  }
  for (let i = blocks.length - 1; i >= Math.max(a, blocks.length - 400); i--) {
    if (/\*\*\*\s*END OF (THE|THIS) PROJECT GUTENBERG|^\s*End of (the )?Project Gutenberg/i.test(blocks[i].textContent)) b = i;
  }
  return blocks.slice(a, b);
}

function splitByHeadings(blocks) {
  const count = t => blocks.filter(x => x.tagName === t).length;
  const cut = count('H2') >= 3 ? ['H2'] : count('H3') >= 3 ? ['H2', 'H3'] : count('H4') >= 3 ? ['H2', 'H3', 'H4'] : [];
  const parts = [];
  let cur = [];
  for (const b of blocks) {
    if (cut.includes(b.tagName) && cur.length) { parts.push({ blocks: cur }); cur = []; }
    cur.push(b);
  }
  if (cur.length) parts.push({ blocks: cur });
  return parts;
}

// Gutenberg plain text marks italics _like this_.
function rich(e, text) {
  text.split(/_([^_]{1,300})_/).forEach((part, i) => {
    if (!part) return;
    if (i % 2) { const em = el('em'); em.textContent = part; e.append(em); } else e.append(part);
  });
}

function plainToBlocks(text) {
  const out = [];
  for (const para of text.replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = para.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    const joined = lines.join(' ');
    const heading = lines.length <= 2 && joined.length < 70 && (/^(chapter|book|part|letter|volume|act|scene|canto|prologue|epilogue|preface|introduction|contents)\b/i.test(joined) || (joined === joined.toUpperCase() && /[A-Z]{3}/.test(joined) && !/[,;:]$/.test(joined)));
    const e = el(heading ? 'h2' : 'p');
    const verse = !heading && lines.length > 1 && lines.reduce((n, l) => n + l.length, 0) / lines.length < 46;
    if (verse) lines.forEach((l, i) => { if (i) e.append(el('br')); rich(e, l); });
    else rich(e, joined);
    out.push(e);
  }
  return out;
}

/** Evens out section sizes, names them, and serialises the clean HTML. */
function finish(parts) {
  // Glue heading-only scraps onto what follows; cut very long sections so pages stay quick to lay out.
  const merged = [];
  for (const p of parts) {
    const prev = merged[merged.length - 1];
    if (prev && prev.blocks.reduce((n, b) => n + b.textContent.length, 0) < 350) prev.blocks.push(...p.blocks);
    else merged.push({ blocks: [...p.blocks] });
  }
  const sized = [];
  for (const p of merged) {
    let chunk = [], n = 0, part = 1;
    const title = titleOf(p.blocks);
    for (const b of p.blocks) {
      chunk.push(b); n += b.textContent.length;
      if (n > 45000) { sized.push({ blocks: chunk, title: part > 1 ? `${title} (${part})` : title }); chunk = []; n = 0; part++; }
    }
    if (chunk.length) sized.push({ blocks: chunk, title: part > 1 ? `${title} (${part})` : title });
  }
  const sections = sized.map((s, i) => {
    const box = el('div');
    box.append(...s.blocks);
    return { title: s.title || `Part ${i + 1}`, html: box.innerHTML, len: box.textContent.length };
  }).filter(s => s.len > 0 || /<img/.test(s.html));
  if (!sections.length) throw new Error('no readable text found');
  return { sections, chars: sections.reduce((n, s) => n + s.len, 0) };
}
function titleOf(blocks) {
  const hd = blocks.filter(b => /^H[2-4]$/.test(b.tagName)).slice(0, 2).map(b => squash(b.textContent)).filter(Boolean);
  return hd.join(' — ').slice(0, 90);
}

// ---------- catalogue: both sources asked together, either one is enough ----------
const mem = new Map();
const FRESH = 6 * 3600 * 1000;
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\b(the|a|an)\b/g, ' ').replace(/\s+/g, ' ').trim();

/** kind: 'fresh' (new at Standard Ebooks) | 'popular' (Gutenberg) | 'genre' | 'search' */
export async function list(kind, arg, page = 1) {
  const key = `t:${kind}:${arg || ''}:${settings.lang}:${page}`;
  if (mem.has(key)) return mem.get(key);
  const persist = page === 1 && kind !== 'search';
  const cached = persist ? cacheGet(key) : null;
  if (cached && Date.now() - cached.t < FRESH) { mem.set(key, cached.v); return cached.v; }
  const g = kind === 'genre' ? GENRES.find(x => x.key === arg) : null;
  const jobs = [];
  if (kind === 'fresh') jobs.push(seList({ sort: 'popularity' }, page));
  else if (kind === 'popular') jobs.push(pgList(pgBase(), 'downloads desc', page));
  else if (kind === 'genre') {
    jobs.push(g.se ? seList({ 'tags[]': g.se }, page) : Promise.resolve([]));
    jobs.push(pgList(`${pgBase()} AND subject:(${g.ia})`, 'downloads desc', page));
  } else {
    const s = lucene(arg);
    if (!s) return { items: [] };
    jobs.push(seList({ query: arg }, page));
    jobs.push(pgList(`${pgBase()} AND (title:(${s}) OR creator:(${s}))`, 'downloads desc', page));
  }
  const res = await Promise.allSettled(jobs);
  if (res.every(r => r.status === 'rejected')) {
    if (cached) return Object.assign({ stale: true }, cached.v);
    throw new Error(navigator.onLine === false ? 'You are offline.' : `No source answered (${res[0].reason.message}).`);
  }
  const seen = new Set(), items = [];
  for (const r of res) if (r.status === 'fulfilled') for (const b of r.value) {
    const k = norm(b.title) + '|' + norm(b.author).split(' ').pop();
    if (seen.has(k)) continue;
    seen.add(k); items.push(b);
  }
  const out = { items, more: res.some(r => r.status === 'fulfilled' && r.value.length >= PAGE) };
  // Remember the list only when every source answered, so a brief outage is not kept for hours.
  if (res.every(r => r.status === 'fulfilled')) {
    mem.set(key, out);
    if (persist && items.length) cacheSet(key, out);
  }
  return out;
}
export function peek(kind, arg) { const c = cacheGet(`t:${kind}:${arg || ''}:${settings.lang}:1`); return c ? c.v : null; }
export function clearListCache() { mem.clear(); }

export function bookFromId(id) {
  if (id.startsWith('se_')) { const path = '/ebooks/' + id.slice(3).replace(/~/g, '/'); return { id, kind: 'text', src: 'se', path, link: SE + path, lang: 'English' }; }
  if (id.startsWith('pg_')) return { id, kind: 'text', src: 'pg', iaId: id.slice(3), link: `${IA}/details/${id.slice(3)}` };
  return { id, kind: 'text', src: 'file' };
}

/** Description and subjects for the book page. */
export async function getDetail(b) {
  if (b.src === 'se') return mergeBook(b, await seDetail(b));
  if (b.src === 'pg') {
    const m = (await pgMeta(b)).metadata;
    const subj = [].concat(m.subject || []).filter(s => s.length > 3).slice(0, 6);
    return mergeBook(b, { title: squash(one(m.title)), author: tidyAuthor(m.creator), lang: LNAME[one(m.language)] || one(m.language), subjects: subj, desc: subj.length ? '' : '' });
  }
  return b;
}

const pending = new Map();
/** The book's words, from this iPhone if stored, otherwise fetched, cleaned and stored. */
export function getText(b) {
  if (pending.has(b.id)) return pending.get(b.id);
  const p = (async () => {
    const have = texts.has(b.id) ? await texts.get(b.id) : null;
    if (have) return have;
    if (b.src === 'file') throw new Error('This imported book is no longer stored.');
    const t = b.src === 'se' ? await seText(b) : await pgText(b);
    const rec = Object.assign({ id: b.id, at: Date.now() }, t);
    await texts.put(rec);
    return rec;
  })();
  pending.set(b.id, p);
  p.finally(() => pending.delete(b.id)).catch(() => {});
  return p;
}

// ---------- matching an audiobook to its text, and back ----------
const mainTitle = t => String(t || '').replace(/\([^)]*\)/g, ' ').split(/[;:]| or,? /i)[0].replace(/\s+/g, ' ').trim();
export async function findText(audio) {
  const title = mainTitle(audio.title), sur = norm(audio.author).split(',')[0].split(' ').pop();
  const s = lucene(title);
  const res = await Promise.allSettled([
    seList({ query: title }, 1),
    pgList(`${pgBase()} AND title:(${s})` + (sur ? ` AND creator:(${sur})` : ''), 'downloads desc', 1),
  ]);
  if (res.every(r => r.status === 'rejected')) throw new Error('No source answered.');
  const want = norm(title);
  const all = res.flatMap(r => (r.status === 'fulfilled' ? r.value : []));
  const score = b => { const t = norm(mainTitle(b.title)); return (t === want ? 4 : t.startsWith(want) || want.startsWith(t) ? 2 : t.includes(want) ? 1 : 0) + (sur && norm(b.author).includes(sur) ? 2 : 0); };
  return all.map(b => ({ b, s: score(b) })).filter(x => x.s >= 3).sort((x, y) => y.s - x.s).slice(0, 8).map(x => x.b);
}
export const searchTitle = b => mainTitle(b.title);

// ---------- importing your own .epub / .txt ----------
async function inflate(bytes) {
  if (!self.DecompressionStream) throw new Error('This iPhone needs iOS 16.4 or newer to open EPUB files.');
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
}
/** Minimal ZIP reader: returns name -> async () => Uint8Array */
function unzip(buf) {
  const v = new DataView(buf), u8 = new Uint8Array(buf), files = new Map();
  let e = buf.byteLength - 22;
  while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('not a valid EPUB file');
  const n = v.getUint16(e + 10, true);
  let p = v.getUint32(e + 16, true);
  const td = new TextDecoder();
  for (let i = 0; i < n && v.getUint32(p, true) === 0x02014b50; i++) {
    const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true);
    const nl = v.getUint16(p + 28, true), xl = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true), off = v.getUint32(p + 42, true);
    const name = td.decode(u8.subarray(p + 46, p + 46 + nl));
    files.set(name, async () => {
      const start = off + 30 + v.getUint16(off + 26, true) + v.getUint16(off + 28, true);
      const data = u8.subarray(start, start + csize);
      if (method === 0) return data;
      if (method === 8) return inflate(data);
      throw new Error('unsupported compression in EPUB');
    });
    p += 46 + nl + xl + cl;
  }
  return files;
}
const resolvePath = (base, rel) => {
  const parts = (base.includes('/') ? base.slice(0, base.lastIndexOf('/') + 1) : '').split('/').filter(Boolean);
  for (const seg of decodeURIComponent(rel.split('#')[0]).split('/')) { if (seg === '..') parts.pop(); else if (seg && seg !== '.') parts.push(seg); }
  return parts.join('/');
};

async function coverDataUrl(bytes, type) {
  try {
    const bmp = await createImageBitmap(new Blob([bytes], { type }));
    const w = 240, hgt = Math.round(bmp.height / bmp.width * w);
    const cv = el('canvas'); cv.width = w; cv.height = hgt;
    cv.getContext('2d').drawImage(bmp, 0, 0, w, hgt);
    return cv.toDataURL('image/jpeg', 0.8);
  } catch { return ''; }
}

async function readEpub(buf) {
  const zip = unzip(buf), td = new TextDecoder();
  const read = async name => { const f = zip.get(name); if (!f) throw new Error('EPUB is missing ' + name); return td.decode(await f()); };
  const xml = s => new DOMParser().parseFromString(s, 'application/xml');
  const container = xml(await read('META-INF/container.xml'));
  const opfPath = container.querySelector('rootfile').getAttribute('full-path');
  const opf = xml(await read(opfPath));
  const tag = n => { const x = opf.getElementsByTagNameNS('*', n)[0]; return x ? squash(x.textContent) : ''; };
  const items = new Map([...opf.getElementsByTagNameNS('*', 'item')].map(i => [i.getAttribute('id'), i]));
  const parts = [];
  for (const ref of opf.getElementsByTagNameNS('*', 'itemref')) {
    const it = items.get(ref.getAttribute('idref'));
    if (!it || !/x?html/.test(it.getAttribute('media-type') || '')) continue;
    const f = zip.get(resolvePath(opfPath, it.getAttribute('href')));
    if (!f) continue;
    const doc = new DOMParser().parseFromString(td.decode(await f()), 'text/html');
    const blocks = [];
    flatten(doc.body, b => blocks.push(b), null);
    if (blocks.length) parts.push({ blocks });
  }
  let cover = '';
  const metaCover = [...opf.getElementsByTagNameNS('*', 'meta')].find(m => m.getAttribute('name') === 'cover');
  const cv = [...items.values()].find(i => /cover-image/.test(i.getAttribute('properties') || '')) || (metaCover && items.get(metaCover.getAttribute('content')));
  if (cv && zip.get(resolvePath(opfPath, cv.getAttribute('href')))) cover = await coverDataUrl(await zip.get(resolvePath(opfPath, cv.getAttribute('href')))(), cv.getAttribute('media-type') || 'image/jpeg');
  return { title: tag('title'), author: tag('creator'), lang: tag('language'), cover, text: finish(parts) };
}

/** Adds a book file from the phone to the library. Returns the new ebook. */
export async function importFile(file) {
  const buf = await file.arrayBuffer();
  const base = file.name.replace(/\.[^.]+$/, '');
  let info;
  if (/\.epub$/i.test(file.name) || new DataView(buf).getUint32(0, true) === 0x04034b50) info = await readEpub(buf);
  else info = { title: '', author: '', lang: '', cover: '', text: finish(splitByHeadings(trimGutenberg(plainToBlocks(decode(buf, 'utf-8'))))) };
  const id = 'file_' + Date.now().toString(36);
  await texts.put(Object.assign({ id, at: Date.now() }, info.text));
  return { id, kind: 'text', src: 'file', title: info.title || base, author: info.author || '', cover: info.cover, lang: LNAME[(info.lang || '').slice(0, 2)] || '', link: '' };
}

/** Rough reading time for a number of characters, at about 240 words a minute. */
export const readMins = chars => Math.max(1, Math.round(chars / 6 / 240));
