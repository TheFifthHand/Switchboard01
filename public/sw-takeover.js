/*
 * Omni Song: a new version opens by itself, unless a page is in use.
 *
 * Imported by the generated service worker (sw.js, see vite.config.ts); the
 * page side is src/app/pwa.ts. Without this, the browser keeps showing the
 * version it stored until every Omni Song tab is closed, and a refresh does
 * not help: a new download seemed to open the old version.
 *
 * - Installing over an earlier version: every open window is asked
 *   "omni:busy?". A page from 2.3 on answers "busy" once it has been used
 *   (a key or the pointer pressed in it, playback, a recording, an export),
 *   otherwise "idle". With no page busy, the new version activates at once.
 *   Pages that do not answer (2.2 and older cannot) count as not busy.
 *   With a page busy it waits: the ⋯ menu offers Update (SKIP_WAITING),
 *   and a page that loads later asks it to try again (OMNI_TAKE_OVER_IF_IDLE).
 * - Activating: the windows the earlier version was showing are asked again.
 *   A page that answers reloads itself when it is not in use (or offers
 *   Update when it is). A page that does not answer is an older build that
 *   cannot reload itself, so it is reloaded here into the new version.
 */
const ASK = 'omni:busy?';
/** How long a page has to answer before a new version installs (no answer: not busy). */
const ASK_INSTALL_MS = 700;
/** How long a page has to answer once the new version is active (no answer: reloaded). Longer: a busy page's answer may wait behind its work. */
const ASK_ACTIVATE_MS = 2000;

/** Ask one window: 'busy', 'idle', or null when it does not answer in time. */
function ask(client, ms) {
  return new Promise((done) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => done(null), ms);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      done(event.data === 'busy' ? 'busy' : 'idle');
    };
    try {
      client.postMessage(ASK, [channel.port2]);
    } catch {
      clearTimeout(timer);
      done(null);
    }
  });
}

/** Whether any open Omni Song window (shown by any version) is in use. */
async function anyBusy() {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const answers = await Promise.all(windows.map((client) => ask(client, ASK_INSTALL_MS)));
  return answers.includes('busy');
}

async function takeOverIfIdle() {
  if (!(await anyBusy())) await self.skipWaiting();
}

self.addEventListener('install', (event) => {
  // The first install replaces nothing: it activates at once anyway.
  if (!self.registration.active) return;
  event.waitUntil(takeOverIfIdle());
});

self.addEventListener('message', (event) => {
  // A page that just loaded found this version waiting (a page was busy when it installed).
  if (event.data && event.data.type === 'OMNI_TAKE_OVER_IF_IDLE') event.waitUntil(takeOverIfIdle());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // The windows the earlier version showed: they belong to this version now.
      const taken = await self.clients.matchAll({ type: 'window' });
      // Also serve pages opened before any version was installed (offline right away).
      await self.clients.claim();
      const answers = await Promise.all(taken.map((client) => ask(client, ASK_ACTIVATE_MS)));
      taken.forEach((client, i) => {
        // Not awaited: the page's request waits for this activation to finish.
        if (answers[i] === null) client.navigate(client.url).catch(() => {});
      });
    })(),
  );
});
