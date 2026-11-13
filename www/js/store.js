// Persistence: settings + listening positions in localStorage (tiny, synchronous),
// library records (book details, chapter lists) in IndexedDB.
import { emitter } from './util.js';

export const bus = emitter();

const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

// ---------- settings ----------
const DEFAULTS = {
  theme: 'paper',          // preset key or 'custom'
  custom: null,            // {bg, ink, accent, hi}
  followCover: false,      // re-tint from the cover of the book that is playing
  skipBack: 15,
  skipFwd: 30,
  rate: 1,
  lockButtons: 'skip',     // 'skip' | 'chapters'
  lang: 'any',
  sourceOrder: ['archive', 'librivox'],
  sourceOff: {},
  lastBook: null,
};
export const settings = Object.assign({}, DEFAULTS, LS.get('hark.settings', {}));
for (const k of DEFAULTS.sourceOrder) if (!settings.sourceOrder.includes(k)) settings.sourceOrder.push(k);

export function saveSettings(patch) {
  Object.assign(settings, patch);
  LS.set('hark.settings', settings);
  bus.emit('settings', patch);
}

// ---------- listening positions ----------
// {bookId: {idx, t, at, done}} — kept in memory, flushed at most every few seconds.
const prog = LS.get('hark.prog', {});
let progDirty = false;
export const getProg = id => prog[id];
export function setProg(id, p, flush) {
  prog[id] = p;
  progDirty = true;
  if (flush) flushProg();
}
export function flushProg() {
  if (!progDirty) return;
  LS.set('hark.prog', prog);
  progDirty = false;
}
export function clearProg(id) { delete prog[id]; progDirty = true; flushProg(); }

// ---------- small JSON cache for catalogue lists ----------
export function cacheGet(key) { return LS.get('hark.c.' + key, null); }
export function cacheSet(key, v) {
  const rec = { t: Date.now(), v };
  if (LS.set('hark.c.' + key, rec)) return;
  // Storage full: drop every cached list and retry once.
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith('hark.c.')) localStorage.removeItem(k);
    }
  } catch { /* ignore */ }
  LS.set('hark.c.' + key, rec);
}
export const themeVarsStore = { set: v => LS.set('hark.themeVars', v) };

// ---------- library (IndexedDB, mirrored in memory) ----------
let db = null;
const books = new Map();

function openDb() {
  return new Promise((res, rej) => {
    const rq = indexedDB.open('hark', 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore('books', { keyPath: 'id' });
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}
function tx(mode, fn) {
  if (!db) return;
  try { fn(db.transaction('books', mode).objectStore('books')); } catch (e) { console.warn('db', e); }
}

export async function initStore() {
  try {
    db = await openDb();
    await new Promise(res => {
      const rq = db.transaction('books').objectStore('books').getAll();
      rq.onsuccess = () => { for (const r of rq.result) books.set(r.id, r); res(); };
      rq.onerror = () => res();
    });
  } catch (e) {
    console.warn('IndexedDB unavailable, library is memory-only', e);
    db = null;
  }
}

function mergeBook(a, b) {
  const out = Object.assign({}, a);
  for (const k in b) {
    const v = b[k];
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
    out[k] = v;
  }
  return out;
}

export const lib = {
  get: id => books.get(id),
  all: () => [...books.values()],
  /** Create or update a record; `book` fields are merged without losing chapter lists. */
  upsert(book, patch) {
    const cur = books.get(book.id);
    const rec = cur || { id: book.id, book, saved: false, dl: 0, addedAt: Date.now() };
    rec.book = cur ? mergeBook(cur.book, book) : book;
    if (patch) Object.assign(rec, patch);
    books.set(rec.id, rec);
    tx('readwrite', s => s.put(rec));
    bus.emit('lib', rec.id);
    return rec;
  },
  remove(id) {
    books.delete(id);
    tx('readwrite', s => s.delete(id));
    bus.emit('lib', id);
  },
};
export { mergeBook };
