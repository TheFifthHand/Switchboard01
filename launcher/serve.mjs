#!/usr/bin/env node
// SWITCHBOARD / 01 — tiny local web server.
// Serves ONE directory (the built app) on the loopback interface only (127.0.0.1).
// Usage: node serve.mjs [directory] [--port 4173] [--no-open]
// Stop with Ctrl+C (or close the window).
import { createServer } from 'node:http';
import { createReadStream, statSync, existsSync } from 'node:fs';
import { resolve, join, extname, sep } from 'node:path';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const dirArg = args.find((a, i) => !a.startsWith('--') && !(args[i - 1] ?? '').startsWith('--port'));
const root = resolve(dirArg ?? 'app');
const portIdx = args.indexOf('--port');
const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 4173;
const openBrowser = !args.includes('--no-open');
const HOST = '127.0.0.1';

if (!existsSync(join(root, 'index.html'))) {
  console.error(`Cannot find index.html in ${root}. Build the app first (npm run build) or pass the app folder.`);
  process.exit(1);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.wav': 'audio/wav',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const server = createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', `http://${HOST}`).pathname);
  } catch {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }
  let file = resolve(join(root, pathname));
  // Never serve anything outside the app directory.
  if (file !== root && !file.startsWith(root + sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  let st;
  try {
    st = statSync(file);
    if (st.isDirectory()) {
      file = join(file, 'index.html');
      st = statSync(file);
    }
  } catch {
    // Single-page app fallback for navigations; real 404 for assets.
    if (!extname(pathname)) {
      file = join(root, 'index.html');
      st = statSync(file);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
  }
  const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
  const headers = {
    'Content-Type': type,
    'Content-Length': st.size,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': file.endsWith('index.html') || file.endsWith('sw.js') ? 'no-cache' : 'public, max-age=3600',
  };
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Is SWITCHBOARD already running? Try http://${HOST}:${port}/ or pass --port 4180.`);
  } else console.error(err);
  process.exit(1);
});

server.listen(port, HOST, () => {
  const url = `http://${HOST}:${port}/`;
  console.log(`SWITCHBOARD / 01 is running at ${url}`);
  console.log(`Serving ${root} on loopback only. Press Ctrl+C to stop.`);
  if (openBrowser) {
    const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const cmdArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    try {
      spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true }).unref();
    } catch {
      /* opening the browser is a convenience */
    }
  }
});
