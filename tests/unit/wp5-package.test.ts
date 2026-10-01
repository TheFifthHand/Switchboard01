// The release package (scripts/package-release.mjs, `npm run package`), run
// from a clone whose path has spaces, as under "C:\Users\Jo Ann\...".
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const hasGit = spawnSync('git', ['--version']).status === 0;

// No outer git settings may leak into the temporary clone.
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
  // lstat: never follow the node_modules link into this checkout's own dependencies.
  const st = lstatSync(path);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) for (const name of readdirSync(path)) setTimes(join(path, name), seconds);
  else utimesSync(path, seconds, seconds);
}

function runPackage() {
  // Started from another folder: the script finds the clone from its own location.
  return spawnSync(process.execPath, [join(clone, 'scripts', 'package-release.mjs')], { cwd: base, env, encoding: 'utf8' });
}

const zipPath = () => join(clone, 'release', 'omni-song-9.9.9.zip');

beforeAll(() => {
  if (!hasGit) return;
  base = mkdtempSync(join(tmpdir(), 'sb package '));
  clone = join(base, 'Jo Ann', 'switchboard 01');
  mkdirSync(clone, { recursive: true });
  put('package.json', JSON.stringify({ name: 'omni-song', version: '9.9.9', type: 'module' }));
  put('.gitignore', `${readFileSync(join(REPO, '.gitignore'), 'utf8')}\nnode_modules\n`);
  mkdirSync(join(clone, 'scripts'));
  copyFileSync(join(REPO, 'scripts', 'package-release.mjs'), join(clone, 'scripts', 'package-release.mjs'));
  for (const f of ['Start Omni Song.bat', 'START-HERE.txt', 'serve.ps1', 'serve.mjs']) put(`launcher/${f}`, readFileSync(join(REPO, 'launcher', f)));
  // The script's one dependency (fflate), from this checkout.
  symlinkSync(join(REPO, 'node_modules'), join(clone, 'node_modules'), 'junction');
  put('ASSETS.md', '# Assets\n');
  put('index.html', '<!doctype html><title>Omni Song</title>');
  put('src/main.ts', 'export {};\n');
  put('public/icons/favicon.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
  put('docs/notes.md', '# Notes\n');
  put('docs/screenshots/play.png', new Uint8Array(64));
  put('evidence/wav/groove.wav', new Uint8Array(64));
  put('release/omni-song-0.0.1.zip', new Uint8Array(64));
  put('tools/huge.bin', new Uint8Array(3 * 1024 * 1024));
  put('dist/index.html', '<!doctype html><title>Omni Song</title>');
  put('dist/assets/app.js', 'console.log(1);\n');
  put('dist/assets/app.js.map', '{}');
  execFileSync('git', ['init', '-q'], { cwd: clone, env });
  execFileSync('git', ['add', '-A'], { cwd: clone, env });
  // A new file not yet committed is still part of the source the build came from.
  put('src/fresh.ts', 'export const fresh = 1;\n');
  // Source first, build afterwards.
  const now = Math.floor(Date.now() / 1000);
  setTimes(clone, now - 100);
  setTimes(join(clone, 'dist'), now - 50);
});

afterAll(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

describe.skipIf(!hasGit)('Release package', () => {
  it('builds one zip with the app, the Windows launcher, START HERE and the source, from a path with spaces', () => {
    const run = runPackage();
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(existsSync(zipPath())).toBe(true);
    const entries = unzipSync(new Uint8Array(readFileSync(zipPath())));
    const names = Object.keys(entries);

    // Ready to run on Windows.
    for (const n of ['Start Omni Song.bat', 'START HERE.txt', 'launcher/serve.ps1', 'launcher/serve.mjs', 'ASSETS.md', 'app/index.html', 'app/assets/app.js']) expect(names).toContain(n);
    expect(new TextDecoder().decode(entries['Start Omni Song.bat'])).toBe(readFileSync(join(REPO, 'launcher', 'Start Omni Song.bat'), 'utf8'));
    expect(names).not.toContain('app/assets/app.js.map');

    // The source, including a new file that is not committed yet.
    for (const n of ['source/package.json', 'source/index.html', 'source/src/main.ts', 'source/src/fresh.ts', 'source/public/icons/favicon.svg', 'source/docs/notes.md', 'source/scripts/package-release.mjs', 'source/launcher/Start Omni Song.bat', 'source/.gitignore']) {
      expect(names).toContain(n);
    }
    // Not the build, dependencies, earlier releases, evidence audio, screenshots or large binaries.
    const leaked = names.filter((n) => /^source\/(dist|node_modules|release|evidence\/wav|docs\/screenshots)(\/|$)|^source\/tools\/huge\.bin$/.test(n));
    expect(leaked).toEqual([]);
  });

  it('refuses a build that is older than the source', () => {
    rmSync(zipPath(), { force: true });
    const later = Math.floor(Date.now() / 1000);
    utimesSync(join(clone, 'src', 'main.ts'), later, later);
    const run = runPackage();
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('dist/ is older than the source');
    expect(run.stderr).toContain('npm run package');
    expect(existsSync(zipPath())).toBe(false);
  });
});
