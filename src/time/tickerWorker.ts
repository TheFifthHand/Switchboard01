/**
 * Source of the transport's ticker Web Worker, as plain JavaScript.
 *
 * Worker timers keep running at their interval when the page's main-thread
 * timers are throttled, so the look-ahead scheduler keeps being fed. The
 * worker is created from a Blob URL (see transport.ts), which works the same
 * in dev, in the production build and offline.
 *
 * Messages in: `{ interval: number }` starts (or restarts) ticking every
 * `interval` ms; `'stop'` stops. Messages out: `'tick'`.
 */
export const TICKER_WORKER_SOURCE = `'use strict';
let timer = null;
function stop() {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}
self.onmessage = function (e) {
  const d = e.data;
  if (d === 'stop') {
    stop();
    return;
  }
  if (d && typeof d.interval === 'number' && d.interval > 0) {
    stop();
    timer = setInterval(function () {
      self.postMessage('tick');
    }, Math.max(1, d.interval));
  }
};
`;
