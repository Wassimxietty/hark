// Your own audiobook files (.m4b, .m4a, .mp3): kept on the phone and played like any other book.
// One file becomes one chapter; several files picked together become the chapters of one book.
import { lib } from './store.js';
import * as dl from './downloads.js';

const TYPES = { m4b: 'audio/mp4', m4a: 'audio/mp4', mp4: 'audio/mp4', mp3: 'audio/mpeg', aac: 'audio/aac', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac' };
const ext = name => (/\.([a-z0-9]+)$/i.exec(name) || [, ''])[1].toLowerCase();
const latin = (u8, a, n) => String.fromCharCode(...u8.subarray(a, a + n));

/** Finds the 'moov' box of an MP4/M4B without reading the audio itself. */
async function readMoov(file) {
  let off = 0;
  for (let i = 0; i < 64 && off + 8 <= file.size; i++) {
    const hd = new DataView(await file.slice(off, off + 16).arrayBuffer());
    let size = hd.getUint32(0), hdr = 8;
    const type = latin(new Uint8Array(hd.buffer), 4, 4);
    if (size === 1 && hd.byteLength >= 16) { size = Number(hd.getBigUint64(8)); hdr = 16; }
    else if (size === 0) size = file.size - off;
    if (size < hdr) return null;
    if (type === 'moov') return size > 64e6 ? null : new Uint8Array(await file.slice(off + hdr, off + size).arrayBuffer());
    off += size;
  }
  return null;
}

/** Title, author, length and cover from an MP4/M4B's tags. */
function parseMoov(u8) {
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const out = { title: '', author: '', secs: 0, cover: null };
  (function walk(a, b, depth) {
    while (a + 8 <= b) {
      const size = v.getUint32(a), type = latin(u8, a + 4, 4);
      if (size < 8 || a + size > b) return;
      const body = a + 8, end = a + size;
      if (type === 'mvhd') {
        const v1 = u8[body] === 1;
        const scale = v.getUint32(body + (v1 ? 20 : 12));
        const dur = v1 ? Number(v.getBigUint64(body + 24)) : v.getUint32(body + 16);
        if (scale) out.secs = dur / scale;
      } else if (type === 'udta' || type === 'ilst') walk(body, end, depth + 1);
      else if (type === 'meta') walk(body + 4, end, depth + 1);
      else if (depth >= 2 && end - body > 16 && latin(u8, body + 4, 4) === 'data') {
        const data = u8.subarray(body + 16, body + v.getUint32(body));
        if (type === '\xA9nam') out.title = new TextDecoder().decode(data);
        else if (type === '\xA9ART' || (type === 'aART' && !out.author)) out.author = new TextDecoder().decode(data);
        else if (type === 'covr') out.cover = data;
      }
      a = end;
    }
  })(0, u8.length, 0);
  return out;
}

async function coverUrl(bytes) {
  try {
    const bmp = await createImageBitmap(new Blob([bytes]));
    const w = 300, h = Math.round(bmp.height / bmp.width * w);
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    cv.getContext('2d').drawImage(bmp, 0, 0, w, h);
    return cv.toDataURL('image/jpeg', 0.8);
  } catch { return ''; }
}

const pretty = name => name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();

/** Stores the picked files on this iPhone and returns the new book. */
export async function importAudio(fileList) {
  const files = [...fileList].filter(f => TYPES[ext(f.name)] || /^audio\//.test(f.type))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (!files.length) throw new Error('no audio files were picked');
  if (!dl.supported) throw new Error('this browser cannot store files');
  const id = 'own_' + Date.now().toString(36);
  let tags = { title: '', author: '', secs: 0, cover: null };
  const chapters = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    let t = { title: '', secs: 0 };
    if (TYPES[ext(f.name)] === 'audio/mp4') {
      try { const moov = await readMoov(f); if (moov) t = parseMoov(moov); } catch { /* tags are optional */ }
      if (i === 0) tags = Object.assign(tags, t);
    }
    const url = `${location.origin}/own-audio/${id}/${i}`;
    await dl.storeLocal(url, f, TYPES[ext(f.name)] || f.type || 'audio/mpeg');
    chapters.push({ title: files.length === 1 ? (t.title || pretty(f.name)) : pretty(f.name), url, secs: t.secs || 0 });
  }
  const book = {
    id, own: true, src: 'file', iaId: '', lvId: '',
    title: tags.title || pretty(files[0].name), author: tags.author || '',
    cover: tags.cover ? await coverUrl(tags.cover) : '', coverHi: '', coverCors: '',
    secs: chapters.reduce((n, c) => n + c.secs, 0), lang: '', link: '', chapters,
  };
  lib.upsert(book, { saved: true, savedAt: Date.now(), dl: chapters.length });
  return book;
}
