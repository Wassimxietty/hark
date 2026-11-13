// Small interface pieces shared by the screens and the reader.
import { $, h, icon } from './util.js';

let toastT;
export function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => { el.hidden = true; }, 2800);
}

export function openSheet(title, body) {
  const sh = $('#sheet');
  sh.replaceChildren(
    h('div', { class: 'sh-head' }, h('span', { text: title }), h('button', { class: 'bar-btn', onclick: closeSheet, 'aria-label': 'Close' }, icon('x'))),
    h('div', { class: 'sh-body' }, body),
  );
  sh.hidden = false;
  $('#scrim').hidden = false;
}
export function closeSheet() { $('#sheet').hidden = true; $('#scrim').hidden = true; }

export function confirmSheet(title, text, label, fn) {
  openSheet(title, h('div', { class: 'sh-pad' },
    h('div', { text }),
    h('div', { class: 'pair' },
      h('button', { class: 'btn', onclick: closeSheet }, 'Cancel'),
      h('button', { class: 'btn fill', onclick: () => { closeSheet(); fn(); } }, label))));
}

/** Segmented choice: options = [[value, label], ...] */
export function seg(options, value, onpick) {
  const el = h('div', { class: 'seg' });
  const draw = v => el.replaceChildren(...options.map(([val, label]) =>
    h('button', { class: val === v ? 'on' : '', text: label, onclick: () => { if (val !== v) { v = val; draw(val); onpick(val); } } })));
  draw(value);
  return el;
}

export function toggle(value, onchange) {
  const el = h('button', { class: 'tog' + (value ? ' on' : ''), role: 'switch', 'aria-checked': String(!!value) });
  el.onclick = () => { value = !value; el.classList.toggle('on', value); el.setAttribute('aria-checked', String(value)); onchange(value); };
  return el;
}
