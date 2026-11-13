// Small shared helpers: DOM builder, icons, formatting, event emitter.

export const $ = (sel, root = document) => root.querySelector(sel);

function add(el, kids) {
  for (const k of kids) {
    if (k == null || k === false) continue;
    if (Array.isArray(k)) add(el, k);
    else el.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
}

/** h('div', {class:'x', onclick: fn}, child, ...) — never puts API text through innerHTML. */
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'data') Object.assign(el.dataset, v);
      else if (k === 'css') el.style.cssText = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k in el && k !== 'list' && k !== 'type') { try { el[k] = v; } catch { el.setAttribute(k, v); } }
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  add(el, kids);
  return el;
}

const ICONS = {
  home: '<path d="M3.5 11 12 4l8.5 7v9h-17z"/><path d="M9.5 20v-6h5v6"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  bookmark: '<path d="M6.5 3.5h11v17L12 16.5l-5.5 4z"/>',
  bookmarkFill: '<path d="M6.5 3.5h11v17L12 16.5l-5.5 4z" fill="currentColor"/>',
  shelf: '<path d="M4.5 4v16M9 4v16M4.5 4H9M4.5 20H9M13 6.5l3.6-1 3.4 13.5-3.6 1z"/>',
  sliders: '<path d="M4 7h9M19 7h1M4 17h1M11 17h9"/><circle cx="16" cy="7" r="2.4"/><circle cx="8" cy="17" r="2.4"/>',
  back: '<path d="m14.5 5-7 7 7 7"/>',
  down: '<path d="m5 9 7 7 7-7"/>',
  up: '<path d="m5 15 7-7 7 7"/>',
  right: '<path d="m9 5 7 7-7 7"/>',
  play: '<path d="M7.5 4.5 19.5 12l-12 7.5z" fill="currentColor"/>',
  pause: '<path d="M7 5h3.6v14H7zM13.4 5H17v14h-3.6z" fill="currentColor"/>',
  next: '<path d="M5.5 5 15 12l-9.5 7z" fill="currentColor"/><path d="M18 5v14"/>',
  prev: '<path d="M18.5 5 9 12l9.5 7z" fill="currentColor"/><path d="M6 5v14"/>',
  ccw: '<path d="M2.5 4.5v5.5H8"/><path d="M4.3 14.5a8.5 8.5 0 1 0 2-8.8L2.5 10"/>',
  cw: '<path d="M21.5 4.5v5.5H16"/><path d="M19.7 14.5a8.5 8.5 0 1 1-2-8.8l3.8 4.3"/>',
  download: '<path d="M12 3.5v11.5M7 10.5l5 5 5-5M4.5 20h15"/>',
  check: '<path d="m4.5 12.5 4.8 4.8L19.5 6.5"/>',
  share: '<path d="M12 15V3.5M8 7.5l4-4 4 4M5.5 11.5v9h13v-9"/>',
  moon: '<path d="M20 14.2A8 8 0 1 1 9.8 4a6.4 6.4 0 0 0 10.2 10.2z"/>',
  list: '<path d="M8.5 6h11M8.5 12h11M8.5 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
  x: '<path d="m5.5 5.5 13 13M18.5 5.5l-13 13"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4h5v3M6.5 7l1 13h9l1-13"/>',
  image: '<path d="M3.5 4.5h17v15h-17z"/><path d="m3.5 16 5-5 4 4 3-3 5 5"/><circle cx="15.5" cy="9" r="1.4"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.2 2"/>',
  alert: '<path d="M12 3.5 21.5 20h-19z"/><path d="M12 10v4.5M12 17.2h.01"/>',
  headphones: '<path d="M4.5 15v-3a7.5 7.5 0 0 1 15 0v3"/><path d="M4.5 14.5h3v5.5h-3zM16.5 14.5h3v5.5h-3z"/>',
  book: '<path d="M12 6.5C9 4.9 6.5 4.5 3.5 5.5v13c3-1 5.5-.6 8.5 1 3-1.6 5.5-2 8.5-1v-13c-3-1-5.5-.6-8.5 1zM12 6.5v13"/>',
  filePlus: '<path d="M6 3.5h8l4 4v13H6zM14 3.5v4h4M12 11v6M9 14h6"/>',
  sparkle: '<path d="M12 3.5 13.8 10l6.7 2-6.7 2L12 20.5 10.2 14l-6.7-2 6.7-2z"/>',
};

export function icon(name, size = 22) {
  const span = document.createElement('span');
  span.className = 'ic';
  // Static, trusted markup only.
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  return span;
}

export function emitter() {
  const map = new Map();
  return {
    on(ev, fn) { (map.get(ev) || map.set(ev, new Set()).get(ev)).add(fn); return () => map.get(ev).delete(fn); },
    emit(ev, a, b) { const s = map.get(ev); if (s) for (const fn of [...s]) { try { fn(a, b); } catch (e) { console.error(e); } } },
  };
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** 3723 -> "1:02:03", 125 -> "2:05" */
export function fmtClock(secs) {
  secs = Math.max(0, Math.floor(secs || 0));
  const hh = Math.floor(secs / 3600), mm = Math.floor((secs % 3600) / 60), ss = secs % 60;
  const p = n => String(n).padStart(2, '0');
  return hh ? `${hh}:${p(mm)}:${p(ss)}` : `${mm}:${p(ss)}`;
}

/** 29808 -> "8 h 17 min" */
export function fmtDur(secs) {
  secs = Math.max(0, Math.round(secs || 0));
  if (!secs) return '';
  const hh = Math.floor(secs / 3600), mm = Math.round((secs % 3600) / 60);
  if (!hh) return `${Math.max(1, mm)} min`;
  return mm ? `${hh} h ${mm} min` : `${hh} h`;
}

export function fmtBytes(n) {
  if (!n) return '0 MB';
  if (n < 1e9) return `${Math.max(1, Math.round(n / 1e6))} MB`;
  return `${(n / 1e9).toFixed(1)} GB`;
}

/** Turns API HTML into plain text safely (no script execution, no markup kept). */
export function stripHtml(html) {
  if (!html) return '';
  const src = String(html).replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n');
  const doc = new DOMParser().parseFromString(src, 'text/html');
  return (doc.body.textContent || '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function initials(title) {
  const w = String(title || '?').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(x => !/^(the|a|an|of|and|or)$/i.test(x));
  return ((w[0] || '?')[0] + (w[1] ? w[1][0] : '')).toUpperCase();
}
