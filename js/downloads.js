// Offline copies of chapters, kept in the Cache API (streamed straight to disk).
import { bus, lib } from './store.js';

const CACHE = 'hark-audio-v1';
const IMG_CACHE = 'hark-img-v1';
const have = new Set();      // chapter URLs stored on this device
const jobs = new Map();      // bookId -> { ctrl, done, total }
const queue = [];
let running = false;
let cacheP = null;
const open = () => (cacheP || (cacheP = caches.open(CACHE)));

export const supported = typeof caches !== 'undefined';

export async function init() {
  if (!supported) return;
  try {
    const c = await open();
    for (const rq of await c.keys()) have.add(rq.url);
  } catch (e) { console.warn('cache', e); }
}

export const hasUrl = url => have.has(url);
export const countFor = book => (book.chapters || []).reduce((n, c) => n + (have.has(c.url) ? 1 : 0), 0);
export const isComplete = book => !!(book.chapters && book.chapters.length) && countFor(book) === book.chapters.length;
export const jobFor = id => jobs.get(id);

/** A playable local URL for a stored chapter, or null. Caller revokes it. */
export async function localUrl(url) {
  if (!supported || !have.has(url)) return null;
  try {
    const r = await (await open()).match(url);
    if (!r) { have.delete(url); return null; }
    return URL.createObjectURL(await r.blob());
  } catch { return null; }
}

function emit(id) { bus.emit('dl', id); }

/** Keeps one of the user's own audio files under a made-up address the player can look up. */
export async function storeLocal(url, file, type) {
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  await (await open()).put(url, new Response(file, { headers: { 'Content-Type': type } }));
  have.add(url);
}

export function downloadBook(book) {
  if (!supported || jobs.has(book.id) || !book.chapters) return;
  jobs.set(book.id, { ctrl: new AbortController(), done: countFor(book), total: book.chapters.length, book });
  queue.push(book.id);
  emit(book.id);
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  keepCover(book);
  pump();
}

async function pump() {
  if (running) return;
  running = true;
  while (queue.length) {
    const id = queue.shift();
    const job = jobs.get(id);
    if (!job) continue;
    let error = null;
    try {
      const c = await open();
      for (const ch of job.book.chapters) {
        if (job.ctrl.signal.aborted) break;
        if (have.has(ch.url)) continue;
        const r = await fetch(ch.url, { signal: job.ctrl.signal });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        await c.put(ch.url, r);
        have.add(ch.url);
        job.done = countFor(job.book);
        emit(id);
      }
    } catch (e) {
      if (e.name !== 'AbortError') error = /quota/i.test(e.name + e.message) ? 'Not enough free storage.' : 'Download stopped — check your connection.';
    }
    jobs.delete(id);
    const n = countFor(job.book);
    if (lib.get(id) || n) lib.upsert(job.book, { dl: n });
    bus.emit('dl', id, error);
  }
  running = false;
}

export function cancel(id) {
  const j = jobs.get(id);
  if (j) j.ctrl.abort();
  const i = queue.indexOf(id);
  if (i >= 0) { queue.splice(i, 1); jobs.delete(id); emit(id); }
}

export async function removeBook(book) {
  cancel(book.id);
  if (!supported) return;
  const c = await open();
  await Promise.all((book.chapters || []).map(ch => { have.delete(ch.url); return c.delete(ch.url); }));
  if (lib.get(book.id)) lib.upsert(book, { dl: 0 });
  emit(book.id);
}

export async function removeAll() {
  for (const id of [...jobs.keys()]) cancel(id);
  if (!supported) return;
  await caches.delete(CACHE);
  cacheP = null;
  have.clear();
  for (const r of lib.all()) if (r.dl) lib.upsert(r.book, { dl: 0 });
  emit('*');
}

/** Keep a book's cover available offline (the service worker serves it from this cache). */
export function keepCover(book) {
  if (!supported) return;
  const urls = [book.cover, book.coverHi].filter(Boolean);
  caches.open(IMG_CACHE).then(c => Promise.all(urls.map(async u => {
    if (await c.match(u)) return;
    const r = await fetch(u, { mode: 'no-cors' });
    await c.put(u, r);
  }))).catch(() => {});
}

export async function usage() {
  try {
    const e = await navigator.storage.estimate();
    return { used: e.usage || 0, quota: e.quota || 0 };
  } catch { return { used: 0, quota: 0 }; }
}
