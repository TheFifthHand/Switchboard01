// Builds the downloadable package: release/switchboard01-<version>.zip
//
//   Start SWITCHBOARD.bat      Windows launcher (PowerShell, loopback only)
//   START HERE.txt             plain-language guide
//   app/                       the production build (dist/)
//   launcher/serve.ps1         PowerShell static server used by the .bat
//   launcher/serve.mjs         Node alternative (node launcher/serve.mjs app)
//   ASSETS.md                  asset provenance
//
// Run `npm run build` first (the script refuses to package a missing build).
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { zipSync } from 'fflate';

const root = new URL('..', import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const dist = join(root, 'dist');
if (!existsSync(join(dist, 'index.html'))) {
  console.error('dist/index.html not found. Run `npm run build` first.');
  process.exit(1);
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

add('Start SWITCHBOARD.bat', join(root, 'launcher', 'Start SWITCHBOARD.bat'));
add('START HERE.txt', join(root, 'launcher', 'START-HERE.txt'));
add('launcher/serve.ps1', join(root, 'launcher', 'serve.ps1'));
add('launcher/serve.mjs', join(root, 'launcher', 'serve.mjs'));
if (existsSync(join(root, 'ASSETS.md'))) add('ASSETS.md', join(root, 'ASSETS.md'));

const zip = zipSync(files, { level: 9 });
mkdirSync(join(root, 'release'), { recursive: true });
const out = join(root, 'release', `switchboard01-${pkg.version}.zip`);
writeFileSync(out, zip);
console.log(`Wrote ${relative(root, out)} (${(zip.length / 1024 / 1024).toFixed(2)} MB, ${Object.keys(files).length} files)`);
