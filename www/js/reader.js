// The reader: pages or scrolling, type settings, contents, bookmarks, highlights with notes,
// search inside the book, and following along with the audiobook that is playing.
import { $, h, icon, clamp, debounce } from './util.js';
import { settings, saveSettings, lib, getProg, setProg, flushProg } from './store.js';
import * as books from './books.js';
import * as player from './player.js';
import { toast, openSheet, closeSheet, seg, toggle } from './kit.js';

const R = { open: false, book: null, secs: [], chars: 0, sec: 0, page: 0, pages: 1, W: 0, follow: false, plain: [] };
let root, stage, flow, endNav, titleEl, footL, footR, footBar, selBar, audioBar, auTitle, auBtn, bmBtn;
let wake = null;
let heardIdx = -1, heardBook = ''; // the audio chapter the text was last lined up with

const prefs = () => settings.reader;
const setPref = patch => saveSettings({ reader: Object.assign({}, settings.reader, patch) });
const marks = () => (lib.get(R.book.id) && lib.get(R.book.id).marks) || [];
const saveMarks = list => lib.upsert(R.book, { marks: list });

const FONTS = {
  serif: 'ui-serif, "New York", "Iowan Old Style", Georgia, serif',
  sans: 'system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif',
  round: 'ui-rounded, "SF Pro Rounded", system-ui, sans-serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
};
const TONES = {
  paper: ['#FBF5E6', '#1C1A17'], sepia: ['#F1E3C6', '#3A2E1F'], grey: ['#2B2B2E', '#DEDBD3'], black: ['#000000', '#C9C4BA'],
};
const mixHex = (a, b, t) => '#' + [1, 3, 5].map(i => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - t) + parseInt(b.slice(i, i + 2), 16) * t).toString(16).padStart(2, '0')).join('');

// ---------- layout ----------
function applyLook() {
  const p = prefs(), st = root.style;
  for (const k of ['--bg', '--ink', '--muted', '--soft']) st.removeProperty(k);
  const tone = TONES[p.tone];
  if (tone) {
    st.setProperty('--bg', tone[0]); st.setProperty('--ink', tone[1]);
    st.setProperty('--muted', mixHex(tone[1], tone[0], 0.4)); st.setProperty('--soft', mixHex(tone[1], tone[0], 0.84));
  }
  flow.style.fontFamily = FONTS[p.font] || FONTS.serif;
  flow.style.fontSize = p.size + 'px';
  flow.style.lineHeight = String(p.lh);
  flow.style.textAlign = p.align === 'justify' ? 'justify' : 'left';
  flow.classList.toggle('hyph', p.align === 'justify');
}

function layout() {
  const p = prefs(), m = p.margin;
  const pages = p.mode === 'pages';
  stage.classList.toggle('scrolling', !pages);
  const W = R.W = stage.clientWidth, H = stage.clientHeight;
  const fs = flow.style;
  if (pages) {
    fs.width = (W - 2 * m) + 'px'; fs.height = (H - 32) + 'px';
    fs.margin = `16px ${m}px`; fs.padding = '0';
    fs.columnWidth = (W - 2 * m) + 'px'; fs.columnGap = (2 * m) + 'px';
    R.pages = Math.max(1, Math.round((flow.scrollWidth + 2 * m) / W));
  } else {
    fs.width = ''; fs.height = ''; fs.margin = '0'; fs.padding = `18px ${m}px 8px`;
    fs.columnWidth = ''; fs.columnGap = ''; fs.transform = '';
    R.pages = 1;
  }
  endNav.hidden = pages;
}

function frac() {
  if (prefs().mode === 'pages') return R.pages > 1 ? R.page / R.pages : 0;
  const max = stage.scrollHeight - stage.clientHeight;
  return max > 0 ? clamp(stage.scrollTop / max, 0, 1) : 0;
}
function overall(f = frac()) {
  let before = 0;
  for (let i = 0; i < R.sec; i++) before += R.secs[i].len;
  return R.chars ? clamp((before + f * R.secs[R.sec].len) / R.chars, 0, 1) : 0;
}

function setPage(p, animate) {
  R.page = clamp(p, 0, R.pages - 1);
  flow.style.transition = animate ? 'transform .18s ease-out' : 'none';
  flow.style.transform = `translateX(${-R.page * R.W}px)`;
  status();
}

const persist = debounce(() => save(false), 700);
function save(flush) {
  if (!R.book) return;
  const f = frac(), pct = overall(f);
  const last = R.sec === R.secs.length - 1;
  const done = last && (prefs().mode === 'pages' ? R.page >= R.pages - 1 : f > 0.98);
  setProg(R.book.id, { sec: R.sec, frac: f, pct: done ? 1 : pct, at: Date.now(), done }, flush);
}

function status() {
  if (!R.book) return;
  const s = R.secs[R.sec], f = frac(), pct = overall(f);
  titleEl.textContent = s.title;
  footL.textContent = prefs().mode === 'pages' ? `Page ${R.page + 1} of ${R.pages}` : `${Math.round(f * 100)}% of chapter`;
  const left = books.readMins(s.len * (1 - (prefs().mode === 'pages' ? (R.page + 1) / R.pages : f)));
  const end = prefs().mode === 'pages' ? R.page >= R.pages - 1 : f > 0.97;
  footR.textContent = `${end ? 'End of chapter' : left + ' min left in chapter'} · ${Math.round(pct * 100)}%`;
  footBar.style.transform = `scaleX(${pct})`;
  const here = bookmarkHere();
  bmBtn.replaceChildren(icon(here >= 0 ? 'bookmarkFill' : 'bookmark', 22));
  persist();
}

/** Show a section. where: { frac } | { offset, len } | { end:true } */
function render(sec, where = {}) {
  R.sec = clamp(sec, 0, R.secs.length - 1);
  flow.style.transition = 'none';
  flow.style.transform = '';
  flow.innerHTML = R.secs[R.sec].html; // built from an allow-list when the book was added
  marks().forEach((m, i) => { if (m.type === 'hl' && m.sec === R.sec) wrap(m.a, m.b, m.note ? 'hl noted' : 'hl', i); });
  const next = R.secs[R.sec + 1], prev = R.secs[R.sec - 1];
  endNav.replaceChildren(
    prev ? h('button', { class: 'btn', onclick: () => render(R.sec - 1, { frac: 0 }) }, icon('back', 18), 'Previous') : null,
    next ? h('button', { class: 'btn fill', onclick: () => render(R.sec + 1, { frac: 0 }) }, 'Next: ' + next.title.slice(0, 28), icon('right', 18)) : h('div', { class: 'fine', text: 'The end.' }));
  stage.scrollTop = 0;
  layout();
  let target = null;
  if (where.offset != null) target = wrap(where.offset, where.offset + (where.len || 1), 'found');
  if (prefs().mode === 'pages') {
    let p = where.end ? R.pages - 1 : Math.min(R.pages - 1, Math.floor((where.frac || 0) * R.pages + 0.001));
    if (target) p = Math.floor((target.getBoundingClientRect().left - stage.getBoundingClientRect().left) / R.W);
    setPage(p, false);
  } else {
    const max = stage.scrollHeight - stage.clientHeight;
    stage.scrollTop = target ? Math.max(0, target.offsetTop - 90) : where.end ? max : (where.frac || 0) * max;
    status();
  }
}

/** Wraps the characters a..b of the section in <mark>; returns the first mark. */
function wrap(a, b, cls, idx) {
  const w = document.createTreeWalker(flow, NodeFilter.SHOW_TEXT);
  const hits = [];
  let pos = 0, n;
  while ((n = w.nextNode())) {
    const len = n.data.length, s = Math.max(a, pos), e = Math.min(b, pos + len);
    if (s < e) hits.push([n, s - pos, e - pos]);
    pos += len;
    if (pos >= b) break;
  }
  let first = null;
  for (const [node, s, e] of hits) {
    const r = document.createRange();
    r.setStart(node, s); r.setEnd(node, e);
    const m = document.createElement('mark');
    m.className = cls;
    if (idx != null) m.dataset.i = idx;
    r.surroundContents(m);
    first = first || m;
  }
  return first;
}
function offsetAt(node, off) {
  const r = document.createRange();
  r.selectNodeContents(flow);
  r.setEnd(node, off);
  return r.toString().length;
}

// ---------- moving ----------
function next() {
  if (prefs().mode !== 'pages') return;
  if (R.page < R.pages - 1) setPage(R.page + 1, true);
  else if (R.sec < R.secs.length - 1) render(R.sec + 1, { frac: 0 });
}
function prev() {
  if (prefs().mode !== 'pages') return;
  if (R.page > 0) setPage(R.page - 1, true);
  else if (R.sec > 0) render(R.sec - 1, { end: true });
}
function relayout() {
  if (!R.open) return;
  const f = frac();
  applyLook(); layout();
  if (prefs().mode === 'pages') setPage(Math.min(R.pages - 1, Math.floor(f * R.pages + 0.001)), false);
  else { stage.scrollTop = f * (stage.scrollHeight - stage.clientHeight); status(); }
}

// ---------- bookmarks, highlights, notes ----------
function bookmarkHere() {
  const f = frac(), span = prefs().mode === 'pages' ? 1 / R.pages : 0.04;
  return marks().findIndex(m => m.type === 'bm' && m.sec === R.sec && m.frac >= f - 0.0005 && m.frac < f + span);
}
function toggleBookmark() {
  const list = [...marks()], i = bookmarkHere();
  if (i >= 0) { list.splice(i, 1); toast('Bookmark removed'); }
  else { list.push({ type: 'bm', sec: R.sec, frac: frac(), pct: overall(), at: Date.now() }); toast('Bookmarked'); }
  saveMarks(list);
  status();
}

function selection() {
  const s = getSelection();
  if (!s || s.isCollapsed || !s.rangeCount || !flow.contains(s.anchorNode) || !flow.contains(s.focusNode)) return null;
  const r = s.getRangeAt(0);
  const a = offsetAt(r.startContainer, r.startOffset), b = offsetAt(r.endContainer, r.endOffset);
  return b > a ? { a, b, text: s.toString().replace(/\s+/g, ' ').trim().slice(0, 240) } : null;
}
function addHighlight(withNote) {
  const sel = selection();
  if (!sel) return;
  const list = [...marks()];
  list.push({ type: 'hl', sec: R.sec, a: sel.a, b: sel.b, text: sel.text, note: '', pct: overall(), at: Date.now() });
  saveMarks(list);
  getSelection().removeAllRanges();
  selBar.hidden = true;
  const keep = frac();
  render(R.sec, { frac: keep });
  if (withNote) editMark(list.length - 1);
}
function editMark(i) {
  const m = marks()[i];
  if (!m) return;
  const ta = h('textarea', { class: 'note-in', placeholder: 'Add a note…', rows: 4, value: m.note || '' });
  const keep = frac();
  openSheet('Highlight', h('div', { class: 'sh-pad' },
    h('div', { class: 'quote', text: m.text }),
    ta,
    h('div', { class: 'pair' },
      h('button', { class: 'btn', onclick: () => { const l = [...marks()]; l.splice(i, 1); saveMarks(l); closeSheet(); if (m.sec === R.sec) render(R.sec, { frac: keep }); } }, icon('trash', 18), 'Remove'),
      h('button', { class: 'btn fill', onclick: () => { const l = [...marks()]; l[i] = Object.assign({}, m, { note: ta.value.trim() }); saveMarks(l); closeSheet(); if (m.sec === R.sec) render(R.sec, { frac: keep }); } }, 'Save note'))));
}

// ---------- menu: contents / notes / search ----------
function plain(i) {
  if (R.plain[i] == null) { const d = document.createElement('div'); d.innerHTML = R.secs[i].html; R.plain[i] = d.textContent; }
  return R.plain[i];
}
function menu(tab = 'contents') {
  const body = h('div');
  const head = h('div', { class: 'sh-seg' }, seg([['contents', 'Contents'], ['notes', 'Notes'], ['search', 'Search']], tab, t => draw(t)));
  function draw(t) {
    if (t === 'contents') {
      body.replaceChildren(...R.secs.map((s, i) => h('button', { class: 'opt' + (i === R.sec ? ' on' : ''), onclick: () => { closeSheet(); render(i, { frac: 0 }); } },
        h('span', { class: 'ell', text: s.title }), h('span', { css: 'font-size:11px;flex:none', text: books.readMins(s.len) + ' min' }))));
      const on = body.querySelector('.on');
      if (on) requestAnimationFrame(() => on.scrollIntoView({ block: 'center' }));
    } else if (t === 'notes') {
      const list = marks().map((m, i) => ({ m, i })).sort((x, y) => x.m.sec - y.m.sec || (x.m.a || x.m.frac * 1e9) - (y.m.a || y.m.frac * 1e9));
      if (!list.length) { body.replaceChildren(h('div', { class: 'empty' }, h('h4', { text: 'No notes yet' }), h('div', { text: 'Tap the bookmark at the top to mark a page. Select words to highlight them or add a note.' }))); return; }
      body.replaceChildren(...list.map(({ m, i }) => h('div', { class: 'opt', role: 'button', onclick: () => { closeSheet(); render(m.sec, m.type === 'hl' ? { offset: m.a, len: 0 } : { frac: m.frac }); } },
        h('div', { css: 'min-width:0' },
          h('div', { class: m.type === 'hl' ? 'clamp2' : '', text: m.type === 'hl' ? `“${m.text}”` : 'Bookmark' }),
          m.note ? h('div', { class: 'clamp2', css: 'font-size:12px;margin-top:4px', text: 'Note: ' + m.note }) : null,
          h('small', { css: 'display:block;font-size:11px;color:var(--muted);margin-top:3px', text: `${R.secs[m.sec] ? R.secs[m.sec].title : ''} · ${Math.round((m.pct || 0) * 100)}%` })),
        h('button', { class: 'sq', 'aria-label': 'Delete', onclick: e => { e.stopPropagation(); const l = [...marks()]; l.splice(i, 1); saveMarks(l); draw('notes'); if (m.sec === R.sec) render(R.sec, { frac: frac() }); } }, icon('trash', 16)))));
    } else {
      const input = h('input', { type: 'search', placeholder: 'Find in this book', autocomplete: 'off', autocapitalize: 'off', enterKeyHint: 'search' });
      const res = h('div');
      const run = () => {
        const q = input.value.trim().toLowerCase();
        if (q.length < 2) { res.replaceChildren(); return; }
        const out = [];
        for (let i = 0; i < R.secs.length && out.length < 60; i++) {
          const text = plain(i), low = text.toLowerCase();
          for (let at = low.indexOf(q); at >= 0 && out.length < 60; at = low.indexOf(q, at + q.length)) {
            out.push({ sec: i, a: at, snip: text.slice(Math.max(0, at - 40), at + q.length + 60).replace(/\s+/g, ' ') });
          }
        }
        res.replaceChildren(...(out.length ? out.map(r => h('button', { class: 'opt', onclick: () => { closeSheet(); render(r.sec, { offset: r.a, len: q.length }); } },
          h('div', { css: 'min-width:0' }, h('div', { class: 'clamp2', text: '…' + r.snip + '…' }), h('small', { css: 'display:block;font-size:11px;color:var(--muted);margin-top:3px', text: R.secs[r.sec].title }))))
          : [h('div', { class: 'empty', text: 'No matches.' })]));
      };
      input.addEventListener('input', debounce(run, 350));
      input.addEventListener('keydown', e => { if (e.key === 'Enter') { run(); input.blur(); } });
      body.replaceChildren(h('div', { css: 'padding:12px 16px' }, h('div', { class: 'field' }, icon('search', 20), input)), res);
    }
  }
  draw(tab);
  openSheet(R.book.title || 'Book', h('div', null, head, body));
}

// ---------- type settings ----------
function typeSheet() {
  const p = prefs();
  const size = h('span', { css: 'min-width:44px;text-align:center', text: p.size + ' px' });
  const step = d => { const v = clamp(prefs().size + d, 13, 30); setPref({ size: v }); size.textContent = v + ' px'; relayout(); };
  const line = (label, ctl) => h('div', { class: 'line' }, h('div', { text: label }), ctl);
  openSheet('Reading settings', h('div', null,
    line('Text size', h('div', { css: 'display:flex;align-items:center;gap:8px' },
      h('button', { class: 'sq', 'aria-label': 'Smaller text', onclick: () => step(-1) }, 'A−'), size,
      h('button', { class: 'sq', 'aria-label': 'Larger text', onclick: () => step(1) }, 'A+'))),
    line('Typeface', seg([['serif', 'Serif'], ['sans', 'Sans'], ['round', 'Round'], ['mono', 'Mono']], p.font, v => { setPref({ font: v }); relayout(); })),
    line('Line spacing', seg([[1.35, 'Tight'], [1.6, 'Normal'], [1.85, 'Open']], p.lh, v => { setPref({ lh: v }); relayout(); })),
    line('Margins', seg([[14, 'Narrow'], [22, 'Normal'], [34, 'Wide']], p.margin, v => { setPref({ margin: v }); relayout(); })),
    line('Alignment', seg([['left', 'Left'], ['justify', 'Justified']], p.align, v => { setPref({ align: v }); relayout(); })),
    line('Layout', seg([['pages', 'Pages'], ['scroll', 'Scroll']], p.mode, v => { const f = frac(); setPref({ mode: v }); applyLook(); render(R.sec, { frac: f }); })),
    line('Page colour', seg([['app', 'Theme'], ['paper', 'Paper'], ['sepia', 'Sepia'], ['grey', 'Grey'], ['black', 'Black']], p.tone, v => { setPref({ tone: v }); applyLook(); })),
    h('div', { class: 'line' }, h('div', null, 'Keep the screen on', h('small', { text: 'Stops the iPhone dimming while you read. Uses more battery.' })),
      toggle(p.awake, v => { setPref({ awake: v }); wakeLock(); }))));
}

async function wakeLock() {
  try {
    if (R.open && prefs().awake && navigator.wakeLock && !document.hidden) { if (!wake) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } }
    else if (wake) { const w = wake; wake = null; await w.release(); }
  } catch { wake = null; }
}

// ---------- following the audiobook ----------
const ROMAN = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
function roman(s) { let n = 0; for (let i = 0; i < s.length; i++) { const a = ROMAN[s[i]], b = ROMAN[s[i + 1]] || 0; n += a < b ? -a : a; } return n; }
/** "01 - Chapter 5", "CHAPTER V." and "Letter 4" all become { kind, n } */
function chapterKey(title) {
  const m = /\b(chapter|letter|book|part|canto|act|scene|volume|vol|section|stave|lecture)s?\.?\s+([0-9]{1,3}|[ivxlcdm]{1,7})\b/i.exec(String(title || ''));
  if (!m) return null;
  const raw = m[2].toLowerCase();
  const n = /^\d+$/.test(raw) ? Number(raw) : roman(raw);
  return n > 0 ? { kind: m[1].toLowerCase().replace(/^vol$/, 'volume'), n } : null;
}
function syncToAudio(quiet) {
  const s = player.state;
  if (!s.book || !R.open) return;
  const pos = player.bookPos(), f = pos.total ? pos.at / pos.total : 0;
  const within = s.dur ? clamp(s.t / s.dur, 0, 0.98) : 0;
  const key = chapterKey(player.chapter() && player.chapter().title);
  let before = 0;
  const starts = R.secs.map(x => { const v = before / R.chars; before += x.len; return v; });
  const same = key ? R.secs.map((x, i) => ({ i, k: chapterKey(x.title) })).filter(c => c.k && c.k.kind === key.kind && c.k.n === key.n) : [];
  if (same.length) {
    // Same chapter heading found: go there, and roughly as far in as the narrator is.
    const best = same.reduce((p, c) => (Math.abs(starts[c.i] - f) < Math.abs(starts[p.i] - f) ? c : p));
    render(best.i, { frac: within });
    if (!quiet) toast('Matched by chapter heading');
    return;
  }
  // No matching heading: use the same fraction of the way through the book.
  let i = 0;
  while (i < R.secs.length - 1 && starts[i + 1] <= f) i++;
  render(i, { frac: R.secs[i].len ? clamp((f * R.chars - starts[i] * R.chars) / R.secs[i].len, 0, 0.98) : 0 });
  if (!quiet) toast('Matched by how far through the book you are');
}
function drawAudio() {
  const s = player.state;
  audioBar.hidden = !s.book;
  if (!s.book || !R.open) return;
  const ch = player.chapter();
  auTitle.textContent = ch ? ch.title : s.book.title;
  auBtn.replaceChildren(icon(s.playing ? 'pause' : 'play', 22));
}

// ---------- open / close ----------
export async function openReader(book, opts = {}) {
  let text;
  try { text = await books.getText(book); }
  catch (e) { toast(`Could not open this book (${e.message}).`); return false; }
  R.book = book; R.secs = text.sections; R.chars = text.chars || text.sections.reduce((n, s) => n + s.len, 0); R.plain = [];
  R.follow = !!opts.follow;
  lib.upsert(book, { openedAt: Date.now(), chars: R.chars });
  if (settings.lastText !== book.id) saveSettings({ lastText: book.id });
  R.open = true;
  root.classList.add('open');
  root.classList.remove('bare');
  root.setAttribute('aria-hidden', 'false');
  applyLook();
  const p = getProg(book.id);
  drawAudio();
  render(p && !p.done ? p.sec || 0 : 0, { frac: p && !p.done ? p.frac || 0 : 0 });
  heardIdx = player.state.idx; heardBook = player.state.book ? player.state.book.id : '';
  if (R.follow && player.state.book) syncToAudio(true);
  wakeLock();
  return true;
}
export function closeReader() {
  if (!R.open) return;
  save(true);
  R.open = false;
  root.classList.remove('open');
  root.setAttribute('aria-hidden', 'true');
  selBar.hidden = true;
  flow.replaceChildren();
  wakeLock();
}
export const readerBook = () => (R.open ? R.book : null);

export function buildReader() {
  root = $('#reader');
  flow = h('div', { class: 'rd-flow' });
  endNav = h('div', { class: 'rd-end', hidden: true });
  stage = h('div', { class: 'rd-stage' }, flow, endNav);
  titleEl = h('div', { class: 'bar-title plain ell rd-title' });
  bmBtn = h('button', { class: 'bar-btn r', 'aria-label': 'Bookmark this page', onclick: toggleBookmark }, icon('bookmark', 22));
  footL = h('span'); footR = h('span'); footBar = h('i');
  auTitle = h('span', { class: 'ell', css: 'flex:1;min-width:0' });
  auBtn = h('button', { class: 'sq', 'aria-label': 'Play or pause', onclick: () => player.toggle() }, icon('play', 22));
  audioBar = h('div', { class: 'rd-audio', hidden: true },
    auBtn,
    h('button', { class: 'sq', 'aria-label': 'Skip back', onclick: () => player.skip(-settings.skipBack) }, icon('ccw', 20)),
    auTitle,
    h('button', { class: 'chip', onclick: () => syncToAudio(false) }, 'Sync text'));
  selBar = h('div', { class: 'rd-sel', hidden: true },
    h('button', { class: 'btn fill', onclick: () => addHighlight(false) }, 'Highlight'),
    h('button', { class: 'btn', onclick: () => addHighlight(true) }, 'Add note'));
  root.append(
    h('header', { class: 'bar rd-top' },
      h('button', { class: 'bar-btn l', 'aria-label': 'Close book', onclick: closeReader }, icon('back')),
      titleEl, bmBtn,
      h('button', { class: 'bar-btn r', 'aria-label': 'Reading settings', onclick: typeSheet, css: 'font:600 17px var(--serif)' }, 'Aa'),
      h('button', { class: 'bar-btn r', 'aria-label': 'Contents, notes and search', onclick: () => menu('contents') }, icon('list'))),
    stage, selBar, audioBar,
    h('footer', { class: 'rd-foot' }, h('div', { class: 'rd-pg' }, footBar), h('div', { class: 'rd-info' }, footL, footR)));

  // Tap the sides to turn, the middle to hide the bars; swipe to turn.
  stage.addEventListener('click', e => {
    if (selection()) return;
    const m = e.target.closest && e.target.closest('mark[data-i]');
    if (m) return editMark(Number(m.dataset.i));
    if (prefs().mode !== 'pages') return;
    const x = e.clientX - stage.getBoundingClientRect().left;
    if (x < R.W * 0.28) prev(); else if (x > R.W * 0.72) next(); else { root.classList.toggle('bare'); requestAnimationFrame(relayout); }
  });
  let x0 = null, y0 = 0;
  stage.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  stage.addEventListener('touchend', e => {
    if (x0 == null || prefs().mode !== 'pages' || selection()) { x0 = null; return; }
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.5) { if (dx < 0) next(); else prev(); }
  }, { passive: true });
  stage.addEventListener('scroll', () => { if (R.open && prefs().mode !== 'pages') status(); }, { passive: true });
  stage.addEventListener('error', e => { if (e.target.tagName === 'IMG') e.target.remove(); }, true);
  document.addEventListener('selectionchange', debounce(() => { if (R.open) selBar.hidden = !selection(); }, 200));
  addEventListener('keydown', e => { if (!R.open || !$('#sheet').hidden) return; if (e.key === 'ArrowRight') next(); else if (e.key === 'ArrowLeft') prev(); else if (e.key === 'Escape') closeReader(); });
  addEventListener('resize', debounce(relayout, 200));
  document.addEventListener('visibilitychange', () => { if (R.open) { if (document.hidden) save(true); wakeLock(); } });
  addEventListener('pagehide', () => { if (R.open) { save(true); flushProg(); } });

  player.on('state', s => {
    if (!R.open) return;
    drawAudio();
    const id = s.book ? s.book.id : '';
    const moved = s.idx !== heardIdx || id !== heardBook;
    heardIdx = s.idx; heardBook = id;
    if (R.follow && s.book && moved) syncToAudio(true);
  });
}
