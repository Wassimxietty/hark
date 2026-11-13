// Colour themes: presets, plus palettes derived from any picture or book cover.
import { settings, saveSettings, themeVarsStore } from './store.js';
import { clamp } from './util.js';

export const PRESETS = [
  { key: 'paper', name: 'Paper', bg: '#FBF1DE', ink: '#1C1A17', accent: '#EF6F2E', hi: '#F5D65A' },
  { key: 'sage', name: 'Sage', bg: '#EEF2E6', ink: '#18261F', accent: '#58A57A', hi: '#DCE68F' },
  { key: 'harbor', name: 'Harbor', bg: '#EAF1F7', ink: '#13202C', accent: '#5B9BE6', hi: '#FFD772' },
  { key: 'blush', name: 'Blush', bg: '#FBEEEA', ink: '#2A1A1D', accent: '#EC7A92', hi: '#F8CFA9' },
  { key: 'news', name: 'Newsprint', bg: '#F3F2EE', ink: '#151515', accent: '#151515', hi: '#DFDDD4' },
  { key: 'night', name: 'Night', bg: '#141518', ink: '#F2ECDF', accent: '#F2793A', hi: '#26282E' },
  { key: 'plum', name: 'Plum', bg: '#1B1522', ink: '#F4EAF6', accent: '#C58BF2', hi: '#2D2238' },
  { key: 'pine', name: 'Pine', bg: '#101A16', ink: '#E9F2EA', accent: '#6FCF97', hi: '#1D2B25' },
];

// ---------- colour maths ----------
const hex2rgb = h => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const rgb2hex = ([r, g, b]) => '#' + [r, g, b].map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => { const x = hex2rgb(a), y = hex2rgb(b); return rgb2hex(x.map((v, i) => v + (y[i] - v) * t)); };
function lum(hex) {
  const [r, g, b] = hex2rgb(hex).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
function rgb2hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60; if (h < 0) h += 360;
  return [h, s, l];
}
function hsl(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return rgb2hex([(r + m) * 255, (g + m) * 255, (b + m) * 255]);
}
const pick = (on, a, b) => (contrast(on, a) >= contrast(on, b) ? a : b);

/** Expands the four base colours into every CSS variable the stylesheet uses. */
export function vars(t) {
  const dark = lum(t.bg) < 0.2;
  return {
    '--bg': t.bg, '--ink': t.ink, '--accent': t.accent, '--hi': t.hi,
    '--on-accent': pick(t.accent, t.ink, t.bg),
    '--on-hi': pick(t.hi, t.ink, t.bg),
    '--muted': mix(t.ink, t.bg, dark ? 0.36 : 0.4),
    '--soft': mix(t.ink, t.bg, dark ? 0.8 : 0.86),
    '--card': dark ? mix(t.bg, '#ffffff', 0.05) : mix(t.bg, '#ffffff', 0.55),
    '--scheme': dark ? 'dark' : 'light',
  };
}

let transient = null; // palette borrowed from a cover, not saved

export function current() {
  if (transient) return transient;
  if (settings.theme === 'custom' && settings.custom) return settings.custom;
  return PRESETS.find(p => p.key === settings.theme) || PRESETS[0];
}

export function apply(t = current()) {
  const v = vars(t);
  const st = document.documentElement.style;
  for (const k in v) st.setProperty(k, v[k]);
  st.colorScheme = v['--scheme'];
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t.bg);
  themeVarsStore.set(v); // boot.js paints these before the app loads, so there is no flash
}

export function usePreset(key) { transient = null; saveSettings({ theme: key }); apply(); }
export function useCustom(t) { transient = null; saveSettings({ theme: 'custom', custom: t }); apply(); }
export function useTransient(t) { transient = t; apply(); }
export function clearTransient() { if (transient) { transient = null; apply(); } }

// ---------- palette from a picture ----------
async function pixels(src) {
  let blob = src;
  if (typeof src === 'string') {
    const r = await fetch(src);
    if (!r.ok) throw new Error('image unavailable');
    blob = await r.blob();
  }
  const S = 48;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  if (self.createImageBitmap) {
    const bmp = await createImageBitmap(blob);
    cx.drawImage(bmp, 0, 0, S, S);
    if (bmp.close) bmp.close();
  } else {
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
      cx.drawImage(img, 0, 0, S, S);
    } finally { URL.revokeObjectURL(url); }
  }
  return cx.getImageData(0, 0, S, S).data;
}

/** Finds the two strongest hues and builds a readable light or dark palette around them. */
function build(data, mode) {
  const BINS = 24, bins = Array.from({ length: BINS }, () => ({ w: 0, x: 0, y: 0, s: 0, l: 0 }));
  let lsum = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const [hh, s, l] = rgb2hsl(data[i], data[i + 1], data[i + 2]);
    lsum += l; n++;
    if (s < 0.2 || l < 0.12 || l > 0.9) continue;
    const w = s * (1 - Math.abs(l - 0.5) * 1.3);
    const b = bins[Math.floor(hh / (360 / BINS)) % BINS], rad = hh * Math.PI / 180;
    b.w += w; b.x += Math.cos(rad) * w; b.y += Math.sin(rad) * w; b.s += s * w; b.l += l * w;
  }
  const avg = n ? lsum / n : 0.6;
  const dark = mode === 'dark' || (mode !== 'light' && avg < 0.34);
  const ranked = bins.filter(b => b.w > 0).map(b => ({
    w: b.w, h: (Math.atan2(b.y, b.x) * 180 / Math.PI + 360) % 360, s: b.s / b.w, l: b.l / b.w,
  })).sort((a, b) => b.w - a.w);
  const total = ranked.reduce((a, b) => a + b.w, 0);
  if (!ranked.length || total < n * 0.004) {
    // Black-and-white picture: a neutral palette.
    return dark ? { bg: '#151515', ink: '#F1F0EC', accent: '#F1F0EC', hi: '#2A2A2A' } : { bg: '#F3F2EE', ink: '#151515', accent: '#151515', hi: '#DFDDD4' };
  }
  const a = ranked[0];
  const dist = (p, q) => { const d = Math.abs(p - q) % 360; return d > 180 ? 360 - d : d; };
  const b = ranked.find(r => dist(r.h, a.h) >= 40 && r.w >= a.w * 0.12) || { h: a.h + 38, s: a.s, l: a.l };
  const t = dark
    ? { bg: hsl(a.h, 0.22, 0.085), ink: hsl(a.h, 0.3, 0.93), accent: hsl(a.h, clamp(a.s, 0.5, 0.8), 0.64), hi: hsl(b.h, 0.3, 0.17) }
    : { bg: hsl(a.h, 0.5, 0.95), ink: hsl(a.h, 0.35, 0.1), accent: hsl(a.h, clamp(a.s, 0.55, 0.85), clamp(a.l, 0.5, 0.62)), hi: hsl(b.h, clamp(b.s, 0.6, 0.9), 0.78) };
  // Keep the accent clearly visible against the page.
  let [ah, as, al] = rgb2hsl(...hex2rgb(t.accent));
  for (let i = 0; i < 12 && contrast(t.accent, t.bg) < 2.2; i++) { al += dark ? 0.03 : -0.03; t.accent = hsl(ah, as, al); }
  return t;
}

/** src: a Blob/File or a cross-origin-readable image URL. mode: 'auto' | 'light' | 'dark'. */
export async function fromImage(src, mode = 'auto') {
  return build(await pixels(src), mode);
}
export async function bothFromImage(src) {
  const data = await pixels(src);
  return { light: build(data, 'light'), dark: build(data, 'dark') };
}

const coverMemo = new Map();
/** Tint the app from the playing book's cover when that option is on. */
export async function followCover(book) {
  if (!settings.followCover) return clearTransient();
  if (!book || !book.coverCors) return;
  try {
    let t = coverMemo.get(book.id);
    if (!t) { t = await fromImage(book.coverCors, lum(current().bg) < 0.2 ? 'dark' : 'light'); coverMemo.set(book.id, t); }
    useTransient(t);
  } catch { /* cover not readable: keep the current theme */ }
}

export function init() { apply(); }
