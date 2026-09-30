#!/usr/bin/env node
/**
 * Take review screenshots of a page with Playwright's Chromium.
 *
 *   node scripts/screenshot.mjs <url> <out.png> [options]
 *
 * Options
 *   --sizes 1366x768,1920x1080  Viewport sizes (default 1366x768). With more than one
 *                               size, "-<width>" is added before the extension unless the
 *                               output path contains "{w}" (and optionally "{h}").
 *   --full                      Capture the full scrollable page, not just the viewport.
 *   --zoom 2                    Emulate browser zoom (200%): CSS viewport = size / zoom,
 *                               device pixel ratio = zoom.
 *   --dpr 2                     Device pixel ratio without changing the CSS viewport.
 *   --wait 600                  Extra milliseconds to wait after load (fonts, animations).
 *   --hover "<css selector>"    Hover an element before capturing (e.g. to show a tooltip).
 *   --focus "<css selector>"    Keyboard-focus an element before capturing (Tab-style focus ring).
 *   --press "<key>"             Press a key after focusing/hovering (e.g. "Enter").
 *   --clip "<css selector>"     Capture only this element.
 *
 * The browser is Chromium from Playwright; set SB_CHROMIUM to use a specific binary.
 * Example (with the dev server running on port 5199):
 *   node scripts/screenshot.mjs http://127.0.0.1:5199/gallery.html docs/screenshots/gallery.png --full --sizes 1366x768,1920x1080
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, extname } from 'node:path';

function usage(msg) {
  if (msg) console.error(`screenshot: ${msg}`);
  console.error('usage: node scripts/screenshot.mjs <url> <out.png> [--sizes WxH,...] [--full] [--zoom N] [--dpr N] [--wait ms] [--hover sel] [--focus sel] [--press key] [--clip sel]');
  process.exit(2);
}

const args = process.argv.slice(2);
const positional = [];
const opts = { sizes: '1366x768', full: false, zoom: 1, dpr: 1, wait: 400, hover: null, focus: null, press: null, clip: null };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (!a.startsWith('--')) {
    positional.push(a);
    continue;
  }
  const key = a.slice(2);
  if (key === 'full') {
    opts.full = true;
    continue;
  }
  if (!(key in opts)) usage(`unknown option ${a}`);
  const v = args[++i];
  if (v === undefined) usage(`missing value for ${a}`);
  opts[key] = ['zoom', 'dpr', 'wait'].includes(key) ? Number(v) : v;
}
if (positional.length !== 2) usage('expected a URL and an output path');
const [url, out] = positional;

const sizes = String(opts.sizes)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const m = /^(\d+)x(\d+)$/.exec(s);
    if (!m) usage(`bad size "${s}" (expected WIDTHxHEIGHT)`);
    return { width: Number(m[1]), height: Number(m[2]) };
  });
if (!(opts.zoom > 0) || !(opts.dpr > 0)) usage('zoom and dpr must be positive numbers');

function outPath(size) {
  if (out.includes('{w}')) return out.replaceAll('{w}', String(size.width)).replaceAll('{h}', String(size.height));
  if (sizes.length === 1) return out;
  const ext = extname(out) || '.png';
  return `${out.slice(0, out.length - extname(out).length)}-${size.width}${ext}`;
}

const cloudChromium = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const executablePath = process.env.SB_CHROMIUM ?? (existsSync(cloudChromium) ? cloudChromium : undefined);

const browser = await chromium.launch({ executablePath });
let failed = false;
try {
  for (const size of sizes) {
    const viewport = { width: Math.round(size.width / opts.zoom), height: Math.round(size.height / opts.zoom) };
    const context = await browser.newContext({ viewport, deviceScaleFactor: opts.zoom * opts.dpr, reducedMotion: 'no-preference' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts?.ready);
    if (opts.focus) {
      // Focus via the keyboard so :focus-visible applies: focus the body, then Tab until we land on it.
      const target = page.locator(opts.focus).first();
      await target.evaluate((el) => {
        el.setAttribute('data-screenshot-target', '1');
      });
      await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
      let reached = false;
      for (let i = 0; i < 400 && !reached; i++) {
        await page.keyboard.press('Tab');
        reached = await page.evaluate(() => document.activeElement?.getAttribute('data-screenshot-target') === '1');
      }
      if (!reached) await target.focus();
    }
    if (opts.hover) await page.locator(opts.hover).first().hover();
    if (opts.press) await page.keyboard.press(opts.press);
    await page.waitForTimeout(opts.wait);
    const path = outPath(size);
    mkdirSync(dirname(path), { recursive: true });
    if (opts.clip) await page.locator(opts.clip).first().screenshot({ path });
    else await page.screenshot({ path, fullPage: opts.full });
    console.log(`saved ${path} (${size.width}x${size.height}${opts.zoom !== 1 ? ` @ ${opts.zoom * 100}% zoom` : ''})`);
    if (errors.length) {
      failed = true;
      console.error(`page errors at ${size.width}x${size.height}:\n  ${errors.join('\n  ')}`);
    }
    await context.close();
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
