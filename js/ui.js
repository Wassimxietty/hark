// All screens: Home, Search, Library, Settings, book page, list page, player.
// Views are built once and kept; only the small parts that change are redrawn.
import { $, h, icon, fmtClock, fmtDur, fmtBytes, debounce, initials, clamp } from './util.js';
import { settings, saveSettings, bus, lib, getProg, clearProg, mergeBook } from './store.js';
import * as src from './sources.js';
import * as player from './player.js';
import * as dl from './downloads.js';
import * as theme from './theme.js';
import * as books from './books.js';
import { importAudio } from './own.js';
import { texts } from './store.js';
import { buildReader, openReader } from './reader.js';
import { toast, openSheet, closeSheet, confirmSheet, seg, toggle } from './kit.js';

const screens = $('#screens');
const known = new Map(); // id -> fullest book object seen this session
function remember(b) {
  const k = known.get(b.id);
  const m = k ? mergeBook(k, b) : b;
  known.set(b.id, m);
  return m;
}
const bookOf = id => known.get(id) || (lib.get(id) && lib.get(id).book) || null;

// ---------- small shared pieces ----------
function cover(book, big) {
  const box = h('div', { class: 'cover' + (book.kind === 'text' ? ' tall' : '') });
  const url = big ? (book.coverHi || book.cover) : book.cover;
  const ph = () => box.replaceChildren(h('div', { class: 'ph', text: initials(book.title) }));
  if (!url) { ph(); return box; }
  const img = h('img', { alt: '', loading: 'lazy', decoding: 'async' });
  let fellBack = false;
  img.onerror = () => {
    if (big && book.cover && !fellBack) { fellBack = true; img.src = book.cover; } else ph();
  };
  img.src = url;
  box.append(img);
  return box;
}

function progressOf(rec) {
  const p = getProg(rec.id), ch = rec.book.chapters || [];
  if (!p || !ch.length) return null;
  let before = 0, total = 0;
  ch.forEach((c, i) => { if (i < p.idx) before += c.secs || 0; total += c.secs || 0; });
  const at = before + (p.t || 0);
  return { pct: total ? clamp(at / total, 0, 1) : 0, left: Math.max(0, total - at), idx: p.idx, n: ch.length, done: !!p.done, at: p.at || 0 };
}

function row(book, opts = {}) {
  book = remember(book);
  const rec = lib.get(book.id);
  const meta = opts.meta || (book.kind === 'text' ? [SRC_NAME[book.src], book.lang] : [fmtDur(book.secs), book.lang]).filter(Boolean).join(' · ');
  return h('div', { class: 'row', role: 'button', tabIndex: 0, onclick: () => openBook(book.id) },
    cover(book),
    h('div', { class: 'tx' },
      h('div', { class: 't', text: book.title }),
      h('div', { class: 'a ell', text: book.author || 'Unknown author' }),
      meta ? h('div', { class: 'm ell', text: meta }) : null),
    opts.play ? h('button', { class: 'rplay', 'aria-label': 'Play', onclick: e => { e.stopPropagation(); opts.play(); } }, icon(opts.playIcon || 'play', 20))
      : rec && rec.saved ? icon('bookmarkFill', 18) : null);
}

function card(book) {
  book = remember(book);
  return h('button', { class: 'card', onclick: () => openBook(book.id) },
    cover(book),
    h('div', { class: 't', text: book.title }),
    h('div', { class: 'a ell', text: book.author || '' }));
}

const empty = (title, text, btn) => h('div', { class: 'empty' }, h('h4', { text: title }), h('div', { text }), btn || null);
const errorBox = (msg, retry) => empty('Could not load', msg, h('button', { class: 'btn', onclick: retry }, 'Try again'));
const skRows = n => Array.from({ length: n }, () => h('div', { class: 'row sk' }));

/** Vertical list that loads one page at a time. */
function pagedList(host, loader, emptyText) {
  const gen = host._gen = (host._gen || 0) + 1;
  const listEl = h('div'), foot = h('div');
  let page = 1, busy = false;
  host.replaceChildren(listEl, foot);
  async function more() {
    if (busy) return;
    busy = true;
    foot.replaceChildren(...skRows(page === 1 ? 6 : 2));
    try {
      const r = await loader(page);
      if (host._gen !== gen) return;
      foot.replaceChildren();
      if (r.stale) foot.append(h('div', { class: 'note', text: 'Offline — showing the last list saved on this iPhone.' }));
      for (const b of r.items) listEl.append(row(b));
      if (page === 1 && !r.items.length) foot.append(empty('Nothing here', emptyText || 'No books were found.'));
      else if (r.more != null ? r.more : r.items.length >= src.PAGE) foot.append(h('div', { class: 'more' }, h('button', { class: 'btn', onclick: more }, 'Load more')));
      page++;
    } catch (e) {
      if (host._gen !== gen) return;
      foot.replaceChildren(errorBox(e.message, more));
    } finally { busy = false; }
  }
  more();
}

// ---------- navigation ----------
const views = {};
let current = 'home';
let page = null;
const stack = []; // page hashes sitting above the current tab in history

function go(hash) { location.hash = hash; }
function openBook(id) { go((books.isTextId(id) ? '#/text/' : '#/book/') + encodeURIComponent(id)); }
function back() {
  if (stack.length) { stack.pop(); history.back(); }
  else { history.replaceState(null, '', '#/' + current); route(); }
}
function goTab(name) {
  if (current === name && !page) { views[name].scroller.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  stack.length = 0;
  history.replaceState(null, '', '#/' + name);
  route();
}

function showTab(name) {
  for (const k in views) {
    const v = views[k];
    if (k === name) {
      if (v.el.hidden) { v.el.hidden = false; v.scroller.scrollTop = v.top || 0; }
    } else if (!v.el.hidden) { v.top = v.scroller.scrollTop; v.el.hidden = true; }
  }
  current = name;
  for (const b of $('#tabs').children) b.classList.toggle('on', b.dataset.tab === name);
  if (views[name].show) views[name].show();
}

function removePage() {
  if (!page) return;
  if (page.destroy) page.destroy();
  page.el.remove();
  page = null;
}
function showPage(p) {
  removePage();
  page = p;
  screens.append(p.el);
}

function route() {
  const hash = location.hash;
  const parts = hash.replace(/^#\/?/, '').split('/');
  const name = parts[0] || 'home';
  closeSheet();
  if (['book', 'list', 'text', 'tlist'].includes(name) && parts[1]) {
    const i = stack.lastIndexOf(hash);
    if (i >= 0) stack.length = i + 1; else stack.push(hash);
    showPage(name === 'book' ? BookPage(decodeURIComponent(parts[1])) : name === 'text' ? TextPage(decodeURIComponent(parts[1])) : ListPage(parts[1], parts[2], name === 'tlist'));
    return;
  }
  stack.length = 0;
  removePage();
  showTab(views[name] ? name : 'home');
}

// ---------- tabs + mini player ----------
function buildTabs() {
  const defs = [['home', 'Listen', 'headphones'], ['read', 'Read', 'book'], ['search', 'Search', 'search'], ['library', 'Library', 'shelf'], ['settings', 'Settings', 'sliders']];
  $('#tabs').append(...defs.map(([key, label, ic]) =>
    h('button', { data: { tab: key }, onclick: () => goTab(key) }, icon(ic, 22), h('span', { text: label }))));
}

function buildMini() {
  const mini = $('#mini');
  const mt = h('div', { class: 'mt ell' }), msub = h('div', { class: 'ms ell' });
  const bar = h('div', { class: 'mp' });
  const btn = h('button', { class: 'mb', 'aria-label': 'Play or pause', onclick: () => player.toggle() }, icon('play', 24));
  mini.append(bar, h('button', { class: 'mi', onclick: openPlayer, 'aria-label': 'Open player' }, mt, msub), btn);
  let lastIcon = '';
  player.on('state', s => {
    mini.hidden = !s.book;
    if (!s.book) return;
    const ch = player.chapter();
    mt.textContent = s.book.title;
    msub.textContent = s.error || (ch ? ch.title : s.book.author || '');
    const ic = s.playing ? 'pause' : 'play';
    if (ic !== lastIcon) { btn.replaceChildren(icon(ic, 24)); lastIcon = ic; }
  });
  player.on('time', s => { bar.style.transform = `scaleX(${s.dur ? clamp(s.t / s.dur, 0, 1) : 0})`; });
}

// ---------- Home ----------
function HomeView() {
  let genre = 'all';
  const chips = h('div', { class: 'chips' });
  const hero = h('div'), body = h('div');
  const scroller = h('div', { class: 'scroll' }, chips, hero, body);
  const el = h('section', { class: 'view', hidden: true },
    h('header', { class: 'bar' },
      h('button', { class: 'bar-btn l', 'aria-label': 'Add your own audiobook file', onclick: () => $('#pickAudio').click() }, icon('filePlus', 22)),
      h('div', { class: 'bar-title', text: 'HARK' }),
      h('button', { class: 'bar-btn r', 'aria-label': 'Next colour theme', onclick: nextTheme }, icon('sparkle', 22))),
    scroller);

  function nextTheme() {
    const i = theme.PRESETS.findIndex(p => p.key === settings.theme);
    const p = theme.PRESETS[(i + 1) % theme.PRESETS.length];
    theme.usePreset(p.key);
    toast(`Theme: ${p.name}`);
  }

  function drawChips() {
    const all = [{ key: 'all', label: 'Everything' }, ...src.GENRES];
    chips.replaceChildren(...all.map(g => h('button', {
      class: 'chip' + (g.key === genre ? ' on' : ''), text: g.label,
      onclick: () => { if (genre !== g.key) { genre = g.key; drawChips(); drawBody(); } },
    })));
  }

  function drawHero() {
    const s = player.state;
    if (s.book) {
      const pos = player.bookPos(), ch = player.chapter();
      hero.replaceChildren(h('div', { class: 'hi' },
        h('div', { class: 'kicker', text: s.playing ? 'Now playing' : 'Continue listening' }),
        h('h2', { text: s.book.title }),
        h('p', { class: 'ell', text: [ch && ch.title, pos.total ? fmtDur(pos.total - pos.at) + ' left' : ''].filter(Boolean).join(' · ') }),
        h('div', { class: 'pg' }, h('i', { css: `width:${pos.total ? (pos.at / pos.total * 100).toFixed(1) : 0}%` })),
        h('button', { class: 'btn', onclick: () => { if (s.playing) openPlayer(); else { player.play(); } } },
          icon(s.playing ? 'headphones' : 'play', 20), s.playing ? 'Open player' : 'Resume')));
    } else {
      hero.replaceChildren(h('div', { class: 'hi' },
        h('h2', { text: 'Listen anywhere.' }),
        h('p', { text: 'Free public-domain audiobooks, read by volunteers. Stream them or keep them on your iPhone.' }),
        h('div', { class: 'pair' },
          h('button', { class: 'btn', onclick: () => goTab('search') }, icon('search', 20), 'Find'),
          h('button', { class: 'btn', onclick: () => $('#pickAudio').click() }, icon('filePlus', 20), 'Add a file'))));
    }
  }

  function shelf(title, kind) {
    const rowEl = h('div', { class: 'shelf' });
    const paint = r => rowEl.replaceChildren(...r.items.slice(0, 14).map(card));
    const cached = src.peek(kind);
    if (cached) paint(cached); else rowEl.replaceChildren(...Array.from({ length: 4 }, () => h('div', { class: 'card sk' })));
    src.list(kind, '', 1).then(paint).catch(e => {
      if (!cached) rowEl.replaceChildren(h('div', { class: 'note', css: 'margin:0;flex:1', text: e.message }));
    });
    return h('div', null,
      h('div', { class: 'sec' }, h('h3', { text: title }), h('button', { onclick: () => go('#/list/' + kind) }, 'more')),
      rowEl);
  }

  const mine = h('div');
  function drawMine() {
    const recs = lib.all().filter(r => r.dl > 0).sort((a, b) => (b.openedAt || b.addedAt) - (a.openedAt || a.addedAt));
    if (!recs.length) { mine.replaceChildren(); return; }
    mine.replaceChildren(
      h('div', { class: 'sec' }, h('h3', { text: 'On this iPhone' }), h('button', { onclick: () => goTab('library') }, 'more')),
      h('div', { class: 'shelf' }, recs.slice(0, 14).map(r => card(r.book))));
  }

  function drawBody() {
    if (genre === 'all') {
      body.replaceChildren(mine, shelf('Popular', 'popular'), shelf('New arrivals', 'latest'));
      drawMine();
    } else {
      body._gen = (body._gen || 0) + 1;
      const host = h('div');
      body.replaceChildren(host);
      pagedList(host, p => src.list('genre', genre, p));
    }
  }

  const pickA = $('#pickAudio');
  pickA.addEventListener('change', async () => {
    const files = pickA.files ? [...pickA.files] : [];
    pickA.value = '';
    if (!files.length) return;
    toast('Adding your audiobook… keep Hark open.');
    try { const b = remember(await importAudio(files)); toast('Added to your library'); openBook(b.id); }
    catch (e) { toast(/quota/i.test(e.name + e.message) ? 'Not enough free storage for that file.' : `Could not add that file (${e.message}).`); }
  });

  drawChips(); drawHero(); drawBody();
  let heroKey = '';
  player.on('state', s => {
    if (el.hidden || document.hidden) return;
    const key = (s.book ? s.book.id : '') + s.playing + s.idx;
    if (key !== heroKey) { heroKey = key; drawHero(); }
  });
  bus.on('settings', p => { if (p && 'lang' in p) { src.clearListCache(); drawBody(); } });
  bus.on('dl', () => { if (!el.hidden && genre === 'all') drawMine(); });
  return { el, scroller, show() { drawHero(); if (genre === 'all') drawMine(); } };
}

// ---------- Read (ebooks) ----------
const SRC_NAME = { se: 'Standard Ebooks', pg: 'Project Gutenberg', file: 'Your file' };
function textProg(rec) {
  const p = getProg(rec.id);
  return p && p.pct != null ? { pct: p.pct, done: !!p.done, at: p.at || 0 } : null;
}

function shelfOf(api, title, kind, moreHash) {
  const rowEl = h('div', { class: 'shelf' });
  const paint = r => rowEl.replaceChildren(...r.items.slice(0, 14).map(card));
  const cached = api.peek(kind);
  if (cached) paint(cached); else rowEl.replaceChildren(...Array.from({ length: 4 }, () => h('div', { class: 'card sk' })));
  api.list(kind, '', 1).then(paint).catch(e => {
    if (!cached) rowEl.replaceChildren(h('div', { class: 'note', css: 'margin:0;flex:1', text: e.message }));
  });
  return h('div', null,
    h('div', { class: 'sec' }, h('h3', { text: title }), h('button', { onclick: () => go(moreHash) }, 'more')),
    rowEl);
}

function ReadView() {
  let genre = 'all';
  const chips = h('div', { class: 'chips' });
  const hero = h('div'), body = h('div'), mine = h('div');
  const scroller = h('div', { class: 'scroll' }, chips, hero, body);
  const pick = $('#pickBook');
  const el = h('section', { class: 'view', hidden: true },
    h('header', { class: 'bar' },
      h('div', { class: 'bar-btn l' }, icon('book', 22)),
      h('div', { class: 'bar-title', text: 'HARK' }),
      h('button', { class: 'bar-btn r', 'aria-label': 'Add a book file', onclick: () => pick.click() }, icon('filePlus', 22))),
    scroller);

  pick.addEventListener('change', async () => {
    const f = pick.files && pick.files[0];
    pick.value = '';
    if (!f) return;
    toast('Adding the book…');
    try {
      const b = remember(await books.importFile(f));
      lib.upsert(b, { saved: true, savedAt: Date.now() });
      openBook(b.id);
    } catch (e) { toast(`Could not add that file (${e.message}).`); }
  });

  function drawChips() {
    const all = [{ key: 'all', label: 'Everything' }, ...src.GENRES];
    chips.replaceChildren(...all.map(g => h('button', {
      class: 'chip' + (g.key === genre ? ' on' : ''), text: g.label,
      onclick: () => { if (genre !== g.key) { genre = g.key; drawChips(); drawBody(); } },
    })));
  }

  function drawHero() {
    const rec = settings.lastText && lib.get(settings.lastText);
    const p = rec && textProg(rec);
    if (rec && texts.has(rec.id) && p && !p.done) {
      hero.replaceChildren(h('div', { class: 'hi' },
        h('div', { class: 'kicker', text: 'Continue reading' }),
        h('h2', { text: rec.book.title }),
        h('p', { class: 'ell', text: [rec.book.author, `${Math.round(p.pct * 100)}% read`, rec.chars ? `${books.readMins(rec.chars * (1 - p.pct))} min left` : ''].filter(Boolean).join(' · ') }),
        h('div', { class: 'pg' }, h('i', { css: `width:${(p.pct * 100).toFixed(1)}%` })),
        h('button', { class: 'btn', onclick: () => openReader(rec.book) }, icon('book', 20), 'Continue')));
    } else {
      hero.replaceChildren(h('div', { class: 'hi' },
        h('h2', { text: 'Read anything.' }),
        h('p', { text: 'Free classics from Standard Ebooks and Project Gutenberg, or your own EPUB and text files.' }),
        h('div', { class: 'pair' },
          h('button', { class: 'btn', onclick: () => goTab('search') }, icon('search', 20), 'Find'),
          h('button', { class: 'btn', onclick: () => pick.click() }, icon('filePlus', 20), 'Add a file'))));
    }
  }

  function drawMine() {
    const recs = lib.all().filter(r => r.book.kind === 'text' && texts.has(r.id)).sort((a, b) => (b.openedAt || b.addedAt) - (a.openedAt || a.addedAt));
    if (!recs.length) { mine.replaceChildren(); return; }
    mine.replaceChildren(
      h('div', { class: 'sec' }, h('h3', { text: 'On this iPhone' }), h('button', { onclick: () => goTab('library') }, 'more')),
      h('div', { class: 'shelf' }, recs.slice(0, 14).map(r => card(r.book))));
  }

  function drawBody() {
    if (genre === 'all') {
      body.replaceChildren(mine, shelfOf(books, 'Popular at Standard Ebooks', 'fresh', '#/tlist/fresh'), shelfOf(books, 'Most downloaded at Project Gutenberg', 'popular', '#/tlist/popular'));
      drawMine();
    } else {
      const host = h('div');
      body.replaceChildren(host);
      pagedList(host, p => books.list('genre', genre, p));
    }
  }

  drawChips(); drawHero(); drawBody();
  bus.on('settings', p => { if (p && 'lang' in p) { books.clearListCache(); drawBody(); } });
  bus.on('texts', () => { if (!el.hidden) { drawHero(); if (genre === 'all') drawMine(); } });
  return { el, scroller, show() { drawHero(); if (genre === 'all') drawMine(); } };
}

// ---------- Search ----------
function SearchView() {
  let mode = 'audio', lastQ = '';
  const input = h('input', { type: 'search', placeholder: 'Title or author', autocomplete: 'off', autocapitalize: 'off', spellcheck: false, enterKeyHint: 'search', 'aria-label': 'Search' });
  const clear = h('button', { hidden: true, 'aria-label': 'Clear', onclick: () => { input.value = ''; run(); input.focus(); } }, icon('x', 18));
  const results = h('div', { hidden: true });
  const genres = h('div');
  const scroller = h('div', { class: 'scroll' }, results, genres);
  const el = h('section', { class: 'view', hidden: true },
    h('div', { class: 'hi top' }, h('h2', { text: 'Search' }),
      h('div', { class: 'field' }, icon('search', 20), input, clear),
      h('div', { class: 'segw' }, seg([['audio', 'Audiobooks'], ['text', 'Books to read']], mode, v => { mode = v; lastQ = null; drawGenres(); run(); }))),
    scroller);

  function drawGenres() {
    genres.replaceChildren(
      h('div', { class: 'sec' }, h('h3', { text: mode === 'audio' ? 'Audiobooks by genre' : 'Books by genre' })),
      src.GENRES.map(g => h('button', { class: 'grow', onclick: () => go((mode === 'audio' ? '#/list/genre/' : '#/tlist/genre/') + g.key) }, h('span', { text: g.label }), icon('right', 18))));
  }

  function run() {
    const q = input.value.trim();
    clear.hidden = !input.value;
    if (q === lastQ) return;
    lastQ = q;
    if (q.length < 2) {
      results._gen = (results._gen || 0) + 1;
      results.hidden = true; genres.hidden = false;
      return;
    }
    genres.hidden = true; results.hidden = false;
    scroller.scrollTop = 0;
    const api = mode === 'audio' ? src : books;
    pagedList(results, p => api.list('search', q, p), `Nothing found for “${q}”. Only free public-domain books are listed here, so recent titles will not appear.`);
  }
  drawGenres();
  input.addEventListener('input', debounce(run, 450));
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { run(); input.blur(); } });
  bus.on('settings', p => { if (p && 'lang' in p) { lastQ = null; run(); } });
  return { el, scroller };
}

// ---------- Library ----------
function LibraryView() {
  let kind = 'audio', tab = 'listening';
  const chips = h('div', { class: 'chips' });
  const listEl = h('div');
  const scroller = h('div', { class: 'scroll' },
    h('div', { class: 'segw', css: 'padding:12px 16px 0' }, seg([['audio', 'Audiobooks'], ['text', 'Books']], kind, v => { kind = v; draw(); })),
    chips, listEl);
  const el = h('section', { class: 'view', hidden: true },
    h('header', { class: 'bar' }, h('div', { class: 'bar-title plain', text: 'Library' })), scroller);
  const TABS = {
    audio: [['listening', 'Listening'], ['saved', 'Saved'], ['downloaded', 'Downloaded'], ['finished', 'Finished']],
    text: [['listening', 'Reading'], ['saved', 'Saved'], ['downloaded', 'On this iPhone'], ['finished', 'Finished']],
  };

  function draw() {
    const isText = kind === 'text';
    chips.replaceChildren(...TABS[kind].map(([k, label]) => h('button', {
      class: 'chip' + (k === tab ? ' on' : ''), text: label, onclick: () => { tab = k; draw(); },
    })));
    const recs = lib.all().filter(r => (r.book.kind === 'text') === isText).map(r => ({ r, p: isText ? textProg(r) : progressOf(r) }));
    let items;
    if (tab === 'listening') items = recs.filter(x => x.p && !x.p.done).sort((a, b) => b.p.at - a.p.at);
    else if (tab === 'saved') items = recs.filter(x => x.r.saved).sort((a, b) => (b.r.savedAt || 0) - (a.r.savedAt || 0));
    else if (tab === 'downloaded') items = recs.filter(x => (isText ? texts.has(x.r.id) : x.r.dl > 0 || dl.jobFor(x.r.id))).sort((a, b) => (b.r.addedAt || 0) - (a.r.addedAt || 0));
    else items = recs.filter(x => x.p && x.p.done).sort((a, b) => b.p.at - a.p.at);

    if (!items.length) {
      const msg = {
        listening: isText ? ['Nothing started yet', 'Books you open appear here, with your page kept.'] : ['Nothing started yet', 'Books you start playing appear here, with your place kept.'],
        saved: ['No saved books', 'Tap Save on a book to keep it here.'],
        downloaded: isText ? ['Nothing stored yet', 'Download a book, or add your own file from the Read tab.'] : ['No downloads', 'Download a book to listen without a connection.'],
        finished: ['Nothing finished yet', 'Books you finish are listed here.'],
      }[tab];
      listEl.replaceChildren(empty(msg[0], msg[1], h('button', { class: 'btn', onclick: () => goTab(isText ? 'read' : 'search') }, 'Find a book')));
      return;
    }
    listEl.replaceChildren(...items.map(({ r, p }) => {
      let meta;
      if (isText) {
        if (p && p.done) meta = 'Finished';
        else if (p) meta = `${Math.round(p.pct * 100)}% read` + (r.chars ? ` · ${books.readMins(r.chars * (1 - p.pct))} min left` : '');
        else meta = texts.has(r.id) ? 'Stored on this iPhone' : SRC_NAME[r.book.src] || '';
        return row(r.book, { meta, play: texts.has(r.id) ? () => openReader(r.book) : null, playIcon: 'book' });
      }
      const job = dl.jobFor(r.id);
      if (tab === 'downloaded') {
        const n = (r.book.chapters || []).length;
        meta = job ? `Downloading ${job.done} of ${job.total}` : r.dl >= n ? 'Downloaded' : `${r.dl} of ${n} chapters downloaded`;
      } else if (p && p.done) meta = 'Finished';
      else if (p) meta = `Chapter ${p.idx + 1} of ${p.n} · ${fmtDur(p.left)} left`;
      else meta = [fmtDur(r.book.secs), r.book.lang].filter(Boolean).join(' · ');
      const canPlay = r.book.chapters && r.book.chapters.length;
      return row(r.book, { meta, play: canPlay ? () => player.load(r.book) : null });
    }));
  }
  const redraw = () => { if (!el.hidden) draw(); };
  bus.on('lib', redraw);
  bus.on('dl', redraw);
  bus.on('texts', redraw);
  return { el, scroller, show: draw };
}

// ---------- Settings ----------
function swatch(t, name, on, onclick, big) {
  const v = theme.vars(t);
  return h('button', { class: 'sw' + (on ? ' on' : '') + (big ? ' big' : ''), onclick },
    h('div', { class: 'box' },
      h('b', { css: `background:${t.bg};color:${t.ink}`, text: 'Aa' }),
      h('i', { css: `background:${t.accent}` }),
      h('i', { css: `background:${t.hi};border-left:1.5px solid ${v['--ink']}` })),
    h('span', { text: name }));
}

async function themeFromPicture(source) {
  try {
    const { light, dark } = await theme.bothFromImage(source);
    openSheet('Colours from picture', h('div', { class: 'sh-pad' },
      h('div', { text: 'Pick the version you like.' }),
      h('div', { class: 'pair' },
        swatch(light, 'Light', false, () => { theme.useCustom(light); closeSheet(); toast('Theme applied'); }, true),
        swatch(dark, 'Dark', false, () => { theme.useCustom(dark); closeSheet(); toast('Theme applied'); }, true))));
  } catch {
    toast('That picture could not be read.');
  }
}

function SettingsView() {
  const themes = h('div', { class: 'themes' });
  const sources = h('div');
  const storage = h('small', { text: '…' });
  const langBtn = h('button', { class: 'line' });

  function drawThemes() {
    const tiles = theme.PRESETS.map(p => swatch(p, p.name, settings.theme === p.key, () => theme.usePreset(p.key)));
    if (settings.custom) tiles.push(swatch(settings.custom, 'Custom', settings.theme === 'custom', () => theme.useCustom(settings.custom)));
    themes.replaceChildren(...tiles);
  }

  function drawSources() {
    sources.replaceChildren(...settings.sourceOrder.filter(k => src.providers[k]).map((k, i) => {
      const p = src.providers[k], hl = src.health[k], off = !!settings.sourceOff[k];
      const status = off ? 'Switched off' : !hl ? 'Not checked yet' : hl.ok ? `Working · answered in ${hl.ms} ms` : `Not answering (${hl.err})`;
      return h('div', { class: 'line' },
        h('div', null,
          h('div', null, h('span', { class: 'dot' + (off || !hl ? '' : hl.ok ? ' ok' : ' bad') }), `${i + 1}. ${p.name}`),
          h('small', { text: status })),
        h('div', { css: 'display:flex;gap:8px;align-items:center' },
          i > 0 ? h('button', { class: 'sq', 'aria-label': `Use ${p.name} first`, onclick: () => {
            const o = settings.sourceOrder.filter(x => x !== k); o.unshift(k);
            saveSettings({ sourceOrder: o }); src.clearListCache(); drawSources();
          } }, icon('up', 18)) : null,
          toggle(!off, v => {
            const m = Object.assign({}, settings.sourceOff); m[k] = !v;
            saveSettings({ sourceOff: m }); src.clearListCache(); drawSources();
          })));
    }));
  }

  function drawLang() {
    const l = src.LANGS.find(x => x.key === settings.lang) || src.LANGS[0];
    langBtn.replaceChildren(h('div', null, 'Book language', h('small', { text: l.label })), icon('right', 18));
  }
  langBtn.onclick = () => openSheet('Book language', src.LANGS.map(l => h('button', {
    class: 'opt' + (l.key === settings.lang ? ' on' : ''), text: l.label,
    onclick: () => { saveSettings({ lang: l.key }); drawLang(); closeSheet(); },
  })));

  async function drawStorage() {
    const u = await dl.usage();
    const n = lib.all().filter(r => r.dl > 0).length;
    storage.textContent = `${n} book${n === 1 ? '' : 's'} downloaded · ${fmtBytes(u.used)} used`;
  }

  const pick = $('#pick');
  pick.addEventListener('change', () => { const f = pick.files && pick.files[0]; pick.value = ''; if (f) themeFromPicture(f); });

  const scroller = h('div', { class: 'scroll' },
    h('h3', { class: 'set-h', text: 'Colours' }),
    themes,
    h('button', { class: 'line', onclick: () => pick.click() },
      h('div', null, 'Colours from a photo', h('small', { text: 'Pick any picture and Hark builds a theme from it.' })), icon('image', 20)),
    h('button', { class: 'line', onclick: () => {
      const b = player.state.book;
      if (!b) return toast('Start a book first.');
      if (!b.coverCors) return toast('This book has no cover that can be read.');
      themeFromPicture(b.coverCors);
    } }, h('div', null, 'Colours from the current book', h('small', { text: 'Uses the cover of the book in the player.' })), icon('sparkle', 20)),
    h('div', { class: 'line' },
      h('div', null, 'Follow the cover', h('small', { text: 'Re-colour the app for each book you play.' })),
      toggle(settings.followCover, v => { saveSettings({ followCover: v }); theme.followCover(player.state.book); })),

    h('h3', { class: 'set-h', text: 'Playback' }),
    h('div', { class: 'line' }, h('div', { text: 'Skip back' }),
      seg([[10, '10 s'], [15, '15 s'], [30, '30 s']], settings.skipBack, v => saveSettings({ skipBack: v }))),
    h('div', { class: 'line' }, h('div', { text: 'Skip forward' }),
      seg([[15, '15 s'], [30, '30 s'], [60, '60 s']], settings.skipFwd, v => saveSettings({ skipFwd: v }))),
    h('div', { class: 'line' },
      h('div', null, 'Lock-screen buttons', h('small', { text: 'iPhone shows one pair, not both.' })),
      seg([['skip', 'Skip'], ['chapters', 'Chapters']], settings.lockButtons, v => saveSettings({ lockButtons: v }))),
    langBtn,

    h('h3', { class: 'set-h', text: 'Catalogue sources' }),
    sources,
    h('div', { class: 'pad', css: 'padding-top:12px' },
      h('button', { class: 'btn', onclick: async e => {
        const b = e.currentTarget; b.disabled = true; b.textContent = 'Testing…';
        await src.testAll();
        b.disabled = false; b.textContent = 'Test sources';
      } }, 'Test sources')),
    h('div', { class: 'fine', text: 'Hark asks the first source and moves to the next one if it fails. Both catalogues keep their audio files on archive.org, so downloaded books are the safety net if that site is unreachable.' }),

    h('h3', { class: 'set-h', text: 'Storage' }),
    h('div', { class: 'line' }, h('div', null, 'Downloads', storage),
      h('button', { class: 'sq', 'aria-label': 'Delete all downloads', onclick: () => confirmSheet('Delete downloads', 'Every downloaded chapter will be removed from this iPhone. Your saved books and listening positions stay.', 'Delete all', async () => { await dl.removeAll(); drawStorage(); toast('Downloads deleted'); }) }, icon('trash', 18))),

    h('h3', { class: 'set-h', text: 'About' }),
    h('div', { class: 'fine', text: 'Recordings come from LibriVox volunteers and are in the public domain in the USA. Rules differ by country, so check yours before reusing a recording. Hark stores your library only on this iPhone.' }),
    h('div', { class: 'fine', text: 'Hark 1.0' }));

  const el = h('section', { class: 'view', hidden: true },
    h('header', { class: 'bar' }, h('div', { class: 'bar-title plain', text: 'Settings' })), scroller);

  drawThemes(); drawSources(); drawLang();
  bus.on('settings', p => { if (p && ('theme' in p || 'custom' in p)) drawThemes(); });
  bus.on('health', () => { if (!el.hidden) drawSources(); });
  return { el, scroller, show() { drawSources(); drawStorage(); } };
}

// ---------- list page (genre / popular / new) ----------
function ListPage(kind, arg, isText) {
  const g = kind === 'genre' ? src.GENRES.find(x => x.key === arg) : null;
  const title = g ? g.label : isText ? (kind === 'fresh' ? 'Popular at Standard Ebooks' : 'Most downloaded at Project Gutenberg') : kind === 'latest' ? 'New arrivals' : 'Popular';
  const api = isText ? books : src;
  const k = g ? 'genre' : isText ? (kind === 'fresh' ? 'fresh' : 'popular') : kind === 'latest' ? 'latest' : 'popular';
  const host = h('div');
  const el = h('section', { class: 'view page' },
    h('header', { class: 'bar' },
      h('button', { class: 'bar-btn l', onclick: back, 'aria-label': 'Back' }, icon('back')),
      h('div', { class: 'bar-title plain', text: title }),
      h('div', { class: 'bar-btn' })),
    h('div', { class: 'scroll' }, host));
  pagedList(host, p => api.list(k, g ? arg : '', p));
  return { el };
}

// ---------- ebook page ----------
function TextPage(id) {
  let book = bookOf(id) || books.bookFromId(id);
  let busy = false, fullDesc = false;
  const head = h('div'), main = h('div', { class: 'pad' }), acts = h('div', { class: 'acts' }), info = h('div');
  const el = h('section', { class: 'view page' },
    h('header', { class: 'bar' },
      h('button', { class: 'bar-btn l', onclick: back, 'aria-label': 'Back' }, icon('back')),
      h('div', { class: 'bar-title', text: 'HARK' }),
      h('button', { class: 'bar-btn r', onclick: share, 'aria-label': 'Share' }, icon('share'))),
    h('div', { class: 'scroll' }, head, main, acts, info));
  const stored = () => texts.has(book.id);

  function share() {
    if (!book.link) return toast('This book came from your own file.');
    if (navigator.share) navigator.share({ title: book.title || 'Book', url: book.link }).catch(() => {});
    else if (navigator.clipboard) navigator.clipboard.writeText(book.link).then(() => toast('Link copied'), () => {});
  }

  function drawHead() {
    head.replaceChildren(h('div', { class: 'bk-head' },
      cover(book, true),
      h('div', { css: 'min-width:0;flex:1' },
        h('h1', { class: 'bk-title', text: book.title || 'Loading…' }),
        book.author ? h('div', { class: 'bk-by' }, 'By ', h('b', { text: book.author })) : null,
        h('div', { class: 'bk-by', text: SRC_NAME[book.src] || '' }))));
  }

  async function read() {
    if (busy) return;
    busy = true; drawMain();
    await openReader(book);
    busy = false; drawAll();
  }

  function drawMain() {
    const p = getProg(book.id);
    const label = busy ? (stored() ? 'Opening…' : 'Getting the book…') : p && p.done ? 'Read again' : p && p.pct > 0.003 ? `Continue · ${Math.round(p.pct * 100)}%` : 'Read';
    main.replaceChildren(h('button', { class: 'btn fill', disabled: busy, onclick: read }, icon('book', 20), label));
  }

  function drawActs() {
    const rec = lib.get(book.id);
    acts.replaceChildren(
      h('button', { class: stored() ? 'on' : '', onclick: onDownload }, icon(stored() ? 'check' : 'download', 22), stored() ? 'On this iPhone' : 'Download'),
      h('button', { class: rec && rec.saved ? 'on' : '', onclick: () => {
        const saved = !(rec && rec.saved);
        lib.upsert(book, { saved, savedAt: Date.now() });
        drawActs(); toast(saved ? 'Saved to your library' : 'Removed from saved');
      } }, icon(rec && rec.saved ? 'bookmarkFill' : 'bookmark', 22), rec && rec.saved ? 'Saved' : 'Save'),
      h('button', { onclick: listen }, icon('headphones', 22), 'Listen'));
  }

  async function onDownload() {
    if (stored()) {
      const own = book.src === 'file';
      return confirmSheet(own ? 'Delete this book' : 'Remove from this iPhone',
        own ? 'This book came from your own file. Deleting it removes it from Hark completely, with its notes.' : 'The stored copy will be deleted. Your notes and your page are kept, and you can download it again.',
        own ? 'Delete' : 'Remove', () => {
          texts.remove(book.id);
          if (own) { clearProg(book.id); lib.remove(book.id); back(); } else drawAll();
        });
    }
    if (busy) return;
    busy = true; drawMain();
    try {
      const t = await books.getText(book);
      lib.upsert(book, { chars: t.chars });
      toast('Stored for reading without a connection');
    } catch (e) { toast(`Download failed (${e.message}).`); }
    busy = false; drawAll();
  }

  async function listen() {
    toast('Looking for a recording…');
    try {
      const r = await src.list('search', books.searchTitle(book), 1);
      const sur = (book.author || '').toLowerCase().split(/[ ,]+/).filter(Boolean).pop();
      const hits = r.items.filter(b => !sur || (b.author || '').toLowerCase().includes(sur)).slice(0, 8);
      if (!hits.length) return toast('No free recording of this book was found.');
      openSheet('Listen to', hits.map(b => { remember(b); return h('button', { class: 'opt', onclick: () => { closeSheet(); openBook(b.id); } },
        h('div', { css: 'min-width:0' }, h('div', { class: 'ell', text: b.title }), h('small', { css: 'display:block;font-size:11px;color:var(--muted);margin-top:2px', text: [b.author, fmtDur(b.secs)].filter(Boolean).join(' · ') })), icon('right', 18)); }));
    } catch (e) { toast(e.message); }
  }

  function drawInfo() {
    const rec = lib.get(book.id);
    const chars = rec && rec.chars;
    const mins = chars ? books.readMins(chars) : 0;
    const rows = [
      ['Length', chars ? `${Math.round(chars / 6000)},000 words · about ${mins >= 90 ? Math.round(mins / 60) + ' h' : mins + ' min'}` : ''],
      ['Language', book.lang],
      ['Source', SRC_NAME[book.src]],
      ['Subjects', (book.subjects || []).slice(0, 4).join(', ')],
      ['Licence', book.src === 'file' ? '' : 'Public domain (USA)'],
    ].filter(r => r[1]);
    const kids = [h('dl', { class: 'meta' }, rows.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })]))];
    if (book.desc) {
      kids.push(h('div', { class: 'desc' + (fullDesc ? '' : ' clamp'), text: book.desc }));
      if (book.desc.length > 320) kids.push(h('div', { class: 'pad' }, h('button', { class: 'link', text: fullDesc ? 'Show less' : 'Read more', onclick: () => { fullDesc = !fullDesc; drawInfo(); } })));
    }
    const n = rec && rec.marks ? rec.marks.length : 0;
    if (n) kids.push(h('div', { class: 'fine', text: `${n} bookmark${n === 1 ? '' : 's'} and highlight${n === 1 ? '' : 's'} in this book. Open it and tap the list button to see them.` }));
    if (rec && book.src !== 'file') {
      kids.push(h('div', { class: 'pad' }, h('button', { class: 'link', text: 'Remove from library', onclick: () => confirmSheet('Remove from library', 'This forgets your page, your notes and the stored copy of this book.', 'Remove', () => {
        texts.remove(book.id); clearProg(book.id); lib.remove(book.id); drawAll(); toast('Removed');
      }) })));
    }
    info.replaceChildren(...kids);
  }

  function drawAll() { drawHead(); drawMain(); drawActs(); drawInfo(); }
  drawAll();
  if (book.src !== 'file' && !book.desc && !book.subjects) {
    books.getDetail(book).then(b => { book = remember(b); if (lib.get(book.id)) lib.upsert(book); drawAll(); }).catch(() => {});
  }
  const offs = [bus.on('texts', tid => { if (tid === book.id) { drawMain(); drawActs(); } })];
  return { el, destroy() { offs.forEach(f => f()); } };
}

// ---------- book page ----------
function BookPage(id) {
  let book = bookOf(id) || src.bookFromId(id);
  let error = '', loading = false, fullDesc = false;
  const head = h('div'), main = h('div', { class: 'pad' }), acts = h('div', { class: 'acts' });
  const info = h('div'), chList = h('div'), epub = h('div', { class: 'pad', css: 'padding-top:12px' });
  const el = h('section', { class: 'view page' },
    h('header', { class: 'bar' },
      h('button', { class: 'bar-btn l', onclick: back, 'aria-label': 'Back' }, icon('back')),
      h('div', { class: 'bar-title', text: 'HARK' }),
      h('button', { class: 'bar-btn r', onclick: share, 'aria-label': 'Share' }, icon('share'))),
    h('div', { class: 'scroll' }, head, main, acts, epub, info, chList));

  const hasCh = () => !!(book.chapters && book.chapters.length);
  const isCurrent = () => player.state.book && player.state.book.id === book.id;

  function share() {
    const url = book.link || (book.iaId ? `https://archive.org/details/${book.iaId}` : '');
    if (navigator.share && url) navigator.share({ title: book.title || 'Audiobook', url }).catch(() => {});
    else if (url && navigator.clipboard) navigator.clipboard.writeText(url).then(() => toast('Link copied'), () => {});
  }

  function drawHead() {
    head.replaceChildren(h('div', { class: 'bk-head' },
      cover(book, true),
      h('div', { css: 'min-width:0;flex:1' },
        h('h1', { class: 'bk-title', text: book.title || 'Loading…' }),
        book.author ? h('div', { class: 'bk-by' }, 'By ', h('b', { text: book.author })) : null,
        book.readers ? h('div', { class: 'bk-by' }, 'Read by ', h('b', { text: book.readers })) : null)));
  }

  function drawMain() {
    const s = player.state, cur = isCurrent();
    let label, ic = 'play', fn;
    if (!hasCh()) {
      main.replaceChildren(error
        ? h('div', null, h('div', { class: 'note', css: 'margin:0 0 12px', text: error }), h('button', { class: 'btn', onclick: fetchDetail }, 'Try again'))
        : h('button', { class: 'btn fill', disabled: true }, 'Loading chapters…'));
      return;
    }
    const p = getProg(book.id);
    if (cur && (s.playing || s.loading)) { label = 'Pause'; ic = 'pause'; fn = () => player.pause(); }
    else if (cur) { label = 'Resume'; fn = () => player.play(); }
    else if (p && !p.done && (p.idx > 0 || p.t > 5)) {
      label = `Resume · chapter ${p.idx + 1}, ${fmtClock(p.t)}`; fn = () => { player.load(book); openPlayer(); };
    } else { label = p && p.done ? 'Listen again' : 'Play'; fn = () => { player.load(book); openPlayer(); }; }
    main.replaceChildren(h('button', { class: 'btn fill', onclick: fn }, icon(ic, 20), label));
  }

  function drawActs() {
    const rec = lib.get(book.id), job = dl.jobFor(book.id);
    const n = hasCh() ? book.chapters.length : 0, got = hasCh() ? dl.countFor(book) : 0;
    let dIcon = 'download', dLabel = 'Download', dOn = false;
    if (job) { dIcon = 'x'; dLabel = `${job.done} of ${job.total} · stop`; }
    else if (n && got === n) { dIcon = 'check'; dLabel = 'Downloaded'; dOn = true; }
    else if (got) dLabel = `${got} of ${n} · continue`;
    acts.replaceChildren(
      h('button', { class: dOn ? 'on' : '', disabled: !hasCh() || !dl.supported, onclick: onDownload }, icon(dIcon, 22), dLabel),
      h('button', { class: rec && rec.saved ? 'on' : '', onclick: () => {
        const saved = !(rec && rec.saved);
        lib.upsert(book, { saved, savedAt: Date.now() });
        if (saved) dl.keepCover(book);
        drawActs(); toast(saved ? 'Saved to your library' : 'Removed from saved');
      } }, icon(rec && rec.saved ? 'bookmarkFill' : 'bookmark', 22), rec && rec.saved ? 'Saved' : 'Save'),
      h('button', { class: rec && rec.textId ? 'on' : '', onclick: () => readAlong(false), disabled: !hasCh() }, icon('book', 22), 'Read along'));
    const linked = rec && rec.textId && lib.get(rec.textId);
    epub.replaceChildren(h('button', { class: 'btn', disabled: !hasCh(), onclick: pickBookFile }, icon('filePlus', 20),
      linked ? 'Replace the book file (EPUB)' : 'Add the book file (EPUB)'));
  }

  // Open the book's text beside the recording. The first time, the reader picks which edition.
  // Pair a text with this recording and open it beside the audio.
  async function startText(t) {
    remember(t);
    lib.upsert(book, { textId: t.id });
    if (!isCurrent()) player.load(book, { autoplay: false });
    toast('Opening the text…');
    await openReader(t, { follow: true });
    drawActs(); drawInfo();
  }
  // Your own book file (EPUB or text) from the phone becomes this recording's text.
  function pickBookFile() {
    const inp = h('input', { type: 'file' });
    inp.addEventListener('change', async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      toast('Adding the book…');
      try {
        const t = await books.importFile(f);
        lib.upsert(t, { saved: true, savedAt: Date.now() });
        startText(t);
      } catch (e) { toast(`Could not add that file (${e.message}).`); }
    });
    inp.click();
  }

  async function readAlong(change) {
    const rec = lib.get(book.id);
    const start = startText, pickFile = pickBookFile;
    if (!change && rec && rec.textId) return start(bookOf(rec.textId) || books.bookFromId(rec.textId));
    let found = [];
    if (!book.own) toast('Looking for the text…');
    try { found = await books.findText(book); } catch { /* offline or no source: the file option still works */ }
    openSheet('Read along with', [
      h('button', { class: 'opt', onclick: () => { closeSheet(); pickFile(); } },
        h('div', { css: 'min-width:0' }, h('div', { text: 'A book file on this iPhone' }),
          h('small', { css: 'display:block;font-size:11px;color:var(--muted);margin-top:2px', text: 'Pick an EPUB or text file you own.' })),
        icon('filePlus', 18)),
      ...found.map(t => h('button', { class: 'opt', onclick: () => { closeSheet(); start(t); } },
        h('div', { css: 'min-width:0' }, h('div', { class: 'ell', text: t.title }),
          h('small', { css: 'display:block;font-size:11px;color:var(--muted);margin-top:2px', text: [t.author, SRC_NAME[t.src]].filter(Boolean).join(' · ') })),
        icon('right', 18))),
      h('div', { class: 'fine', text: (found.length ? '' : 'No free edition of this book was found. ') + 'The text follows the recording chapter by chapter where the headings match, and by position in the book otherwise. It does not follow word by word.' }),
    ]);
  }

  function onDownload() {
    if (book.own) return toast('This is your own file. Use Remove from library to delete it.');
    if (dl.jobFor(book.id)) return dl.cancel(book.id);
    if (dl.isComplete(book)) {
      return confirmSheet('Remove download', 'The downloaded chapters of this book will be deleted from this iPhone. You can still stream it.', 'Remove', () => dl.removeBook(book));
    }
    lib.upsert(book);
    dl.downloadBook(book);
    toast('Downloading — keep Hark open until it finishes.');
  }

  function drawInfo() {
    const rows = [
      ['Length', fmtDur(book.secs)],
      ['Chapters', hasCh() ? String(book.chapters.length) : ''],
      ['Language', book.lang],
      ['Source', book.own ? 'Your file' : book.via ? src.providers[book.via].name : book.src && src.providers[book.src] ? src.providers[book.src].name : ''],
      ['Licence', book.own ? '' : 'Public domain (USA)'],
    ].filter(r => r[1]);
    const kids = [h('dl', { class: 'meta' }, rows.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })]))];
    if (book.desc) {
      const d = h('div', { class: 'desc' + (fullDesc ? '' : ' clamp'), text: book.desc });
      kids.push(d);
      if (book.desc.length > 320) kids.push(h('div', { class: 'pad' }, h('button', { class: 'link', text: fullDesc ? 'Show less' : 'Read more', onclick: () => { fullDesc = !fullDesc; drawInfo(); } })));
    }
    if (lib.get(book.id) && lib.get(book.id).textId) kids.push(h('div', { class: 'pad' }, h('button', { class: 'link', text: 'Choose a different text for Read along', onclick: () => readAlong(true) })));
    if (lib.get(book.id)) {
      kids.push(h('div', { class: 'pad' }, h('button', { class: 'link', text: 'Remove from library', onclick: () => confirmSheet('Remove from library', 'This forgets your place in this book and deletes its downloaded chapters.', 'Remove', async () => {
        if (isCurrent()) player.unload();
        await dl.removeBook(book);
        clearProg(book.id);
        lib.remove(book.id);
        drawAll(); toast('Removed');
      }) })));
    }
    info.replaceChildren(...kids);
  }

  let onIdx = -1;
  function drawChapters() {
    if (!hasCh()) { chList.replaceChildren(); return; }
    onIdx = isCurrent() ? player.state.idx : -1;
    chList.replaceChildren(
      h('div', { class: 'sec' }, h('h3', { text: 'Chapters' })),
      ...book.chapters.map((c, i) => h('button', { class: 'ch' + (i === onIdx ? ' on' : ''), onclick: () => { player.load(book, { idx: i, t: 0 }); } },
        h('span', { class: 'n', text: String(i + 1).padStart(2, '0') }),
        h('span', { class: 'ct ell', text: c.title }),
        h('span', { class: 'd' }, dl.hasUrl(c.url) ? icon('check', 14) : null, c.secs ? fmtClock(c.secs) : ''))));
  }
  function markChapter() {
    const idx = isCurrent() ? player.state.idx : -1;
    if (idx === onIdx || !hasCh()) return;
    const rows = chList.querySelectorAll('.ch');
    if (rows[onIdx]) rows[onIdx].classList.remove('on');
    if (rows[idx]) rows[idx].classList.add('on');
    onIdx = idx;
  }

  function drawAll() { drawHead(); drawMain(); drawActs(); drawInfo(); drawChapters(); }

  async function fetchDetail() {
    if (loading) return;
    loading = true; error = '';
    drawMain();
    try {
      book = remember(await src.getBook(book));
      if (lib.get(book.id)) lib.upsert(book);
    } catch (e) { error = e.message; }
    loading = false;
    drawAll();
  }

  drawAll();
  if (!book.own && (!hasCh() || !book.desc)) fetchDetail();

  const offs = [
    player.on('state', () => { if (!document.hidden) { drawMain(); markChapter(); } }),
    bus.on('dl', (bid, err) => {
      if (bid !== book.id && bid !== '*') return;
      drawActs(); drawChapters();
      if (err) toast(err);
      else if (!dl.jobFor(book.id) && dl.isComplete(book)) toast('Download finished');
    }),
  ];
  return { el, destroy() { offs.forEach(f => f()); } };
}

function chapterOptions(book, onpick) {
  const curIdx = player.state.book && player.state.book.id === book.id ? player.state.idx : -1;
  return book.chapters.map((c, i) => h('button', { class: 'opt' + (i === curIdx ? ' on' : ''), onclick: () => { closeSheet(); onpick(i); } },
    h('span', { class: 'ell', text: `${String(i + 1).padStart(2, '0')}  ${c.title}` }),
    h('span', { css: 'font-size:11px;flex:none', text: c.secs ? fmtClock(c.secs) : '' })));
}

// ---------- full-screen player ----------
let openPlayer = () => {};

function buildPlayer() {
  const root = $('#player');
  const coverBox = h('div');
  const title = h('div', { class: 'pl-title' }), chName = h('div', { class: 'pl-ch ell' }), by = h('div', { class: 'pl-by ell' });
  const range = h('input', { type: 'range', min: 0, max: 100, step: 1, value: 0, 'aria-label': 'Position in chapter' });
  const tCur = h('span', { text: '0:00' }), tRem = h('span', { text: '-0:00' });
  const pp = h('button', { class: 'pp', 'aria-label': 'Play or pause', onclick: () => player.toggle() }, icon('play', 30));
  const nBack = h('span', { class: 'skipn' }), nFwd = h('span', { class: 'skipn' });
  const speedBtn = h('button', { onclick: speedSheet });
  const sleepLabel = h('span', { text: 'Sleep' });
  const sleepBtn = h('button', { onclick: sleepSheet }, icon('moon', 18), sleepLabel);
  const top = h('div', { class: 'pl-top' },
    h('header', { class: 'bar' },
      h('button', { class: 'bar-btn l', onclick: close, 'aria-label': 'Close player' }, icon('down')),
      h('div', { class: 'bar-title plain', text: 'Now playing' }),
      h('button', { class: 'bar-btn r', 'aria-label': 'Open book page', onclick: () => { const b = player.state.book; close(); if (b) openBook(b.id); } }, icon('shelf'))),
    h('div', { class: 'pl-body' }, coverBox, title, chName, by));
  root.append(top,
    h('div', { class: 'pl-ctl' },
      range,
      h('div', { class: 'pl-times' }, tCur, tRem),
      h('div', { class: 'pl-main' },
        h('button', { 'aria-label': 'Previous chapter', onclick: () => player.prev() }, icon('prev', 26)),
        h('button', { 'aria-label': 'Skip back', onclick: () => player.skip(-settings.skipBack) }, icon('ccw', 34), nBack),
        pp,
        h('button', { 'aria-label': 'Skip forward', onclick: () => player.skip(settings.skipFwd) }, icon('cw', 34), nFwd),
        h('button', { 'aria-label': 'Next chapter', onclick: () => player.next() }, icon('next', 26))),
      h('div', { class: 'pl-sub' },
        speedBtn, sleepBtn,
        h('button', { onclick: () => { const b = player.state.book; if (b) openSheet('Chapters', chapterOptions(b, i => player.goTo(i))); } }, icon('list', 18), 'Chapters'))));

  let isOpen = false, scrubbing = false, shownBook = '', lastIcon = '', lastErr = '';

  function setP(t, dur) { range.style.setProperty('--p', (dur ? clamp(t / dur * 100, 0, 100) : 0).toFixed(2) + '%'); }
  function drawTime(s) {
    if (!isOpen) return;
    const dur = Math.max(1, Math.round(s.dur || 0));
    if (!scrubbing) {
      if (Number(range.max) !== dur) range.max = dur;
      range.value = Math.round(s.t);
      setP(s.t, s.dur);
      tCur.textContent = fmtClock(s.t);
      tRem.textContent = '-' + fmtClock(Math.max(0, (s.dur || 0) - s.t));
    }
    drawSleep(s);
  }
  function drawSleep(s) {
    const txt = !s.sleep ? 'Sleep' : s.sleep.type === 'chapter' ? 'Chapter end' : `${Math.max(1, Math.ceil(player.sleepLeft() / 60000))} min`;
    if (sleepLabel.textContent !== txt) sleepLabel.textContent = txt;
  }
  function drawState(s) {
    if (s.error && s.error !== lastErr) toast(s.error);
    lastErr = s.error;
    if (!s.book) { if (isOpen) close(); return; }
    if (!isOpen) return;
    if (shownBook !== s.book.id) { shownBook = s.book.id; coverBox.replaceChildren(cover(s.book, true)); }
    const ch = player.chapter();
    title.textContent = s.book.title;
    chName.textContent = ch ? `${s.idx + 1}/${s.book.chapters.length} · ${ch.title}` : '';
    by.textContent = s.book.author || '';
    const ic = s.playing ? 'pause' : 'play';
    if (ic !== lastIcon) { pp.replaceChildren(icon(ic, 30)); lastIcon = ic; }
    pp.classList.toggle('busy', !!s.loading);
    speedBtn.textContent = `${s.rate}× speed`;
    nBack.textContent = settings.skipBack; nFwd.textContent = settings.skipFwd;
    drawTime(s);
  }

  range.addEventListener('input', () => {
    scrubbing = true;
    const v = Number(range.value);
    setP(v, player.state.dur);
    tCur.textContent = fmtClock(v);
    tRem.textContent = '-' + fmtClock(Math.max(0, (player.state.dur || 0) - v));
  });
  range.addEventListener('change', () => { scrubbing = false; player.seek(Number(range.value)); });

  function speedSheet() {
    const rates = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
    openSheet('Playback speed', h('div', { class: 'opts4' }, rates.map(r => h('button', {
      class: 'chip' + (r === player.state.rate ? ' on' : ''), text: r + '×', onclick: () => { player.setRate(r); closeSheet(); },
    }))));
  }
  function sleepSheet() {
    const s = player.state.sleep;
    const opts = [[null, 'Off'], [5, '5 minutes'], [10, '10 minutes'], [15, '15 minutes'], [30, '30 minutes'], [45, '45 minutes'], [60, '1 hour'], ['chapter', 'End of this chapter']];
    openSheet('Sleep timer', opts.map(([v, label]) => h('button', {
      class: 'opt' + ((!s && v === null) || (s && s.type === 'chapter' && v === 'chapter') ? ' on' : ''), text: label,
      onclick: () => { player.setSleep(v); closeSheet(); toast(v ? `Stops ${v === 'chapter' ? 'at the end of this chapter' : 'in ' + label}` : 'Sleep timer off'); },
    })));
  }

  function open() {
    if (!player.state.book) return;
    isOpen = true;
    root.classList.add('open');
    root.setAttribute('aria-hidden', 'false');
    drawState(player.state);
  }
  function close() {
    isOpen = false;
    root.classList.remove('open');
    root.style.transform = '';
    root.setAttribute('aria-hidden', 'true');
  }
  openPlayer = open;

  // Pull down to close.
  let y0 = null, dy = 0;
  top.addEventListener('touchstart', e => { y0 = e.touches[0].clientY; dy = 0; }, { passive: true });
  top.addEventListener('touchmove', e => {
    if (y0 == null) return;
    dy = e.touches[0].clientY - y0;
    if (dy > 8) { root.classList.add('drag'); root.style.transform = `translateY(${dy}px)`; }
  }, { passive: true });
  const end = () => {
    if (y0 == null) return;
    y0 = null;
    root.classList.remove('drag');
    if (dy > 110) close(); else root.style.transform = '';
  };
  top.addEventListener('touchend', end);
  top.addEventListener('touchcancel', end);

  player.on('state', drawState);
  player.on('time', drawTime);
  bus.on('settings', p => { if (p && ('skipBack' in p || 'skipFwd' in p)) drawState(player.state); });
}

// ---------- start ----------
export function initUI() {
  buildTabs();
  buildMini();
  buildPlayer();
  buildReader();
  views.home = HomeView();
  views.read = ReadView();
  views.search = SearchView();
  views.library = LibraryView();
  views.settings = SettingsView();
  for (const k in views) screens.append(views[k].el);
  $('#scrim').addEventListener('click', closeSheet);

  player.on('book', b => theme.followCover(b));
  player.on('finished', b => toast(`Finished: ${b.title}`));

  // A page opened directly needs a tab underneath it to go back to.
  if (/^#\/(book|list|text|tlist)\//.test(location.hash)) {
    const target = location.hash;
    history.replaceState(null, '', '#/home');
    history.pushState(null, '', target);
  }
  addEventListener('hashchange', route);
  route();
}
