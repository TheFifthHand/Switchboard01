// The release package after the rename (scripts/package-release.mjs): one
// zip named omni-song-<version>.zip with "Start Omni Song.bat", START HERE
// (which explains the change for SWITCHBOARD / 01 users), the app, the
// launchers and the source; built from a clone whose path has spaces.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync, lstatSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const hasGit = spawnSync('git', ['--version']).status === 0;
const env = { ...process.env };
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k];

let base = '';
let clone = '';

function put(rel: string, content: string | Uint8Array) {
  const full = join(clone, ...rel.split('/'));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function setTimes(path: string, seconds: number) {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) for (const name of readdirSync(path)) setTimes(join(path, name), seconds);
  else utimesSync(path, seconds, seconds);
}

beforeAll(() => {
  if (!hasGit) return;
  base = mkdtempSync(join(tmpdir(), 'omni package '));
  clone = join(base, 'Jo Ann', 'omni song');
  mkdirSync(clone, { recursive: true });
  put('package.json', JSON.stringify({ name: 'omni-song', version: '9.9.9', type: 'module' }));
  put('.gitignore', `${readFileSync(join(REPO, '.gitignore'), 'utf8')}\nnode_modules\n`);
  mkdirSync(join(clone, 'scripts'));
  copyFileSync(join(REPO, 'scripts', 'package-release.mjs'), join(clone, 'scripts', 'package-release.mjs'));
  for (const f of ['Start Omni Song.bat', 'START-HERE.txt', 'serve.ps1', 'serve.mjs']) put(`launcher/${f}`, readFileSync(join(REPO, 'launcher', f)));
  symlinkSync(join(REPO, 'node_modules'), join(clone, 'node_modules'), 'junction');
  put('ASSETS.md', '# Assets\n');
  put('index.html', '<!doctype html><title>Omni Song</title>');
  put('src/main.ts', 'export {};\n');
  put('release/switchboard01-1.0.0.zip', new Uint8Array(64));
  put('release/omni-song-1.9.0.zip', new Uint8Array(64));
  put('dist/index.html', '<!doctype html><title>Omni Song</title>');
  put('dist/assets/app.js', 'console.log(1);\n');
  execFileSync('git', ['init', '-q'], { cwd: clone, env });
  execFileSync('git', ['add', '-A'], { cwd: clone, env });
  const now = Math.floor(Date.now() / 1000);
  setTimes(clone, now - 100);
  setTimes(join(clone, 'dist'), now - 50);
});

afterAll(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

describe.skipIf(!hasGit)('Release package, renamed', () => {
  it('writes release/omni-song-<version>.zip with "Start Omni Song.bat" and START HERE', () => {
    const run = spawnSync(process.execPath, [join(clone, 'scripts', 'package-release.mjs')], { cwd: base, env, encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('release/omni-song-9.9.9.zip');
    const zipPath = join(clone, 'release', 'omni-song-9.9.9.zip');
    expect(existsSync(zipPath)).toBe(true);
    expect(existsSync(join(clone, 'release', 'switchboard01-9.9.9.zip'))).toBe(false);
    const entries = unzipSync(new Uint8Array(readFileSync(zipPath)));
    const names = Object.keys(entries);
    for (const n of ['Start Omni Song.bat', 'START HERE.txt', 'launcher/serve.ps1', 'launcher/serve.mjs', 'ASSETS.md', 'app/index.html', 'source/launcher/Start Omni Song.bat']) expect(names).toContain(n);
    expect(names).not.toContain('Start SWITCHBOARD.bat');
    expect(new TextDecoder().decode(entries['Start Omni Song.bat'])).toBe(readFileSync(join(REPO, 'launcher', 'Start Omni Song.bat'), 'utf8'));
    const startHere = new TextDecoder().decode(entries['START HERE.txt']);
    expect(startHere).toContain('Double-click  "Start Omni Song.bat"');
    expect(startHere).toContain('"Start SWITCHBOARD.bat" is now called "Start Omni Song.bat"');
    // Earlier release zips (either name) stay out of source/.
    expect(names.filter((n) => n.startsWith('source/release/'))).toEqual([]);
  });
});
