// The Node launcher (launcher/serve.mjs) after the rename: it says Omni Song,
// it recognises a running Omni Song, and it also recognises a running copy of
// the same app from before 2.0 (SWITCHBOARD / 01): that copy is opened (same
// address, same projects) instead of moving Omni Song to another address, and
// the window says how to switch to the new version.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const SERVE = fileURLToPath(new URL('../../launcher/serve.mjs', import.meta.url));
const TITLE = '<title>Omni Song</title>';
const OLD_TITLE = '<title>SWITCHBOARD / 01</title>';

let dir = '';
let appDir = '';
const children: ChildProcess[] = [];
const servers: Server[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'omni-launcher-'));
  appDir = join(dir, 'app');
  mkdirSync(appDir);
  writeFileSync(join(appDir, 'index.html'), `<!doctype html><html><head>${TITLE}</head><body></body></html>`);
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

/** The first port in 4500-4559 with `count` free ports in a row. */
async function freePorts(count: number): Promise<number> {
  for (let p = 4500; p + count - 1 <= 4559; p++) {
    let ok = true;
    for (let i = 0; i < count && ok; i++) ok = await isFree(p + i);
    if (ok) return p;
  }
  throw new Error('No free test ports in 4500-4559');
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

async function pageOn(port: number, body: string): Promise<void> {
  const s = createServer((_req, res) => res.end(body));
  servers.push(s);
  await new Promise<void>((done) => s.listen(port, '127.0.0.1', done));
}

describe('Node launcher, renamed', () => {
  it('says Omni Song, and a second start opens the Omni Song already running', async () => {
    const port = await freePorts(2);
    const first = launch(['--port', String(port), '--no-open']);
    await waitFor(first, /running at/);
    expect(first.out()).toContain(`Omni Song is running at http://127.0.0.1:${port}/`);
    const second = launch(['--port', String(port), '--no-open']);
    expect(await second.exited).toBe(0);
    expect(second.out()).toContain(`Omni Song is already running at http://127.0.0.1:${port}/`);
    expect(second.out()).not.toContain('older version');
    expect(await isFree(port + 1)).toBe(true);
  });

  it('recognises SWITCHBOARD / 01 running at the usual address: opens it and says how to switch, instead of moving to another address', async () => {
    const port = await freePorts(2);
    await pageOn(port, `<!doctype html><html><head>${OLD_TITLE}</head></html>`);
    const run = launch(['--port', String(port), '--no-open']);
    expect(await run.exited).toBe(0);
    const out = run.out();
    expect(out).toContain(`An older version of this app (SWITCHBOARD / 01) is already running at http://127.0.0.1:${port}/`);
    expect(out).toContain('close the window that runs the older version, then start Omni Song again');
    expect(out).not.toContain('used by another program');
    expect(await isFree(port + 1)).toBe(true);
  });

  it('another program on the port is still explained, and --strict-port names Omni Song', async () => {
    const port = await freePorts(2);
    await pageOn(port, 'Some other program');
    const run = launch(['--port', String(port), '--strict-port', '--no-open']);
    expect(await run.exited).toBe(1);
    expect(run.out()).toContain(`so Omni Song cannot open at its usual address http://127.0.0.1:${port}/`);
    expect(run.out()).toContain('then start Omni Song again');
    expect(run.err()).toContain(`--strict-port keeps Omni Song on port ${port}`);
  });
});
