/**
 * Round 7 fix 2a: the code review's and the third beginner test's findings,
 * in the running app with a real mouse (Simple mode).
 *
 * - A double-click on a loop never edits it: a single click opens the editor
 *   only once the double-click time has passed.
 * - The editor's Longer makes the song play the whole longer loop.
 * - Make it longer: repeat goes off and the playhead goes to what was added
 *   (playing it now, or on the next Play), said in plain words; Undo brings
 *   the repeat back. An intro or ending is offered only while there is none.
 *   Make it shorter takes a section out in one undo step.
 * - Stop goes back to the start of the song; Play plays from there.
 * - + Add instrument: heard (out of a repeat that leaves it out), unmuted,
 *   and refused while something records.
 * - A loop from LOOPS lands at its section's start (Alt: where dropped).
 * - The tip line: hear the whole song after Jump In, what next after Share,
 *   "What next?" with tips hidden, no step coming back after a sheet.
 * - Share offers no file of silence.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { session } from '../../src/app/instance';
import { patchRuntime } from '../../src/app/runtime';
import { songPlayheadBar } from '../../src/app/songPlayback';
import { CLICK_OPEN_MS, editorStore, loopEditorSoon, openLoopEditor } from '../../src/app/views/arrange/editorStore';
import { libraryQueryStore } from '../../src/app/views/arrange/library/LibraryPanel';
import { closeSound } from '../../src/app/views/arrange/sidePanelStore';
import { addInstrumentNow, removeSectionNow } from '../../src/app/views/arrange/songActions';
import { noteShared, resetTipMemory } from '../../src/app/views/arrange/tipMemory';
import { playSimple } from '../../src/app/views/shell/simplePlay';
import { regionEnd, sortSections } from '../../src/project/arrangement';
import { clipById } from '../../src/project/clips';
import * as cmd from '../../src/state/commands';
import { setTipsEnabled, setView } from '../../src/state/uiStore';
import { barX, centre, clickAt, dragTo, menuItem, on, openSong, project, region, regions, resetSong, rowY, rt, sections, setSong, settle, teardownSong, trackId, undoCount, waitFor } from './r5-song-helpers';

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const notice = () => rt().notice?.text ?? '';
const pane = () => document.querySelector<HTMLElement>('[data-loop-editor]');
const menuTexts = () => [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')].map((x) => (x.textContent ?? '').trim());
const button = (root: ParentNode, text: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text);

async function longerMenu(item?: string): Promise<void> {
  await clickAt(centre(byTestId('make-longer')!));
  if (item) {
    await clickAt(centre(menuItem(item)));
    await settle();
  }
}

/** "Make a beat from scratch" and two "+ Add instrument"s: Drums, Bass and Chords, 1 bar each at bar 1, no sections. */
function oneBarBeat(): void {
  const p = project();
  const one = (name: string, idx: number) => region(`r-${name}`, trackId(name), p.tracks[idx].clips.find(Boolean)!.id, 0, 1);
  setSong([one('Drums', 0), one('Bass', 2), one('Chords', 3)]);
}

const groove = () => sortSections(sections()).find((s) => s.name === 'Groove')!;

async function playRepeating(from: { start: number; bars: number }): Promise<void> {
  act(() => {
    session.setSongLoop({ fromBar: from.start, toBar: regionEnd(from) });
    session.setSongCursor(from.start);
  });
  await act(async () => {
    await session.playSong();
  });
  await waitFor(() => rt().playing, 'the song playing');
}

beforeEach(async () => {
  await resetSong('simple');
  resetTipMemory();
  act(() => closeSound());
});
afterEach(async () => {
  act(() => {
    closeSound();
    editorStore.setState(null);
    libraryQueryStore.setState(null);
    setTipsEnabled(false);
  });
  resetTipMemory();
  await teardownSong();
});

describe('a double-click never edits the loop (M1)', () => {
  it('a double-click on a lower row opens the editor on that loop and changes nothing', async () => {
    await openSong(1366, 768);
    const t = project().tracks[6];
    const r = regions().find((x) => x.trackId === t.id && x.start >= 8)!;
    const pt = centre(document.querySelector(`[data-region-id="${r.id}"]`)!);
    const before = undoCount();
    await clickAt(pt, 0, 1);
    await clickAt(pt, 0, 2);
    await settle(CLICK_OPEN_MS + 200);
    expect(editorStore.getState()?.regionId).toBe(r.id);
    expect(undoCount()).toBe(before);
  });

  it('a single click opens it once the double-click time has passed; a press that starts a drag meanwhile does not', async () => {
    await openSong(1366, 768);
    const r = regions().find((x) => x.trackId === project().tracks[2].id)!;
    await clickAt(on(r.id));
    expect(editorStore.getState()).toBeNull();
    expect(loopEditorSoon()).toBe(r.id);
    await settle(CLICK_OPEN_MS + 100);
    expect(editorStore.getState()?.regionId).toBe(r.id);
    act(() => editorStore.setState(null));
    // Click, then at once a drag: the drag moves the loop, and no editor opens under it.
    const other = regions().find((x) => x.trackId === project().tracks[3].id)!;
    await clickAt(on(other.id));
    await dragTo(on(other.id), { x: on(other.id).x + 2 * (barX(1) - barX(0)), y: on(other.id).y }, { ms: 120 });
    await settle(CLICK_OPEN_MS + 100);
    expect(editorStore.getState()).toBeNull();
  });
});

describe('the editor’s Longer (M2)', () => {
  it('Make a beat → Longer: the song plays both halves, in one undo step', async () => {
    await openSong(1366, 768);
    const beat = await act(async () => session.beatFromScratch());
    expect(beat).not.toBeNull();
    act(() => {
      openLoopEditor(project(), beat!.regionId!);
    });
    await settle();
    const before = undoCount();
    await clickAt(centre(button(pane()!, 'Longer')!));
    const r = regions().find((x) => x.id === beat!.regionId)!;
    const clip = clipById(project().tracks.find((t) => t.id === r.trackId)!, r.clipId)!;
    expect(clip.bars).toBe(2);
    // The second half is heard: the song plays the whole longer loop there.
    expect(r.bars).toBe(2);
    expect(undoCount()).toBe(before + 1);
    act(() => session.undo());
    expect(regions().find((x) => x.id === beat!.regionId)!.bars).toBe(1);
  });
});

describe('Make it longer while a section repeats (M3, rule c)', () => {
  it('playing Groove on repeat, Add an ending: repeat goes off, the ending plays now, and Undo brings the repeat back', async () => {
    await openSong(1366, 768);
    const g = groove();
    await playRepeating(g);
    await longerMenu();
    // House has an intro already: only an ending is offered.
    expect(menuTexts()).not.toContain('Add an intro');
    expect(menuTexts()).toContain('Add an ending');
    await clickAt(centre(menuItem('Add an ending')));
    await settle(300);
    const ending = sortSections(sections()).at(-1)!;
    expect(ending.name).toBe('Ending');
    expect(rt().songLoop).toBeNull();
    expect(notice()).toMatch(/^Added Ending at the end: .+\. Repeat is off: playing it now\.$/);
    expect(songPlayheadBar()!).toBeGreaterThanOrEqual(ending.start);
    expect(byTestId('repeat-part')!.getAttribute('aria-pressed')).toBe('false');
    // No second ending.
    await longerMenu();
    expect(menuTexts()).not.toContain('Add an ending');
    await clickAt(centre(byTestId('make-longer')!));
    act(() => session.undo());
    await settle();
    expect(rt().songLoop).toEqual({ fromBar: g.start, toBar: regionEnd(g) });
  });

  it('stopped: the playhead goes to what was added, and Play plays it', async () => {
    await openSong(1366, 768);
    oneBarBeat();
    act(() => session.setSongLoop({ fromBar: 0, toBar: 1 }));
    await longerMenu('Add an intro');
    expect(rt().songLoop).toBeNull();
    expect(notice()).toMatch(/Repeat is off: press Play to hear it\.$/);
    expect(rt().songCursor).toBe(0);
    await longerMenu('Repeat Verse again');
    const verses = sortSections(sections()).filter((s) => s.name === 'Verse');
    expect(verses).toHaveLength(2);
    expect(rt().songCursor).toBe(verses[1].start);
    expect(notice()).toMatch(/^Verse now plays twice in a row\. Press Play to hear it\.$/);
    await longerMenu('Repeat Verse again');
    expect(notice()).toMatch(/^Verse now plays 3 times in a row\./);
    // The new Verse (the copy goes right after the one it repeats) is where Play starts.
    const at = rt().songCursor;
    expect(at).toBeGreaterThan(verses[0].start);
    await act(async () => {
      await playSimple();
    });
    await waitFor(() => rt().playing, 'the song playing');
    expect(Math.floor(songPlayheadBar()!)).toBeGreaterThanOrEqual(at);
  });
});

describe('Make it shorter (rule e)', () => {
  it('takes out the last section, or the one where the song is, in one undo step each; never the only one', async () => {
    await openSong(1366, 768);
    const sorted = sortSections(sections());
    const n = sorted.length;
    act(() => session.setSongCursor(sorted[2].start));
    await settle();
    await longerMenu();
    expect(menuTexts()).toContain(`Remove the last section (${sorted[n - 1].name})`);
    expect(menuTexts()).toContain(`Remove ${sorted[2].name} (where the song is now)`);
    const before = undoCount();
    await clickAt(centre(menuItem('Remove the last section')));
    await settle();
    expect(sections()).toHaveLength(n - 1);
    expect(undoCount()).toBe(before + 1);
    expect(notice()).toMatch(/^Took Groove out: your song is \d:\d\d now\.$/);
    act(() => session.undo());
    expect(sections()).toHaveLength(n);
    // One section left: nothing to take out.
    setSong(regions(), [sorted[0]]);
    await longerMenu();
    const item = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')].find((x) => /Remove the last section/.test(x.textContent ?? ''))!;
    expect(item.getAttribute('aria-disabled')).toBe('true');
  });
});

describe('Stop and Play (rule d)', () => {
  it('Stop goes back to the start of the song; Play plays from there into the part that repeats', async () => {
    await openSong(1366, 768);
    const g = groove();
    await playRepeating(g);
    act(() => session.stop());
    expect(rt().songCursor).toBe(0);
    await act(async () => {
      await playSimple();
    });
    await waitFor(() => rt().playing, 'the song playing');
    expect(Math.floor(songPlayheadBar()!)).toBeLessThan(g.start);
    expect(rt().songLoop).toEqual({ fromBar: g.start, toBar: regionEnd(g) });
  });
});

describe('repeat and Undo (minor 1)', () => {
  it('a section deleted with its music turns repeat off; Undo brings both back', async () => {
    await openSong(1366, 768);
    const s = sortSections(sections())[2];
    act(() => session.setSongLoop({ fromBar: s.start, toBar: regionEnd(s) }));
    act(() => {
      removeSectionNow(s.id, true);
    });
    await settle();
    expect(rt().songLoop).toBeNull();
    act(() => session.undo());
    await settle();
    expect(rt().songLoop).toEqual({ fromBar: s.start, toBar: regionEnd(s) });
  });
});

describe('+ Add instrument (M3, minor 7, minor 8, rule h)', () => {
  /** House with the Melody row hidden (no music on it). */
  function noMelody(): string {
    const lead = project().tracks.find((t) => t.role === 'lead')!.id;
    setSong(
      regions().filter((r) => r.trackId !== lead),
      sections(),
    );
    return lead;
  }

  it('a muted instrument is unmuted when it is added, in the same undo step, and said', async () => {
    await openSong(1366, 768);
    const lead = noMelody();
    act(() => {
      cmd.setMute(session.store, lead, true);
    });
    const before = undoCount();
    await clickAt(centre(byTestId('add-instrument')!));
    await clickAt(centre(menuItem('Melody')));
    await settle();
    expect(project().tracks.find((t) => t.id === lead)!.mute).toBe(false);
    expect(notice()).toMatch(/It was muted: now it is heard\./);
    expect(undoCount()).toBe(before + 1);
    act(() => session.undo());
    expect(project().tracks.find((t) => t.id === lead)!.mute).toBe(true);
    expect(regions().some((r) => r.trackId === lead)).toBe(false);
  });

  it('while another instrument plays alone it says why it is not heard', async () => {
    await openSong(1366, 768);
    const lead = noMelody();
    act(() => {
      cmd.setSolo(session.store, trackId('Drums'), true);
    });
    act(() => {
      addInstrumentNow(lead, 0);
    });
    expect(notice()).toMatch(/You will not hear it while Drums plays alone/);
  });

  it('out of a repeat that leaves it out: repeat goes off and it plays', async () => {
    await openSong(1366, 768);
    const lead = noMelody();
    const intro = sortSections(sections())[0];
    act(() => session.setSongLoop({ fromBar: intro.start, toBar: regionEnd(intro) }));
    await act(async () => {
      addInstrumentNow(lead, 0);
      await new Promise((r) => setTimeout(r, 50));
    });
    await waitFor(() => rt().playing, 'the song playing');
    const added = regions().find((r) => r.trackId === lead)!;
    expect(added.start).toBeGreaterThanOrEqual(regionEnd(intro));
    expect(rt().songLoop).toBeNull();
    expect(notice()).toMatch(/Repeat is off, so you hear it\./);
    expect(Math.floor(songPlayheadBar()!)).toBeGreaterThanOrEqual(added.start);
  });

  it('is refused while something records', async () => {
    await openSong(1366, 768);
    const lead = noMelody();
    act(() => patchRuntime({ recording: 'notes' }));
    let r: unknown = undefined;
    act(() => {
      r = addInstrumentNow(lead, 0);
    });
    expect(r).toBeNull();
    expect(notice()).toBe('Stop recording first, then add an instrument.');
    expect(regions().some((x) => x.trackId === lead)).toBe(false);
  });
});

describe('a loop from LOOPS lands at its section’s start (rule f)', () => {
  it('dropped in the middle of a section: at its start; with Alt: where dropped', async () => {
    await openSong(1366, 768);
    act(() => libraryQueryStore.setState({ text: 'Root Pulse', role: 'bass', genre: null }));
    await waitFor(() => !!document.querySelector('[data-library-loop="loop-bass-root-pulse"]'), 'the library row');
    const lift = sortSections(sections()).find((s) => s.name === 'Lift')!;
    const bass = trackId('Bass');
    const drop = async (modifiers: number) => {
      const row = document.querySelector<HTMLElement>('[data-library-loop="loop-bass-root-pulse"]')!;
      row.scrollIntoView({ block: 'nearest' });
      const ids = new Set(regions().map((r) => r.id));
      await dragTo(centre(row, 0.6), { x: barX(lift.start + 5) + 4, y: rowY(bass) }, { modifiers });
      await settle();
      return regions().find((r) => !ids.has(r.id) && r.trackId === bass)!;
    };
    expect((await drop(0)).start).toBe(lift.start);
    act(() => session.undo());
    expect((await drop(1)).start).toBe(lift.start + 5);
  });
});

describe('the tip line (rules d and g, minor 12)', () => {
  it('after Jump In: how to hear the whole song, until repeat goes off', async () => {
    await openSong(1366, 768);
    act(() => setTipsEnabled(true));
    const g = groove();
    act(() => session.setSongLoop({ fromBar: g.start, toBar: regionEnd(g) }));
    await settle();
    expect(byTestId('song-tip')!.dataset.step).toBe('whole');
    expect(byTestId('song-tip')!.textContent).toContain('To hear your whole song, press ⟳ Repeating: Groove');
    await clickAt(centre(byTestId('repeat-part')!));
    await settle();
    expect(byTestId('song-tip')!.dataset.step).toBe('try');
    // Repeating again later: the step is done.
    act(() => session.setSongLoop({ fromBar: g.start, toBar: regionEnd(g) }));
    await settle();
    expect(byTestId('song-tip')!.dataset.step).toBe('try');
  });

  it('a loop opened stays opened after a sheet (the ready-made song’s first step does not come back)', async () => {
    await openSong(1366, 768);
    act(() => setTipsEnabled(true));
    await settle();
    expect(byTestId('song-tip')!.dataset.step).toBe('try');
    act(() => {
      openLoopEditor(project(), regions()[0].id);
    });
    await settle();
    act(() => editorStore.setState(null));
    act(() => setView('mix'));
    await settle();
    act(() => setView('arrange'));
    await settle();
    expect(byTestId('song-tip')!.dataset.step).not.toBe('try');
  });

  it('after Share it goes on to ideas (Another idea); with tips hidden, What next? says one', async () => {
    await openSong(1366, 768);
    act(() => setTipsEnabled(true));
    act(() => {
      openLoopEditor(project(), regions()[0].id);
    });
    act(() => editorStore.setState(null));
    await settle();
    expect(byTestId('song-tip')!.dataset.step).toBe('share');
    act(() => noteShared(project().id));
    await settle();
    expect(byTestId('song-tip')!.dataset.step).toBe('next');
    const first = byTestId('song-tip')!.textContent;
    await clickAt(centre(byTestId('another-idea')!));
    expect(byTestId('song-tip')!.textContent).not.toBe(first);
    await clickAt(centre(byTestId('hide-tips')!));
    expect(byTestId('song-tip')).toBeNull();
    await clickAt(centre(byTestId('what-next')!));
    expect(notice()).toMatch(/^Next: .+\.$/);
  });
});

describe('Share (minor 9)', () => {
  it('a song of empty loops offers no file of silence', async () => {
    await openSong(1366, 768);
    setSong([]);
    act(() => {
      cmd.addLoopToSong(session.store, trackId('Drums'), 0, { bars: 1 });
    });
    await settle();
    const share = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Share')!;
    await clickAt(centre(share));
    await settle();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.querySelector('[data-testid="share-empty"]')?.textContent).toContain('Your song makes no sound yet — add sounds to your loop first.');
    const save = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((b) => /Save to my computer/.test(b.textContent ?? ''));
    expect(!save || save.disabled || save.getAttribute('aria-disabled') === 'true').toBe(true);
  });
});
