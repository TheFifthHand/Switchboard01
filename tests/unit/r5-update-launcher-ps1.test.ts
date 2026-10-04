// The Windows launcher (launcher/serve.ps1) behaves like serve.mjs when another
// version still runs at the usual address: it names both versions, waits, and
// starts the new version at the same address once the old window is closed.
// Runs where PowerShell is installed (pwsh on PATH, or OMNI_PWSH=<path>);
// Windows PowerShell 5.1 is what "Start Omni Song.bat" uses.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, get, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const PS1 = fileURLToPath(new URL('../../launcher/serve.ps1', import.meta.url));
const PWSH = process.env.OMNI_PWSH ?? 'pwsh';
const hasPwsh = spawnSync(PWSH, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' }).status === 0;
const page = (version: string | null) =>
  `<!doctype html><html><head><title>Omni Song</title>${version ? `<meta name="omni-song-version" content="${version}">` : ''}</head><body></body></html>`;

let dir = '';
let appDir = '';
const children: ChildProcess[] = [];
const servers: Server[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'omni-update-ps1-'));
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
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function isFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const s = createNetServer();
    s.once('error', () => done(false));
    s.listen(port, '127.0.0.1', () => s.close(() => done(true)));
  });
}

/** The first port in 4620-4679 with `count` free ports in a row. */
async function freePorts(count: number): Promise<number> {
  for (let p = 4620; p + count - 1 <= 4679; p++) {
    let ok = true;
    for (let i = 0; i < count && ok; i++) ok = await isFree(p + i);
    if (ok) return p;
  }
  throw new Error('No free test ports in 4620-4679');
}

function launch(port: number) {
  const child = spawn(PWSH, ['-NoProfile', '-File', PS1, '-Root', appDir, '-Port', String(port), '-NoOpen'], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let out = '';
  child.stdout!.setEncoding('utf8').on('data', (d: string) => (out += d));
  child.stderr!.setEncoding('utf8').on('data', (d: string) => (out += d));
  const exited = new Promise<number | null>((done) => child.on('exit', (code) => done(code)));
  return { child, out: () => out, exited };
}

async function waitFor(run: ReturnType<typeof launch>, re: RegExp, ms = 15000) {
  const until = Date.now() + ms;
  while (!re.test(run.out())) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${re}. output:\n${run.out()}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function copyOn(port: number, body: string): Promise<Server> {
  const s = createServer((_req, res) => res.end(body));
  servers.push(s);
  await new Promise<void>((done) => s.listen(port, '127.0.0.1', done));
  return s;
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

describe.skipIf(!hasPwsh)('Windows launcher (serve.ps1) with another version running', () => {
  it('names both versions, waits, and starts the new version at the same address once the old window is closed', async () => {
    const port = await freePorts(2);
    const old = await copyOn(port, page('2.2.0'));
    const run = launch(port);
    await waitFor(run, /Waiting for the other copy to stop/);
    const out = run.out();
    expect(out).toContain('Another copy of Omni Song (version 2.2.0) is running in another window,');
    expect(out).toContain(`at http://127.0.0.1:${port}/`);
    expect(out).toContain('This is version 2.3.0. Close the other small black Omni Song window');
    expect(out).toContain('this window then starts version 2.3.0 by itself,');
    expect(out).not.toContain('used by another program');
    expect(run.child.exitCode).toBeNull();

    servers.splice(servers.indexOf(old), 1);
    old.closeAllConnections();
    await new Promise((done) => old.close(done));
    await waitFor(run, new RegExp(`Running at http://127\\.0\\.0\\.1:${port}/  \\(this computer only\\)`), 8000);
    expect(run.out()).toContain('The other copy has stopped.');
    expect(await fetchText(port)).toContain('content="2.3.0"');
    expect(await isFree(port + 1)).toBe(true);
  }, 40_000);

  it('a running 2.2 (no version named) counts as an older version; the same version is opened and the window exits', async () => {
    const port = await freePorts(1);
    const old = await copyOn(port, page(null));
    const waiting = launch(port);
    await waitFor(waiting, /Waiting for the other copy to stop/);
    expect(waiting.out()).toContain('Another copy of Omni Song (an older version) is running in another window,');
    servers.splice(servers.indexOf(old), 1);
    old.closeAllConnections();
    await new Promise((done) => old.close(done));
    await waitFor(waiting, /Running at/, 8000);

    const again = launch(port);
    expect(await again.exited).toBe(0);
    expect(again.out()).toContain(`Omni Song is already running at http://127.0.0.1:${port}/`);
    expect(again.out()).not.toContain('Waiting');
  }, 40_000);
});
