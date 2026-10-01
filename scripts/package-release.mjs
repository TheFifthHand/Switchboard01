// Builds the downloadable package: release/omni-song-<version>.zip
//
//   Start Omni Song.bat        Windows launcher (PowerShell, loopback only)
//   START HERE.txt             plain-language guide
//   app/                       the production build (dist/, without source maps)
//   launcher/serve.ps1         PowerShell static server used by the .bat
//   launcher/serve.mjs         Node alternative (node launcher/serve.mjs app)
//   ASSETS.md                  asset provenance
//   source/                    the repository source: the files git lists (committed,
//                              or new and not ignored), without release/, evidence/wav/,
//                              docs/screenshots/ and large media files
//
// `npm run package` builds first. Run on its own, this script refuses a missing
// build and a build older than the source.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

// fileURLToPath, not URL.pathname: that one keeps a leading "/" before Windows
// drive letters and percent-encodes spaces ("C:\Users\Jo Ann\...").
const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const dist = join(root, 'dist');
if (!existsSync(join(dist, 'index.html'))) {
  console.error('dist/index.html not found. Run `npm run package` (it builds first).');
  process.exit(1);
}

/** What the production build is made from. */
const BUILD_INPUTS = ['src', 'public', 'index.html', 'vite.config.ts', 'tsconfig.json', 'package.json', 'package-lock.json'];

function newestInput() {
  let newest = { time: 0, path: '' };
  const visit = (path) => {
    if (!existsSync(path)) return;
    const st = statSync(path);
    if (st.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name));
    else if (st.mtimeMs > newest.time) newest = { time: st.mtimeMs, path };
  };
  for (const p of BUILD_INPUTS) visit(join(root, p));
  return newest;
}

const newest = newestInput();
if (newest.time > statSync(join(dist, 'index.html')).mtimeMs) {
  console.error(`dist/ is older than the source (${relative(root, newest.path)} changed after the last build).`);
  console.error('Run `npm run package`, which builds first.');
  process.exit(1);
}

/** Left out of source/: the release zips, recorded evidence audio, screenshots and large media. */
const SOURCE_SKIP_DIRS = ['release/', 'evidence/wav/', 'docs/screenshots/'];
const SOURCE_SKIP_EXT = /\.(wav|aiff?|flac|mp3|ogg|m4a|mp4|webm|mov|zip)$/i;
const SOURCE_MAX_BYTES = 2 * 1024 * 1024;

/** Paths git lists for the working tree (committed, or new and not ignored), with "/" separators. */
function repositoryFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return [...new Set(out.split('\0').filter(Boolean))].sort();
  } catch {
    console.error('Cannot list the source files. Run this in a git clone of the repository, with git installed.');
    process.exit(1);
  }
}

const files = {};
const add = (zipPath, diskPath) => {
  files[zipPath] = [new Uint8Array(readFileSync(diskPath)), { mtime: new Date('2026-01-01T00:00:00Z') }];
};

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (!name.endsWith('.map')) add(`app/${relative(dist, full).split(sep).join('/')}`, full);
  }
}
walk(dist);

add('Start Omni Song.bat', join(root, 'launcher', 'Start Omni Song.bat'));
add('START HERE.txt', join(root, 'launcher', 'START-HERE.txt'));
add('launcher/serve.ps1', join(root, 'launcher', 'serve.ps1'));
add('launcher/serve.mjs', join(root, 'launcher', 'serve.mjs'));
if (existsSync(join(root, 'ASSETS.md'))) add('ASSETS.md', join(root, 'ASSETS.md'));

let sourceCount = 0;
let leftOut = 0;
for (const path of repositoryFiles()) {
  const full = join(root, ...path.split('/'));
  // Deleted in the working tree, or not a plain file (a linked folder).
  if (!existsSync(full) || !statSync(full).isFile()) continue;
  if (SOURCE_SKIP_DIRS.some((d) => path.startsWith(d)) || SOURCE_SKIP_EXT.test(path) || statSync(full).size > SOURCE_MAX_BYTES) {
    leftOut++;
    continue;
  }
  add(`source/${path}`, full);
  sourceCount++;
}

const zip = zipSync(files, { level: 9 });
mkdirSync(join(root, 'release'), { recursive: true });
const out = join(root, 'release', `omni-song-${pkg.version}.zip`);
writeFileSync(out, zip);
console.log(`Wrote ${relative(root, out)} (${(zip.length / 1024 / 1024).toFixed(2)} MB, ${Object.keys(files).length} files)`);
console.log(`source/: ${sourceCount} files (${leftOut} left out: release zips, evidence audio, screenshots, large media).`);
