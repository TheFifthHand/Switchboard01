// A new download always opens the new version: when another version of Omni
// Song still runs at the usual address (an old launcher window left open), the
// new launcher (launcher/serve.mjs) names both versions, waits until the old
// window is closed and then starts the new version at the SAME address (the
// browser keeps projects per address). The same version is simply opened.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, get, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error: a plain JavaScript launcher with no type declarations.
import { decide, pageInfo, versionIn, waitMessage } from '../../launcher/serve.mjs';

const SERVE = fileURLToPath(new URL('../../launcher/serve.mjs', import.meta.url));
const TITLE = '<title>Omni Song</title>';
const OLD_TITLE = '<title>SWITCHBOARD / 01</title>';
/** An index.html as the build writes it (vite.config.ts adds the version meta at the end of the head). */
const page = (version: string | null, title = TITLE) =>
  `<!doctype html><html lang="en"><head><meta charset="UTF-8" />${title}<script type="module" crossorigin src="./assets/index.js"></script>${
    version ? `<meta name="omni-song-version" content="${version}">` : ''
  }<link rel="manifest" href="./manifest.webmanifest"></head><body><div id="root"></div></body></html>`;

let dir = '';
let appDir = '';
const children: ChildProcess[] = [];
const servers: Server[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'omni-update-'));
  // This launcher's own app: version 2.3.0.
  appDir = join(dir, 'app');
  mkdirSync(appDir);
  writeFileSync(join(appDir, 'index.html'), page('2.3.0'));
});

afterEach(async () => {
  const running = children.splice(0).filter((c) => c.exitCode === null && c.signalCode === null);
  await Promise.all(running.map((c) => new Promise((done) => (c.once('exit', done), c.kill()))));
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => (s.closeAllConnections(), s.close(done)))));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function isFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const s = createNetServer();
    s.once('error', () => done(false));
    s.listen(port, '127.0.0.1', () => s.close(() => done(true)));
  });
}

/** The first port in 4560-4619 with `count` free ports in a row. */
async function freePorts(count: number): Promise<number> {
  for (let p = 4560; p + count - 1 <= 4619; p++) {
    let ok = true;
    for (let i = 0; i < count && ok; i++) ok = await isFree(p + i);
    if (ok) return p;
  }
  throw new Error('No free test ports in 4560-4619');
}

function launch(args: string[]) {
  const child = spawn(process.execPath, [SERVE, appDir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let out = '';
  let err = '';
  child.stdout!.setEncoding('utf8').on('data', (d: string) => (out += d));
  child.stderr!.setEncoding('utf8').on('data', (d: string) => (err += d));
  const exited = new Promise<number | null>((done) => child.on('exit', (code) => done(code)));
  return { child, out: () => out, err: () => err, exited };
}

async function waitFor(run: ReturnType<typeof launch>, re: RegExp, ms = 8000) {
  const until = Date.now() + ms;
  while (!re.test(run.out())) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${re}. stdout:\n${run.out()}\nstderr:\n${run.err()}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Another copy answering on the port (an old launcher window), serving `body`. */
async function copyOn(port: number, body: string): Promise<Server> {
  const s = createServer((_req, res) => res.end(body));
  servers.push(s);
  await new Promise<void>((done) => s.listen(port, '127.0.0.1', done));
  return s;
}

function stop(s: Server): Promise<void> {
  servers.splice(servers.indexOf(s), 1);
  s.closeAllConnections();
  return new Promise((done) => s.close(() => done()));
}

function fetchText(port: number): Promise<string> {
  return new Promise((done, fail) => {
    get({ host: '127.0.0.1', port, path: '/', agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => done(body));
    }).on('error', fail);
  });
}

describe('which copy answers, and which version it is', () => {
  it('reads the version a built page names, and tells Omni Song, SWITCHBOARD / 01 and other programs apart', () => {
    expect(pageInfo(page('2.3.0'))).toEqual({ app: 'current', version: '2.3.0' });
    // 2.2 and earlier name no version.
    expect(pageInfo(page(null))).toEqual({ app: 'current', version: null });
    expect(pageInfo(page(null, OLD_TITLE))).toEqual({ app: 'older', version: null });
    expect(pageInfo('<html><head><title>Something else</title><meta name="omni-song-version" content="9.9.9"></head></html>')).toEqual({ app: null, version: null });
    // Attribute order and quotes as other tools may write them.
    expect(versionIn(`<meta content='2.4.1' name='omni-song-version' />`)).toBe('2.4.1');
    expect(versionIn('<meta name="description" content="2.0">')).toBeNull();
  });

  it('opens a copy of the same version, and waits for any other version', () => {
    expect(decide('2.3.0', { app: 'current', version: '2.3.0' })).toBe('open');
    expect(decide('2.3.0', { app: 'current', version: '2.2.0' })).toBe('wait');
    expect(decide('2.3.0', { app: 'current', version: '2.4.0' })).toBe('wait');
    expect(decide('2.3.0', { app: 'current', version: null })).toBe('wait');
    expect(decide('2.3.0', { app: 'older', version: null })).toBe('wait');
  });

  it('says plainly which version runs, which one this is, and what to do', () => {
    const where = 'http://127.0.0.1:4173/';
    expect(waitMessage('2.3.0', { app: 'current', version: null }, where).join(' ')).toBe(
      'Another copy of Omni Song (an older version) is running in another window, at http://127.0.0.1:4173/ ' +
        'This is version 2.3.0. Close the other small black Omni Song window (or press Ctrl+C in it): ' +
        'this window then starts version 2.3.0 by itself, at the same address, so all your projects are there. ' +
        'Waiting for the other copy to stop...',
    );
    expect(waitMessage('2.3.0', { app: 'current', version: '2.4.0' }, where)[0]).toBe('Another copy of Omni Song (version 2.4.0) is running in another window,');
    const old = waitMessage('2.3.0', { app: 'older', version: null }, where).join(' ');
    expect(old).toContain('An older version of this app (SWITCHBOARD / 01) is running in another window');
    expect(old).toContain('Close the other small black SWITCHBOARD / 01 window');
  });
});

describe('Node launcher with another version running', () => {
  it('names both versions, waits, and starts the new version at the same address once the old window is closed', async () => {
    const port = await freePorts(2);
    const old = await copyOn(port, page('2.2.0'));
    const run = launch(['--port', String(port), '--no-open']);
    await waitFor(run, /Waiting for the other copy to stop/);
    const out = run.out();
    expect(out).toContain('Another copy of Omni Song (version 2.2.0) is running in another window,');
    expect(out).toContain(`at http://127.0.0.1:${port}/`);
    expect(out).toContain('This is version 2.3.0. Close the other small black Omni Song window');
    expect(out).not.toContain('already running');
    expect(out).not.toContain('used by another program');
    // It keeps waiting (it neither opens the old copy nor moves to another address).
    await new Promise((r) => setTimeout(r, 1500));
    expect(run.child.exitCode).toBeNull();
    expect(run.out()).not.toContain('running at');
    expect(await isFree(port + 1)).toBe(true);
    expect(await fetchText(port)).toContain('content="2.2.0"');

    // The old window is closed: within about a second the new version answers at the same address.
    await stop(old);
    await waitFor(run, new RegExp(`Omni Song is running at http://127\\.0\\.0\\.1:${port}/\\n`), 5000);
    expect(run.out()).toContain('The other copy has stopped.');
    expect(await fetchText(port)).toContain('content="2.3.0"');
    expect(await isFree(port + 1)).toBe(true);
  }, 20_000);

  it('a running 2.2 (no version named) counts as an older version', async () => {
    const port = await freePorts(1);
    const old = await copyOn(port, page(null));
    const run = launch(['--port', String(port), '--no-open']);
    await waitFor(run, /Waiting for the other copy to stop/);
    expect(run.out()).toContain('Another copy of Omni Song (an older version) is running in another window,');
    await stop(old);
    await waitFor(run, /Omni Song is running at/, 5000);
    expect(await fetchText(port)).toContain('content="2.3.0"');
  }, 20_000);

  it('the same version already running is opened, as before, and this launcher exits', async () => {
    const port = await freePorts(2);
    await copyOn(port, page('2.3.0'));
    const run = launch(['--port', String(port), '--no-open']);
    expect(await run.exited).toBe(0);
    expect(run.out()).toContain(`Omni Song is already running at http://127.0.0.1:${port}/`);
    expect(run.out()).not.toContain('Waiting');
    expect(await isFree(port + 1)).toBe(true);
  });

  it('two new launchers waiting (a second double-click): one starts, the other then opens it and exits', async () => {
    const port = await freePorts(2);
    const old = await copyOn(port, page('2.2.0'));
    const first = launch(['--port', String(port), '--no-open']);
    const second = launch(['--port', String(port), '--no-open']);
    await waitFor(first, /Waiting for the other copy to stop/);
    await waitFor(second, /Waiting for the other copy to stop/);
    await stop(old);
    const [winner, other] = await Promise.race([
      waitFor(first, /Omni Song is running at/, 5000).then(() => [first, second]),
      waitFor(second, /Omni Song is running at/, 5000).then(() => [second, first]),
    ]);
    expect(await other.exited).toBe(0);
    expect(other.out()).toContain(`Omni Song version 2.3.0 is now running at http://127.0.0.1:${port}/`);
    expect(winner.child.exitCode).toBeNull();
    expect(await fetchText(port)).toContain('content="2.3.0"');
    expect(await isFree(port + 1)).toBe(true);
  }, 20_000);

  it('Ctrl+C stops a launcher that is waiting', async () => {
    const port = await freePorts(1);
    await copyOn(port, page('2.2.0'));
    const run = launch(['--port', String(port), '--no-open']);
    await waitFor(run, /Waiting for the other copy to stop/);
    run.child.kill('SIGINT');
    await run.exited;
    expect(run.child.exitCode !== null || run.child.signalCode === 'SIGINT').toBe(true);
  });
});
