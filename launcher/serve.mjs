#!/usr/bin/env node
// Omni Song — tiny local web server.
// Serves ONE directory (the built app) on the loopback interface only (127.0.0.1).
// Usage: node serve.mjs [directory] [--port 4173] [--strict-port] [--no-open]
// Stop with Ctrl+C (or close the window).
//
// The browser keeps projects (and the offline copy) per address, and the port
// is part of the address. So the launcher stays on one port: when Omni Song
// (or SWITCHBOARD / 01, its name before 2.0) already answers there it opens that
// copy and exits; when another program
// holds the port it explains what that means for saved projects, then uses the
// next free port (or stops, with --strict-port).
import { createServer, get } from 'node:http';
import { createReadStream, statSync, existsSync } from 'node:fs';
import { resolve, join, extname, sep } from 'node:path';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const dirArg = args.find((a, i) => !a.startsWith('--') && !(args[i - 1] ?? '').startsWith('--port'));
const root = resolve(dirArg ?? 'app');
const portIdx = args.indexOf('--port');
const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 4173;
const strictPort = args.includes('--strict-port');
const openBrowser = !args.includes('--no-open');
const HOST = '127.0.0.1';
/** Ports tried after the preferred one when another program holds it. */
const FALLBACK_PORTS = 19;
/** Only an Omni Song page has this (index.html's title). */
const MARKER = '<title>Omni Song</title>';
/** The same app before version 2.0, when it was called SWITCHBOARD / 01. Same address, same projects. */
const OLD_MARKER = '<title>SWITCHBOARD / 01</title>';

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('--port needs a whole number from 1 to 65535.');
  process.exit(1);
}
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

const addressOf = (p) => `http://${HOST}:${p}/`;

function handle(req, res) {
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
}

/** Listen on port p. Resolves null when the port is taken (or not allowed). */
function listen(p) {
  return new Promise((done, fail) => {
    const server = createServer(handle);
    server.once('error', (err) => (err.code === 'EADDRINUSE' || err.code === 'EACCES' ? done(null) : fail(err)));
    server.listen(p, HOST, () => done(server));
  });
}

/** Which copy of the app a page is: 'current', 'older' (SWITCHBOARD / 01) or null (something else). */
function appIn(body) {
  if (body.includes(MARKER)) return 'current';
  if (body.includes(OLD_MARKER)) return 'older';
  return null;
}

/**
 * Whether Omni Song (or its older self, SWITCHBOARD / 01) answers on port p: another
 * launcher window, or any server of the app. Resolves 'current', 'older' or null.
 * The Windows launcher answers one connection at a time and gives an idle browser
 * connection up to 3 s, so wait longer than that for the page.
 */
function appAt(p) {
  return new Promise((done) => {
    const req = get({ host: HOST, port: p, path: '/', agent: false, timeout: 6000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        const found = appIn(body);
        if (found) {
          done(found);
          req.destroy();
        } else if (body.length > 256 * 1024) {
          done(null);
          req.destroy();
        }
      });
      res.on('end', () => done(appIn(body)));
      res.on('error', () => done(null));
    });
    req.on('timeout', () => {
      done(null);
      req.destroy();
    });
    req.on('error', () => done(null));
  });
}

function openInBrowser(url) {
  const tell = () => console.log(`Open ${url} in your browser.`);
  if (!openBrowser) return;
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const cmdArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true });
    // A missing opener (no xdg-open on a minimal Linux, WSL, a container) is
    // reported asynchronously. Opening the browser is a convenience: keep serving.
    child.on('error', tell);
    child.unref();
  } catch {
    tell();
  }
}

function explainBusy(p) {
  const usual = addressOf(p);
  console.log('');
  console.log(`Port ${p} is used by another program, so Omni Song cannot open at its usual address ${usual}`);
  console.log('Your browser keeps projects separately for each address. Projects saved at');
  console.log(`${usual} will not appear in My projects at another address (they are not deleted),`);
  console.log('and projects saved at another address stay with that address.');
  console.log(`To use the usual address: close the program that uses port ${p} (or restart the computer),`);
  console.log('then start Omni Song again. To move a project between addresses, use');
  console.log('"Export this project" and "Import project file..." in the Project library.');
  console.log('');
}

async function main() {
  const last = Math.min(port + FALLBACK_PORTS, 65535);
  for (let p = port; p <= last; p++) {
    const server = await listen(p);
    if (server) {
      const url = addressOf(p);
      console.log(`Omni Song is running at ${url}${p !== port ? ` (not the usual ${addressOf(port)})` : ''}`);
      console.log(`Serving ${root} on loopback only. Press Ctrl+C to stop.`);
      openInBrowser(url);
      return;
    }
    const running = await appAt(p);
    if (running) {
      const url = addressOf(p);
      const where = `${url}${p !== port ? ` (not the usual ${addressOf(port)})` : ''}`;
      if (running === 'older') {
        console.log(`An older version of this app (SWITCHBOARD / 01) is already running at ${where}`);
        console.log('To use Omni Song instead, close the window that runs the older version, then start Omni Song again.');
        console.log('Both keep projects at the same address, so nothing is lost either way.');
      } else {
        console.log(`Omni Song is already running at ${where}`);
      }
      console.log(openBrowser ? 'Opening it in your browser; the window or program that started it keeps it running.' : `Open ${url} in your browser.`);
      console.log('To start a different copy (for example a newer version), stop the other one first.');
      openInBrowser(url);
      return;
    }
    if (p === port) {
      explainBusy(p);
      if (strictPort) {
        console.error(`Stopped: --strict-port keeps Omni Song on port ${p}.`);
        process.exitCode = 1;
        return;
      }
      console.log('Trying the next free port...');
    }
  }
  console.error(`No free port between ${port} and ${last}. Close other copies of Omni Song and try again.`);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
