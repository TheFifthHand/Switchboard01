// Captures evidence from the running production build of Omni Song:
//   docs/screenshots/*.png  — the real instrument at 1366x768, 1920x1080 and 200 % zoom
//   evidence/wav/*.wav       — short WAV renders (same engine as export)
// Usage: node scripts/evidence.mjs [baseUrl]   (default http://127.0.0.1:4173/)
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';

const base = process.argv[2] ?? 'http://127.0.0.1:4173/';
const exe = process.env.SB_CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
mkdirSync('docs/screenshots', { recursive: true });
mkdirSync('evidence/wav', { recursive: true });

const browser = await chromium.launch({ executablePath: existsSync(exe) ? exe : undefined });

async function fresh(viewport, scale = 1) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: scale });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base);
  await page.getByRole('button', { name: 'Jump In' }).waitFor();
  return { ctx, page, errors };
}

async function jumpIn(page) {
  await page.getByRole('button', { name: 'Jump In' }).click();
  await page.waitForFunction(() => window.__switchboard?.runtime.getState().playing === true);
  await page.waitForTimeout(2500);
  // Skip the optional guide if it appears. (The "Try this" hint that follows stays: it is part of the app.)
  const skip = page.getByRole('button', { name: /Skip/ });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await page.waitForTimeout(300);
}

/** Shape opens in Simple mode; its "Show every setting" switches to Advanced (cables, every knob). */
async function showEverySetting(page) {
  const more = page.getByRole('button', { name: 'Show every setting' });
  if (await more.isVisible().catch(() => false)) await more.click();
  await page.waitForTimeout(400);
}

async function shot(page, name) {
  await page.screenshot({ path: `docs/screenshots/${name}.png` });
  console.log('screenshot', name);
}

async function tab(page, name) {
  const t = page.getByRole('tab', { name, exact: true });
  if (await t.count()) await t.first().click();
  await page.waitForTimeout(400);
}

// 1366 x 768: the whole journey.
{
  const { ctx, page, errors } = await fresh({ width: 1366, height: 768 });
  await shot(page, '01-welcome-1366');
  await jumpIn(page);
  await shot(page, '02-play-loops-1366');
  await page.getByRole('button', { name: /^Bass, Lift: / }).click();
  await page.waitForTimeout(150);
  await shot(page, '03-play-queued-1366');
  await page.waitForTimeout(2500);
  for (const mode of ['Drums', 'Notes', 'Steps']) {
    // Part selectors live in the Loops column headers.
    if (mode !== 'Steps') {
      await tab(page, 'Loops');
      await page.getByRole('button', { name: mode === 'Drums' ? /^Select Drums/ : /^Select Chords/ }).click();
    }
    await tab(page, mode);
    await shot(page, `04-play-${mode.toLowerCase()}-1366`);
  }
  await tab(page, 'Loops');
  // The Mix view (Simple): a channel strip per part, the master and mastering; then a mastering preset.
  await tab(page, 'Mix');
  await shot(page, '17-mix-1366');
  await page.getByRole('button', { name: 'Warm', exact: true }).click().catch(() => {});
  await page.waitForTimeout(600);
  await shot(page, '18-mix-mastering-warm-1366');
  // The Simple Shape view: the six macros, the instrument card and the effects as cards.
  await tab(page, 'Shape');
  await shot(page, '16-shape-simple-1366');
  // From here on Advanced (remembered): every setting, the cable dock and the Play view's cables drawer.
  await showEverySetting(page);
  await shot(page, '05-shape-cables-1366');
  await tab(page, 'Arrange');
  await shot(page, '06-arrange-1366');
  await tab(page, 'Play');
  // The cable panel, opened from the Play view's drawer.
  await page.getByRole('region', { name: 'Cables drawer' }).getByRole('button', { expanded: false }).click();
  await page.waitForTimeout(400);
  await shot(page, '07-play-cables-drawer-1366');
  await page.getByRole('button', { name: 'Hide cables' }).click();
  // Shape with its cable dock open, then the sampler part's editor.
  await tab(page, 'Shape');
  await page.getByRole('button', { name: 'Show cables' }).click();
  await page.waitForTimeout(400);
  await shot(page, '08-shape-cable-panel-1366');
  await page.getByRole('radio', { name: /^8 / }).click();
  await page.waitForTimeout(400);
  await shot(page, '09-shape-sampler-1366');
  await tab(page, 'Play');
  // The sound browser and the project library.
  await page.getByRole('button', { name: /^Change instrument/ }).click();
  await page.waitForTimeout(400);
  await shot(page, '13-sound-browser-1366');
  await page.keyboard.press('Escape');
  // At 1366 px Projects sits in the transport's More menu (it joins the strip from 1440 px).
  const projects = page.getByRole('button', { name: /^Projects \(open:/ });
  if (await projects.isVisible().catch(() => false)) await projects.click();
  else {
    await page.getByRole('button', { name: /^More:/ }).click();
    await page.getByRole('menuitem', { name: /^Projects/ }).click();
  }
  await page.waitForTimeout(400);
  await shot(page, '14-project-library-1366');
  await page.keyboard.press('Escape');
  if (errors.length) console.log('page errors:', errors);
  await ctx.close();
}

// 1920 x 1080.
{
  const { ctx, page } = await fresh({ width: 1920, height: 1080 });
  await jumpIn(page);
  await shot(page, '10-play-1920');
  await tab(page, 'Steps');
  await shot(page, '11-steps-1920');
  await tab(page, 'Shape');
  await shot(page, '12-shape-1920');
  await showEverySetting(page);
  await page.getByRole('button', { name: 'Show cables' }).click();
  await page.waitForTimeout(400);
  await shot(page, '15-shape-cable-panel-1920');
  await ctx.close();
}

// 200 % browser zoom on a 1920 x 1080 display (960 x 540 CSS pixels at 2x).
{
  const { ctx, page } = await fresh({ width: 960, height: 540 }, 2);
  await shot(page, '20-welcome-zoom200');
  await jumpIn(page);
  await shot(page, '21-play-zoom200');
  await ctx.close();
}

// WAV examples rendered by the app's own export path.
{
  const { ctx, page } = await fresh({ width: 1366, height: 768 });
  await page.getByRole('button', { name: 'Just look around' }).click();
  const examples = [
    { starter: 'house', file: 'house-groove-4bars', row: 1, bars: 4 },
    { starter: 'synthwave', file: 'synthwave-lift-4bars', row: 2, bars: 4 },
    { starter: 'ambient', file: 'ambient-groove-4bars', row: 1, bars: 4 },
    { starter: 'drumAndBass', file: 'drum-and-bass-groove-4bars', row: 1, bars: 4 },
  ];
  for (const ex of examples) {
    const b64 = await page.evaluate(async ({ starter, row, bars }) => {
      // The test hook keeps its first name: scripts and tests depend on it.
      const sb = window.__switchboard;
      await sb.session.newFromStarter(starter);
      const blob = await sb.session.renderWav({ source: { kind: 'scene', row, bars }, sampleRate: 44100, bitDepth: 16, tailSeconds: 1.5 });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s);
    }, ex);
    writeFileSync(`evidence/wav/${ex.file}.wav`, Buffer.from(b64, 'base64'));
    console.log('wav', ex.file);
  }
  await ctx.close();
}

await browser.close();
