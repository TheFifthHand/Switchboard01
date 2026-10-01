// The Node launcher (launcher/serve.mjs, `npm run serve`): it keeps serving
// without a browser opener, and it stays on one address because the browser
// keeps projects per address (the port is part of it).
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, get, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const SERVE = fileURLToPath(new URL('../../launcher/serve.mjs', import.meta.url));
const TITLE = '<title>Omni Song</title>';

let dir = '';
let appDir = '';
let emptyBin = '';
const children: ChildProcess[] = [];
const servers: Server[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sb-launcher-'));
  // A minimal app folder: what the launcher serves and recognises.
  appDir = join(dir, 'app');
  mkdirSync(appDir);
  writeFileSync(join(appDir, 'index.html'), `<!doctype html><html><head>${TITLE}</head><body></body></html>`);
  // A PATH with no programs in it.
  emptyBin = join(dir, 'no-programs');
  mkdirSync(emptyBin);
});

afterEach(async () => {
  const running = children.splice(0).filter((c) => c.exitCode === null && c.signalCode === null);
  await Promise.all(running.map((c) => new Promise((done) => (c.once('exit', done), c.kill()))));
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
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

/** The first port in 4440-4499 with `count` free ports in a row. */
async function freePorts(count: number): Promise<number> {
  for (let p = 4440; p + count - 1 <= 4499; p++) {
    let ok = true;
    for (let i = 0; i < count && ok; i++) ok = await isFree(p + i);
    if (ok) return p;
  }
  throw new Error('No free test ports in 4440-4499');
}

interface Run {
  child: ChildProcess;
  out(): string;
  err(): string;
  exited: Promise<number | null>;
}

function launch(args: string[], env: NodeJS.ProcessEnv = process.env): Run {
  const child = spawn(process.execPath, [SERVE, appDir, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let out = '';
  let err = '';
  child.stdout!.setEncoding('utf8').on('data', (d: string) => (out += d));
  child.stderr!.setEncoding('utf8').on('data', (d: string) => (err += d));
  const exited = new Promise<number | null>((done) => child.on('exit', (code) => done(code)));
  return { child, out: () => out, err: () => err, exited };
}

async function waitFor(run: Run, re: RegExp, ms = 8000): Promise<RegExpMatchArray> {
  const until = Date.now() + ms;
  for (;;) {
    const m = re.exec(run.out());
    if (m) return m;
    if (Date.now() > until) throw new Error(`Timed out waiting for ${re}. stdout:\n${run.out()}\nstderr:\n${run.err()}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function fetchText(port: number): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    get({ host: '127.0.0.1', port, path: '/', agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => done({ status: res.statusCode ?? 0, body }));
    }).on('error', fail);
  });
}

async function otherProgramOn(port: number): Promise<void> {
  const s = createServer((_req, res) => res.end('Some other program'));
  servers.push(s);
  await new Promise<void>((done) => s.listen(port, '127.0.0.1', done));
}

describe('Node launcher (npm run serve)', () => {
  it.skipIf(process.platform === 'win32')('keeps serving when this computer has no program to open a browser', async () => {
    const port = await freePorts(1);
    // No xdg-open / open on PATH, as on a minimal Linux, WSL or a container.
    const run = launch(['--port', String(port)], { ...process.env, PATH: emptyBin });
    await waitFor(run, new RegExp(`running at http://127\\.0\\.0\\.1:${port}/`));
    await waitFor(run, new RegExp(`Open http://127\\.0\\.0\\.1:${port}/ in your browser\\.`));
    await new Promise((r) => setTimeout(r, 300));
    expect(run.child.exitCode).toBeNull();
    const page = await fetchText(port);
    expect(page.status).toBe(200);
    expect(page.body).toContain(TITLE);
  });

  it('a second start opens the Omni Song already running there instead of moving to a new address', async () => {
    const port = await freePorts(2);
    const first = launch(['--port', String(port), '--no-open']);
    await waitFor(first, /running at/);
    const second = launch(['--port', String(port), '--no-open']);
    expect(await second.exited).toBe(0);
    expect(second.out()).toContain(`already running at http://127.0.0.1:${port}/`);
    expect(second.out()).not.toContain(`http://127.0.0.1:${port + 1}/`);
    // The first copy keeps serving.
    expect((await fetchText(port)).body).toContain(TITLE);
  });

  it('recognises a running Omni Song that answers slowly (a launcher window busy with another connection)', async () => {
    const port = await freePorts(2);
    // The Windows launcher serves one connection at a time and waits up to 3 s on an idle one.
    const busy = createServer((_req, res) => setTimeout(() => res.end(`<!doctype html><html><head>${TITLE}</head></html>`), 3500));
    servers.push(busy);
    await new Promise<void>((done) => busy.listen(port, '127.0.0.1', done));
    const run = launch(['--port', String(port), '--no-open']);
    expect(await run.exited).toBe(0);
    expect(run.out()).toContain(`already running at http://127.0.0.1:${port}/`);
    expect(run.out()).not.toContain('used by another program');
    expect(await isFree(port + 1)).toBe(true);
  }, 15_000);

  it('when another program holds the port, it first explains that projects saved there will not appear, then uses the next free port', async () => {
    const port = await freePorts(2);
    await otherProgramOn(port);
    const run = launch(['--port', String(port), '--no-open']);
    const m = await waitFor(run, /running at http:\/\/127\.0\.0\.1:(\d+)\/ \(not the usual http:\/\/127\.0\.0\.1:(\d+)\/\)/);
    expect(Number(m[1])).toBe(port + 1);
    expect(Number(m[2])).toBe(port);
    const out = run.out();
    const explained = out.indexOf(`Port ${port} is used by another program`);
    expect(explained).toBeGreaterThanOrEqual(0);
    expect(explained).toBeLessThan(out.indexOf('running at'));
    expect(out).toContain(`http://127.0.0.1:${port}/ will not appear in My projects at another address`);
    expect(out).toContain(`close the program that uses port ${port}`);
    expect(out).toContain('"Export this project"');
    expect((await fetchText(port + 1)).body).toContain(TITLE);
    // The other program is untouched.
    expect((await fetchText(port)).body).toBe('Some other program');
  });

  it('--strict-port stops with the explanation instead of changing the address', async () => {
    const port = await freePorts(2);
    await otherProgramOn(port);
    const run = launch(['--port', String(port), '--strict-port', '--no-open']);
    expect(await run.exited).toBe(1);
    expect(run.out()).toContain('will not appear in My projects');
    expect(run.err()).toContain(`--strict-port keeps Omni Song on port ${port}`);
    expect(await isFree(port + 1)).toBe(true);
  });
});
