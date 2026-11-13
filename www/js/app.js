// Start-up: storage, theme, downloads index, player, screens, then the service worker.
import { initStore } from './store.js';
import * as theme from './theme.js';
import * as dl from './downloads.js';
import * as player from './player.js';
import { initUI } from './ui.js';

(async () => {
  theme.init();
  await Promise.all([initStore(), dl.init()]);
  player.init();
  initUI();
  player.restore();

  // When a new version of the app has been fetched in the background, switch to it straight away
  // (unless a book is playing — then it is picked up the next time the app is opened).
  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloaded || player.state.playing || player.state.loading) return;
      reloaded = true;
      location.reload();
    });
  }

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
    if (document.readyState === 'complete') navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
