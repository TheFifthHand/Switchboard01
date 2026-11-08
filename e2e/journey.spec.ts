/**
 * The beginner's first song (EASY_SPEC, Simple: the one song screen), in a
 * fresh browser profile against the production build: Make a beat from
 * scratch → click squares and hear them → + Add instrument (Bass) → Make it
 * longer (Repeat, then a new section) → Share a music file, then check the WAV itself. Share never changes
 * the project; Stop goes back to the start of the song.
 * (2.4's pads journey — Jump In → pads → Tone/Space → keys → a take → Export —
 * is Advanced now: advanced.spec.ts.)
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { masterPeakOver, openFresh, pageErrors, parseWavHeader, wavStats16 } from './helpers';

const CEILING = 0.8912509381337456; // -1 dBFS

const rt = (page: Page) => page.evaluate(() => (window as any).__switchboard.runtime.getState());
/** The bar under the song's playhead while it plays (0-based), or -1. */
const liveBar = (page: Page) =>
  page.evaluate(() => {
    const sb = (window as any).__switchboard.session;
    return (sb.sequencer?.songBarAt(sb.transport.getPosition().tick) ?? -1) as number;
  });
/** The hits in the Drums loop the editor is open on. */
const drumHits = (page: Page) =>
  page.evaluate(() => {
    const p = (window as any).__switchboard.project();
    const drums = p.tracks.find((t: any) => t.instrument.kind === 'drums');
    const region = p.arrangement.regions.find((r: any) => r.trackId === drums.id);
    // A song-only loop lives in songClips (Simple's Make a beat), a pad loop in clips.
    const clip = [...drums.clips, ...(drums.songClips ?? [])].find((c: any) => c && c.id === region.clipId);
    return clip.notes.length as number;
  });
/** What the song is made of (Share must leave all of it as it was). */
const songState = (page: Page) =>
  page.evaluate(() => {
    const p = (window as any).__switchboard.project();
    return JSON.stringify({ name: p.name, bpm: p.bpm, tracks: p.tracks, arrangement: p.arrangement, mastering: p.mastering, master: p.master });
  });

test('Make a beat → add an instrument → make it longer → Share a WAV', async ({ page }) => {
  await openFresh(page);
  await expect(page.getByText('Start with a beat. Make it yours.')).toBeVisible();

  // 1. Make a beat from scratch: the song screen, a Drums loop playing on repeat, the editor open on Draw.
  await page.getByRole('button', { name: 'Make a beat from scratch' }).click();
  await expect.poll(async () => (await rt(page)).playing, { timeout: 10_000 }).toBe(true);
  expect(await page.evaluate(() => (window as any).__switchboard.audioState())).toBe('running');
  // One home: no view tabs in Simple.
  await expect(page.locator('header[aria-label="Transport"] [role="tab"]')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Your song', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Repeating: the whole song' })).toHaveAttribute('aria-pressed', 'true');
  const editor = page.getByRole('region', { name: /^Editor: / });
  await expect(editor).toBeVisible();
  await expect(editor.getByRole('radio', { name: 'Draw' })).toBeChecked();
  const tip = page.locator('[role="status"]', { hasText: 'Next:' });
  await expect(tip).toContainText('Click squares in the grid below');
  // The loop is empty: nothing is heard yet (the level is real, not a show).
  expect((await masterPeakOver(page, 800)).peak).toBeLessThan(1e-3);

  // 2. Click squares: a kick on every beat and a snare on 2 and 4, heard at once (the loop repeats).
  for (const step of [1, 5, 9, 13]) await editor.getByRole('button', { name: `Kick, step ${step}`, exact: true }).click();
  for (const step of [5, 13]) await editor.getByRole('button', { name: `Snare, step ${step}`, exact: true }).click();
  await expect.poll(() => drumHits(page)).toBe(6);
  const beat = await masterPeakOver(page, 2500);
  expect(beat.rms).toBeGreaterThan(0.005);
  expect(beat.peak).toBeLessThanOrEqual(CEILING + 1e-3);
  await expect(tip).toContainText('Add a bass');

  // 3. + Add instrument → Bass: its row shows with a loop, and it is heard with the beat.
  await page.getByTestId('add-instrument').click();
  await page.getByRole('menu', { name: 'Add an instrument' }).getByRole('menuitem', { name: 'Bass', exact: true }).click();
  await expect(page.getByText(/^Added Bass: it plays “/)).toBeVisible();
  const bassRow = page.getByRole('group', { name: /^Bass: 1 loop/ });
  await expect(bassRow).toBeVisible();
  const bassId = await page.evaluate(() => (window as any).__switchboard.project().tracks.find((t: any) => t.role === 'bass' || t.name === 'Bass').id);
  expect(await page.evaluate((id) => (window as any).__switchboard.project().arrangement.regions.some((r: any) => r.trackId === id), bassId)).toBe(true);
  // Hear it alone: the bass sounds on its own (Solo off again afterwards).
  await page.getByRole('button', { name: 'Solo Bass', exact: true }).click();
  expect((await masterPeakOver(page, 2500)).rms).toBeGreaterThan(0.003);
  await page.getByRole('button', { name: 'Solo Bass', exact: true }).click();

  // 4. Make it longer. A one-bar beat is first made into a Verse (its loops filled out to a whole section)
  //    and played twice; then a new, differently named section follows, made from the song's own music.
  //    Each is one Undo step.
  const length = page.getByTestId('song-length');
  await expect(length).toHaveText('· 0:02');
  await page.getByTestId('make-longer').click();
  await page.getByRole('menuitem', { name: /^Repeat .* again$/ }).click();
  await expect(page.getByText(/^Verse now plays twice in a row\./)).toBeVisible();
  await expect(length).toHaveText('· 0:32');
  await page.getByTestId('make-longer').click();
  await page.getByRole('menuitem', { name: 'Add a section after Verse' }).click();
  await expect(length).toHaveText('· 0:48');
  const sections = await page.evaluate(() => (window as any).__switchboard.project().arrangement.sections.map((s: any) => s.name as string));
  expect(sections.slice(0, 2)).toEqual(['Verse', 'Verse']);
  expect(sections).toHaveLength(3);
  expect(sections[2]).not.toBe('Verse');
  // Every instrument plays in the new section (it repeats the song's music).
  const inLast = await page.evaluate(() => {
    const p = (window as any).__switchboard.project();
    const last = [...p.arrangement.sections].sort((a: any, b: any) => a.start - b.start).pop();
    return new Set(p.arrangement.regions.filter((r: any) => r.start >= last.start && r.start < last.start + last.bars).map((r: any) => r.trackId)).size;
  });
  expect(inLast).toBe(2);
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  await expect(length).toHaveText('· 0:32');
  await page.getByRole('button', { name: 'Redo', exact: true }).first().click();
  await expect(length).toHaveText('· 0:48');

  // 5. Share → a music file (the default): a WAV that works everywhere, as loud as streaming songs.
  const before = await songState(page);
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const share = page.getByRole('dialog', { name: 'Share your song' });
  await expect(share).toBeVisible();
  await expect(share.getByRole('radio', { name: /^A music file to send/ })).toBeChecked();
  await expect(share.getByText('The whole song · 0:48')).toBeVisible();
  await expect(share.getByRole('switch', { name: 'As loud as streaming songs' })).toBeChecked();
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), share.getByRole('button', { name: 'Save to my computer' }).click()]);
  expect(download.suggestedFilename()).toBe('My beat.wav');
  await expect(share.getByText('Saved “My beat.wav” — as loud as streaming songs. Find it in your Downloads.')).toBeVisible({ timeout: 30_000 });

  // The file: 16-bit stereo WAV at 44.1 kHz, the song plus its tail, with the beat in it, under the ceiling.
  const wav = readFileSync(await download.path());
  const h = parseWavHeader(wav);
  expect(h).toMatchObject({ channels: 2, sampleRate: 44100, bitDepth: 16 });
  const expected = await page.evaluate(() => {
    const sb = (window as any).__switchboard;
    return sb.session.renderPlan({ kind: 'song' }, sb.project().arrangement.tailSeconds).totalSeconds as number;
  });
  expect(Math.abs(h.frames / h.sampleRate - expected)).toBeLessThan(0.01);
  const stats = wavStats16(wav, h.dataOffset, h.frames, h.channels);
  expect(stats.finite).toBe(true);
  expect(stats.rms).toBeGreaterThan(0.01);
  expect(stats.peak).toBeLessThanOrEqual(CEILING + 1 / 32768);

  // Share changed only the file: the song, its sound and its undo history are as they were.
  expect(await songState(page)).toBe(before);
  await share.getByRole('button', { name: 'Close' }).click();
  await expect(share).toBeHidden();
  await expect(page.getByText(/^Saved “My beat\.wav”/)).toBeVisible();

  // 6. Play plays the song (on from where it is); Stop goes back to its start.
  // (The song may have played to its end while the file was made.)
  if (!(await rt(page)).playing) await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(async () => (await rt(page)).playing).toBe(true);
  expect((await rt(page)).mode).toBe('song');
  await expect.poll(() => liveBar(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  // Pause keeps the place; Stop goes back to the start, so the next Play starts the song again.
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect.poll(async () => (await rt(page)).paused).toBe(true);
  expect(await liveBar(page)).toBeGreaterThanOrEqual(2);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect.poll(async () => (await rt(page)).paused).toBe(false);
  expect((await rt(page)).songCursor).toBe(0);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(async () => (await rt(page)).playing).toBe(true);
  expect(await liveBar(page)).toBeLessThan(2);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect.poll(async () => (await rt(page)).playing).toBe(false);

  expect(pageErrors(page)).toEqual([]);
});

test('Jump In lands on the song screen, playing, even when a sheet was left open last time', async ({ page }) => {
  // A returning user who last left the app on the Mixer sheet.
  await page.addInitScript(() => {
    if (!localStorage.getItem('switchboard01.ui')) localStorage.setItem('switchboard01.ui', JSON.stringify({ view: 'mix', padMode: 'steps' }));
  });
  await openFresh(page);
  await page.getByRole('button', { name: 'Jump In' }).click();
  await expect.poll(async () => (await rt(page)).playing, { timeout: 10_000 }).toBe(true);
  // The song screen, playing the starter's main part on repeat, at a comfortable level.
  await expect(page.getByRole('heading', { name: 'Your song', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back to my song' })).toHaveCount(0);
  await expect(page.locator('header[aria-label="Transport"] [role="tab"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Repeating: / })).toHaveAttribute('aria-pressed', 'true');
  expect((await rt(page)).mode).toBe('song');
  const level = await masterPeakOver(page, 2000);
  expect(level.rms).toBeGreaterThan(0.01);
  expect(level.peak).toBeLessThanOrEqual(CEILING + 1e-3);
  expect(pageErrors(page)).toEqual([]);
});
