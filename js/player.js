// Playback engine: one <audio> element, lock-screen controls, sleep timer,
// resume positions. Designed to keep working with the screen locked:
// the next chapter's address is prepared in advance so the hand-over needs no waiting.
import { emitter, clamp } from './util.js';
import { settings, saveSettings, bus, lib, getProg, setProg, flushProg } from './store.js';
import * as dl from './downloads.js';

const ev = emitter();
export const on = ev.on;

const audio = new Audio();
audio.preload = 'auto';

export const state = {
  book: null, idx: 0, playing: false, loading: false,
  t: 0, dur: 0, rate: settings.rate || 1,
  sleep: null,          // { type:'time', at:<ms> } | { type:'chapter' }
  error: '',
};

let pendingSeek = 0;
let curObj = null;      // object URL of the chapter being played, if it is a stored copy
let ready = null;       // { idx, src, obj } prepared next chapter
let retried = false;
let lastSave = 0;
let token = 0;          // guards against overlapping chapter switches

const chapters = () => (state.book && state.book.chapters) || [];
export const chapter = () => chapters()[state.idx];

/** Seconds listened in the whole book up to the current point, and the book's length. */
export function bookPos() {
  const ch = chapters();
  let before = 0, total = 0;
  for (let i = 0; i < ch.length; i++) { if (i < state.idx) before += ch[i].secs || 0; total += ch[i].secs || 0; }
  return { at: before + state.t, total: total || state.book && state.book.secs || 0 };
}

function emitState() { ev.emit('state', state); }

function save(flush) {
  const b = state.book;
  if (!b) return;
  const last = state.idx >= chapters().length - 1;
  const done = last && state.dur > 0 && state.t >= state.dur - 2;
  setProg(b.id, { idx: state.idx, t: Math.floor(state.t), at: Date.now(), done }, flush);
  lastSave = Date.now();
}

async function resolveSrc(ch) {
  const local = await dl.localUrl(ch.url);
  return local ? { src: local, obj: local } : { src: ch.url, obj: null };
}

function dropReady() {
  if (ready && ready.obj) URL.revokeObjectURL(ready.obj);
  ready = null;
}

async function prepareNext() {
  dropReady();
  const idx = state.idx + 1, ch = chapters()[idx], book = state.book;
  if (!ch) return;
  const r = await resolveSrc(ch);
  if (state.book !== book || state.idx + 1 !== idx) { if (r.obj) URL.revokeObjectURL(r.obj); return; }
  ready = Object.assign({ idx }, r);
}

/** Synchronous switch — safe to call from the 'ended' event while the phone is locked. */
function applyChapter(idx, r, t, autoplay) {
  const old = curObj;
  state.idx = idx;
  state.t = t || 0;
  state.dur = chapters()[idx].secs || 0;
  state.error = '';
  pendingSeek = t || 0;
  retried = false;
  curObj = r.obj;
  audio.src = r.src;
  audio.defaultPlaybackRate = audio.playbackRate = state.rate;
  if (autoplay) {
    state.loading = true;
    const p = audio.play();
    if (p) p.catch(e => { if (e.name !== 'AbortError') { state.playing = false; state.loading = false; emitState(); } });
  }
  if (old) setTimeout(() => URL.revokeObjectURL(old), 1000);
  updateMeta();
  emitState();
  ev.emit('time', state);
  save(true);
  prepareNext();
}

// iOS only lets a page start sound from inside a tap. Starting a silent clip in the tap
// "unlocks" the element, so the real chapter can start a moment later (after a disk lookup).
const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
let unlocked = false;
const silent = () => audio.src.startsWith('data:');
export function unlock() {
  if (unlocked) return;
  unlocked = true;
  if (audio.src && !silent()) return;
  audio.src = SILENCE;
  const p = audio.play();
  if (p) p.catch(() => {});
}

function setChapter(idx, t, autoplay) {
  const ch = chapters()[idx];
  if (!ch) return;
  const my = ++token;
  if (ready && ready.idx === idx) { const r = ready; ready = null; applyChapter(idx, r, t, autoplay); return; }
  dropReady();
  // Streaming needs no lookup, so the switch happens inside the tap itself.
  if (!dl.hasUrl(ch.url)) { applyChapter(idx, { src: ch.url, obj: null }, t, autoplay); return; }
  if (autoplay) unlock();
  resolveSrc(ch).then(r => {
    if (my !== token) { if (r.obj) URL.revokeObjectURL(r.obj); return; }
    applyChapter(idx, r, t, autoplay);
  });
}

/** Start (or resume) a book. `book` must include its chapter list. */
export function load(book, { idx, t, autoplay = true } = {}) {
  if (!book || !book.chapters || !book.chapters.length) return;
  if (state.book && state.book.id !== book.id) save(true);
  const same = state.book && state.book.id === book.id;
  if (idx == null) {
    if (same) { if (autoplay) play(); return; }
    const p = getProg(book.id);
    const restart = !p || p.done;
    idx = restart ? 0 : clamp(p.idx, 0, book.chapters.length - 1);
    t = restart ? 0 : Math.max(0, (p.t || 0) - 3); // step back a moment so the thread is easy to pick up
  }
  state.book = book;
  dropReady();
  setChapter(idx, t || 0, autoplay);
  lib.upsert(book, { openedAt: Date.now() });
  if (settings.lastBook !== book.id) saveSettings({ lastBook: book.id });
  if (!same) ev.emit('book', book);
}

export function play() {
  if (!state.book) return;
  if (!audio.src || silent()) { setChapter(state.idx, state.t, true); return; }
  const p = audio.play();
  if (p) p.catch(() => {});
}
export function pause() { audio.pause(); }
export function toggle() { if (audio.paused) play(); else pause(); }

export function seek(t) {
  if (!state.book) return;
  t = clamp(t, 0, Math.max(0, (state.dur || 0) - 0.25));
  state.t = t;
  if (audio.readyState >= 1) { try { audio.currentTime = t; } catch { pendingSeek = t; } } else pendingSeek = t;
  ev.emit('time', state);
  save();
}

/** Skip within the book; crossing a chapter edge moves to the neighbouring chapter. */
export function skip(delta) {
  if (!state.book) return;
  const t = state.t + delta;
  if (t < 0 && state.idx > 0 && state.t < 2) {
    const prevDur = chapters()[state.idx - 1].secs || 0;
    setChapter(state.idx - 1, Math.max(0, prevDur + t), !audio.paused);
  } else if (state.dur && t >= state.dur && state.idx < chapters().length - 1) {
    setChapter(state.idx + 1, 0, !audio.paused);
  } else seek(t);
}

export function next() { if (state.idx < chapters().length - 1) setChapter(state.idx + 1, 0, !audio.paused || state.loading); }
export function prev() {
  if (state.t > 4 || state.idx === 0) seek(0);
  else setChapter(state.idx - 1, 0, !audio.paused || state.loading);
}
export function goTo(idx, autoplay = true) { setChapter(idx, 0, autoplay); }

export function setRate(r) {
  state.rate = r;
  audio.defaultPlaybackRate = audio.playbackRate = r;
  saveSettings({ rate: r });
  position();
  emitState();
}

export function setSleep(v) {
  state.sleep = v === 'chapter' ? { type: 'chapter' } : v ? { type: 'time', at: Date.now() + v * 60000 } : null;
  emitState();
}
export const sleepLeft = () => (state.sleep && state.sleep.type === 'time' ? Math.max(0, state.sleep.at - Date.now()) : 0);

/** Stop and forget the current book (used when it is removed from the library). */
export function unload() {
  save(true);
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  dropReady();
  if (curObj) { URL.revokeObjectURL(curObj); curObj = null; }
  Object.assign(state, { book: null, idx: 0, playing: false, loading: false, t: 0, dur: 0, sleep: null });
  if (ms) { ms.metadata = null; ms.playbackState = 'none'; }
  saveSettings({ lastBook: null });
  emitState();
}

// ---------- lock screen / control centre ----------
const ms = 'mediaSession' in navigator ? navigator.mediaSession : null;

function updateMeta() {
  if (!ms || !state.book || !self.MediaMetadata) return;
  const b = state.book, ch = chapter();
  const art = b.coverHi || b.cover;
  ms.metadata = new MediaMetadata({
    title: ch ? ch.title : b.title, artist: b.author || '', album: b.title,
    artwork: art ? [{ src: art, sizes: '300x300', type: 'image/jpeg' }] : [],
  });
}
function position() {
  if (!ms || !ms.setPositionState || !isFinite(audio.duration) || !audio.duration) return;
  try { ms.setPositionState({ duration: audio.duration, playbackRate: audio.playbackRate || 1, position: clamp(audio.currentTime, 0, audio.duration) }); } catch { /* ignore */ }
}
function setHandler(name, fn) { try { ms.setActionHandler(name, fn); } catch { /* unsupported action */ } }

/** iOS shows either skip buttons or chapter buttons on the lock screen, never both. */
export function applyLockButtons() {
  if (!ms) return;
  const skipMode = settings.lockButtons !== 'chapters';
  setHandler('seekbackward', skipMode ? d => skip(-(d && d.seekOffset || settings.skipBack)) : null);
  setHandler('seekforward', skipMode ? d => skip(d && d.seekOffset || settings.skipFwd) : null);
  setHandler('previoustrack', skipMode ? null : prev);
  setHandler('nexttrack', skipMode ? null : next);
}

// ---------- audio events ----------
export function init() {
  // Ignore everything the silent unlock clip does.
  const onA = (name, fn) => audio.addEventListener(name, e => { if (!silent()) fn(e); });

  onA('loadedmetadata', () => {
    if (isFinite(audio.duration) && audio.duration > 0) state.dur = audio.duration;
    if (pendingSeek > 0) { try { audio.currentTime = Math.min(pendingSeek, Math.max(0, state.dur - 1)); } catch { /* ignore */ } }
    pendingSeek = 0;
    position();
    ev.emit('time', state);
  });
  onA('timeupdate', () => {
    if (audio.seeking) return;
    state.t = audio.currentTime;
    if (state.sleep && state.sleep.type === 'time' && Date.now() >= state.sleep.at) {
      state.sleep = null;
      audio.pause();
    }
    if (Date.now() - lastSave > 5000) save();
    if (!document.hidden) ev.emit('time', state); // no screen work while locked or in the background
  });
  onA('play', () => { state.playing = true; if (ms) ms.playbackState = 'playing'; emitState(); });
  onA('playing', () => { state.loading = false; state.error = ''; position(); emitState(); });
  onA('waiting', () => { state.loading = true; emitState(); });
  onA('pause', () => {
    state.playing = false; state.loading = false;
    if (ms) ms.playbackState = 'paused';
    save(true); position(); emitState();
  });
  onA('ratechange', position);
  onA('seeked', position);
  onA('ended', () => {
    state.t = state.dur;
    save(true);
    const nextIdx = state.idx + 1;
    const stopHere = state.sleep && state.sleep.type === 'chapter';
    if (stopHere) state.sleep = null;
    if (nextIdx >= chapters().length) {
      state.playing = false;
      emitState();
      ev.emit('finished', state.book);
      return;
    }
    if (ready && ready.idx === nextIdx) {
      const r = ready; ready = null;
      applyChapter(nextIdx, r, 0, !stopHere);
    } else setChapter(nextIdx, 0, !stopHere);
  });
  onA('error', () => {
    if (!state.book || !audio.src) return;
    const ch = chapter();
    if (!retried && ch) {
      // One retry straight from the network (covers a damaged stored copy or a brief drop).
      retried = true;
      const at = state.t, wasPlaying = state.playing || state.loading;
      setTimeout(() => {
        if (chapter() !== ch) return;
        pendingSeek = at;
        audio.src = ch.url;
        audio.defaultPlaybackRate = audio.playbackRate = state.rate;
        if (wasPlaying) { const p = audio.play(); if (p) p.catch(() => {}); }
      }, 1200);
      return;
    }
    state.playing = false; state.loading = false;
    state.error = navigator.onLine === false ? 'You are offline and this chapter is not downloaded.' : 'This chapter could not be loaded.';
    emitState();
  });

  if (ms) {
    setHandler('play', play);
    setHandler('pause', pause);
    setHandler('seekto', d => { if (d && d.seekTime != null) seek(d.seekTime); });
    applyLockButtons();
  }
  bus.on('settings', p => { if (p && 'lockButtons' in p) applyLockButtons(); });

  const flush = () => { if (state.book) save(true); else flushProg(); };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flush();
    else { state.t = audio.currentTime || state.t; ev.emit('time', state); emitState(); }
  });
  addEventListener('pagehide', flush);
}

/** Bring back the last book (paused) when the app is opened again. */
export function restore() {
  const rec = settings.lastBook && lib.get(settings.lastBook);
  if (!rec || !rec.book.chapters || !rec.book.chapters.length) return;
  const p = getProg(rec.id) || { idx: 0, t: 0 };
  state.book = rec.book;
  state.idx = clamp(p.idx || 0, 0, rec.book.chapters.length - 1);
  state.t = p.done ? 0 : p.t || 0;
  if (p.done) state.idx = 0;
  state.dur = rec.book.chapters[state.idx].secs || 0;
  updateMeta();
  emitState();
  ev.emit('book', rec.book);
}
