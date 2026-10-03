/**
 * Sound browser: any part can become any instrument. Sounds are grouped in
 * categories (Drums & Percussion, Bass, Keys, Pads & Strings, Leads, Plucks
 * & Bells, Textures & FX, Recordings) with icons and counts; a search finds
 * sounds across every category by name, tag, category or description.
 *
 * Browsing is safe (shape-07): when the dialog opens it keeps the part's
 * sound as it is (snapshotTrackSound: instrument, big knobs and their maps,
 * its effects' settings), and every choice made while it is open is one undo
 * step (an undo group). Choosing a sound applies it at once and keeps the
 * dialog open so sounds can be compared. Done, × and Escape keep the current
 * choice; "Cancel (back to House Stab as you had it)" puts the snapshot back
 * (restoreTrackSound), and leaves no undo step, so Undo still undoes what
 * came before. An import from Recordings is its own step (with its own
 * Undo): the browse so far is kept, and Cancel then goes back to the sound
 * as it was after the import.
 *
 * Preview plays a short example on the part with its *current* sound as a
 * session 'preview' note (drums: kick, snare and hat together; bass: the
 * key's root; poly: a triad in the project key; sampler: the recording at
 * its original pitch). Previews play the exact pitch, bypass the
 * arpeggiator and Musical Assist and are never recorded.
 *
 * Keyboard: the category list is a vertical tab list (arrows, Home/End);
 * in the sound list arrows move by on-screen position, Enter or Space
 * chooses; in the search field ArrowDown jumps to the results and Escape
 * clears the search (a second Escape closes the dialog, keeping the choice).
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Button, Dialog, Icon, Notice, Switch, type IconName } from '../../ui/components';
import { ALL_SOUNDS, SOUND_CATEGORIES, categoryOfSound, kitInfo, soundCategoryInfo, soundMatchScore, type CatalogSound, type SoundCategory } from '../../content/catalog';
import { SCALES, keyLabel } from '../../music/scales';
import { IMPORT_LIMITS } from '../../persistence/audioImport';
import type { Id, Instrument, InstrumentKind, Project, SampleMeta } from '../../project/types';
import { changeInstrumentSound, restoreTrackSound, snapshotTrackSound, type TrackSound } from '../../state/commands';
import { shallowEqual, useStore } from '../../state/store';
import { session, useProject } from '../instance';
import { notify, runtimeStore, useRuntime } from '../runtime';
import { INSTRUMENT_LABEL, soundName } from '../labels';
import { ImportConfirm } from './sampler/ImportSampleButton';
import { chooseFileForPart, clearImportStatus, importStatusOf, importStore, type ImportStatus } from './sampler/importState';
import styles from './SoundBrowser.module.css';

type SoundEntry = Pick<CatalogSound, 'kind' | 'id' | 'name' | 'description' | 'category' | 'tags'>;

interface Section {
  id: string;
  heading: string;
  entries: SoundEntry[];
  /** Shown instead of cards when there are none. */
  empty?: string;
}

/** Icon of each category (always shown with its name). */
export const CATEGORY_ICON: Record<SoundCategory, IconName> = {
  drums: 'drum',
  bass: 'wave',
  keys: 'keys',
  pads: 'stereo',
  leads: 'sparkle',
  plucks: 'bell',
  textures: 'spectrum',
  recordings: 'mic',
};

export function soundIdOf(inst: Instrument): string {
  switch (inst.kind) {
    case 'drums':
      return inst.kitId;
    case 'bass':
    case 'poly':
      return inst.presetId;
    case 'sampler':
      return inst.sampleId ?? '';
  }
}

function importedEntries(samples: readonly SampleMeta[]): SoundEntry[] {
  return samples.map((s) => ({
    kind: 'sampler' as const,
    id: s.id,
    name: s.name,
    description: `Your recording: ${s.duration.toFixed(1)} s, ${s.channels === 1 ? 'mono' : 'stereo'}, plays at its original pitch.`,
    category: 'recordings' as const,
    tags: ['imported', 'recording', 'sample'],
  }));
}

/** Every sound the browser can offer: the built-in library plus this project's recordings. */
function allEntries(samples: readonly SampleMeta[]): SoundEntry[] {
  return [...ALL_SOUNDS, ...importedEntries(samples)];
}

const NOTHING_IMPORTED = 'Nothing imported yet. Import a WAV or MP3 below and it appears here for every part of this project.';

/** The sections of one category (drums split into kits and percussion; recordings into built-in and imported). */
export function categorySections(category: SoundCategory, samples: readonly SampleMeta[]): Section[] {
  if (category === 'drums') {
    const kits = ALL_SOUNDS.filter((s) => s.category === 'drums');
    const family = (s: SoundEntry) => kitInfo(s.id)?.family ?? 'kit';
    return [
      { id: 'drums:kit', heading: 'Drum kits', entries: kits.filter((s) => family(s) === 'kit') },
      { id: 'drums:percussion', heading: 'Percussion', entries: kits.filter((s) => family(s) === 'percussion') },
    ];
  }
  if (category === 'recordings') {
    return [
      { id: 'rec:builtin', heading: 'Built-in recordings', entries: ALL_SOUNDS.filter((s) => s.category === 'recordings') },
      { id: 'rec:imported', heading: 'Imported into this project', entries: importedEntries(samples), empty: NOTHING_IMPORTED },
    ];
  }
  const info = soundCategoryInfo(category);
  return [{ id: category, heading: info.name, entries: ALL_SOUNDS.filter((s) => s.category === category) }];
}

/** Search results across every category, best matches first within each category. */
export function searchSections(query: string, samples: readonly SampleMeta[], only?: SoundCategory): Section[] {
  const scored = allEntries(samples)
    .map((entry, order) => ({ entry, order, score: soundMatchScore(entry, query) }))
    .filter((x) => x.score > 0 && (!only || x.entry.category === only));
  return SOUND_CATEGORIES.flatMap((c) => {
    const hits = scored.filter((x) => x.entry.category === c.id).sort((a, b) => b.score - a.score || a.order - b.order);
    return hits.length ? [{ id: `search:${c.id}`, heading: c.name, entries: hits.map((h) => h.entry) }] : [];
  });
}

/** Number of sounds per category (for a query: matches per category). */
function categoryCounts(samples: readonly SampleMeta[], query: string): Record<SoundCategory, number> {
  const out = Object.fromEntries(SOUND_CATEGORIES.map((c) => [c.id, 0])) as Record<SoundCategory, number>;
  for (const e of allEntries(samples)) if (!query || soundMatchScore(e, query) > 0) out[e.category]++;
  return out;
}

/* ------------------------------------------------------------------ */
/* Preview                                                             */
/* ------------------------------------------------------------------ */

interface PreviewNote {
  pitch: number;
  velocity: number;
}

/** Root, third and fifth of the project key (a major triad in a chromatic key). */
function triadInKey(p: Project, base: number): number[] {
  const iv = SCALES[p.scale]?.intervals ?? [0, 2, 4, 5, 7, 9, 11];
  const third = p.scale === 'chromatic' ? 4 : iv.includes(3) && !iv.includes(4) ? 3 : iv.includes(4) ? 4 : 3;
  const root = base + p.root;
  return [root, root + third, root + 7];
}

export function previewNotesFor(p: Project, trackId: Id): { notes: PreviewNote[]; holdMs: number } {
  const t = p.tracks.find((x) => x.id === trackId);
  if (!t) return { notes: [], holdMs: 0 };
  const inst = t.instrument;
  switch (inst.kind) {
    case 'drums':
      // Kick, snare and closed hat (slots 0, 2, 4) struck together.
      return {
        notes: [
          { pitch: 0, velocity: 0.9 },
          { pitch: 2, velocity: 0.8 },
          { pitch: 4, velocity: 0.62 },
        ],
        holdMs: 400,
      };
    case 'bass':
      // A mono synth plays one note: the key's root in the bass octave.
      return { notes: [{ pitch: 36 + p.root, velocity: 0.85 }], holdMs: 900 };
    case 'poly':
      return { notes: triadInKey(p, 60).map((pitch) => ({ pitch, velocity: 0.78 })), holdMs: 1300 };
    case 'sampler':
      return inst.sampleId ? { notes: [{ pitch: Math.round(inst.params.rootNote ?? 60), velocity: 0.85 }], holdMs: 1500 } : { notes: [], holdMs: 0 };
  }
}

/** True while a recording would capture notes played on this part. */
export function isRecordingPart(s: { recording: string; recordTarget: { trackId: Id } | null }, trackId: Id): boolean {
  return s.recording === 'performance' || (s.recording === 'notes' && s.recordTarget?.trackId === trackId);
}

/** Plays and releases preview notes on a part; releases on stop/unmount so nothing hangs. */
function usePreview(trackId: Id) {
  const held = useRef<{ trackId: Id; pitches: number[]; timer: number } | null>(null);
  const alive = useRef(true);
  const stop = useCallback(() => {
    const h = held.current;
    if (!h) return;
    held.current = null;
    window.clearTimeout(h.timer);
    for (const pitch of h.pitches) session.noteOff(h.trackId, pitch, 'preview');
  }, []);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      stop();
    };
  }, [stop]);
  const play = useCallback(async () => {
    stop();
    // Previews are never recorded, but a take is focused playing: keep quiet while one runs on this part.
    if (isRecordingPart(runtimeStore.getState(), trackId)) return;
    // Must run inside the click: this is what may start browser audio.
    const ok = await session.startAudio();
    if (!ok || !alive.current) return;
    const { notes, holdMs } = previewNotesFor(session.store.getState(), trackId);
    if (notes.length === 0) {
      notify('This part has no recording to preview yet. Choose one from the list.', 'warn');
      return;
    }
    stop();
    for (const n of notes) session.noteOn(trackId, n.pitch, n.velocity, 'preview');
    held.current = { trackId, pitches: notes.map((n) => n.pitch), timer: window.setTimeout(stop, holdMs) };
  }, [trackId, stop]);
  return play;
}

/* ------------------------------------------------------------------ */
/* Keyboard navigation                                                 */
/* ------------------------------------------------------------------ */

/** Arrow keys move through the cards by their on-screen position. */
function neighbour(list: HTMLElement, from: HTMLElement, key: string): HTMLElement | null {
  const opts = Array.from(list.querySelectorAll<HTMLElement>('[role="option"]'));
  const i = opts.indexOf(from);
  if (key === 'Home') return opts[0] ?? null;
  if (key === 'End') return opts[opts.length - 1] ?? null;
  if (key === 'ArrowRight') return opts[i + 1] ?? null;
  if (key === 'ArrowLeft') return opts[i - 1] ?? null;
  const r = from.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const down = key === 'ArrowDown';
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const o of opts) {
    if (o === from) continue;
    const b = o.getBoundingClientRect();
    const dy = down ? b.top - r.bottom : r.top - b.bottom;
    if (dy < -1) continue;
    const score = dy * 4 + Math.abs(b.left + b.width / 2 - cx);
    if (score < bestScore) {
      bestScore = score;
      best = o;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Dialog                                                              */
/* ------------------------------------------------------------------ */

export interface SoundBrowserProps {
  open: boolean;
  trackId: Id;
  onClose(): void;
}

export function SoundBrowser({ open, trackId, onClose }: SoundBrowserProps) {
  if (!open) return null;
  return <SoundBrowserDialog trackId={trackId} onClose={onClose} />;
}

/** 'all' shows search matches from every category. */
type Scope = SoundCategory | 'all';

/** The undo step one browse makes ("Undo: Change sound"). */
const BROWSE_LABEL = 'track:Change sound';

interface BrowseState {
  /** The part's sound when browsing began. */
  snap: TrackSound | null;
  /** The project it belongs to (another project opened: Cancel has nothing to go back to). */
  projectId: Id;
  /** The choices are one undo group (not while a Record Notes pass, itself one group, is open). */
  grouped: boolean;
}

/**
 * One browse (shape-07): keeps the part's sound as it is and opens an undo
 * group, so every choice until it ends is one undo step. `end('keep')`
 * (Done, ×, Escape, the dialog going away) keeps the choice and says so with
 * Undo; `end('cancel')` first puts the kept sound back, which leaves no step
 * at all.
 *
 * An import is its own undo step (its message has its own Undo), so while a
 * file is being decoded and put on a part the browse pauses: the choices so
 * far are kept as a step, and browsing goes on afterwards from the sound as
 * the import left it (Cancel then goes back there). An import that changed
 * nothing (a file that would not decode) leaves Cancel where it was.
 */
function useBrowse(trackId: Id) {
  const state = useRef<BrowseState | null>(null);
  const nameOf = (p: Project, snap: TrackSound | null) => (snap ? soundName(p, snap.instrument) : '');
  const [baseName, setBaseName] = useState(() => {
    const p = session.store.getState();
    return nameOf(p, snapshotTrackSound(p, trackId));
  });
  const begin = useCallback(
    (keep?: BrowseState['snap']) => {
      if (state.current) return;
      const p = session.store.getState();
      const snap = keep ?? snapshotTrackSound(p, trackId);
      const grouped = runtimeStore.getState().recording !== 'notes';
      if (grouped) session.store.beginGroup(BROWSE_LABEL);
      state.current = { snap, projectId: p.id, grouped };
      setBaseName(nameOf(p, snap));
    },
    [trackId],
  );
  const end = useCallback(
    (how: 'keep' | 'cancel' | 'pause'): BrowseState | null => {
      const cur = state.current;
      if (!cur) return null;
      state.current = null;
      const p = session.store.getState();
      const t = p.tracks.find((x) => x.id === trackId);
      const was = nameOf(p, cur.snap);
      let missing = 0;
      if (how === 'cancel' && cur.snap && p.id === cur.projectId) {
        const r = restoreTrackSound(session.store, trackId, cur.snap);
        if (r.refused) notify(r.refused, 'warn');
        missing = r.missing ?? 0;
      }
      const step = cur.grouped ? session.store.endGroup().step : false;
      if (!t || p.id !== cur.projectId) return cur;
      const now = soundName(session.store.getState(), t.instrument);
      if (how === 'cancel') {
        const gone = missing ? ` (${missing === 1 ? 'one effect it had is' : `${missing} effects it had are`} no longer on the part, so ${missing === 1 ? 'it stays' : 'they stay'} removed)` : '';
        notify(`${t.name} is back to ${was} as you had it${gone}.`, 'info', step ? 'undo' : undefined);
      } else if (how === 'keep' && step) notify(`${t.name} now plays ${now}. Undo brings back ${was} as you had it.`, 'info', 'undo');
      return cur;
    },
    [trackId],
  );
  useEffect(() => {
    begin();
    return () => void end('keep');
  }, [begin, end]);
  // Pause while any import is decoded and put on a part (onto this part, or a sampler part offered instead).
  useEffect(() => {
    let paused: { before: Project; snap: BrowseState['snap'] } | null = null;
    const check = (st: Record<Id, ImportStatus>) => {
      const busy = Object.values(st).some((x) => x.phase === 'decoding');
      if (busy && !paused) {
        const before = session.store.getState();
        const cur = end('pause');
        paused = { before, snap: cur?.snap ?? null };
      } else if (!busy && paused) {
        const was = paused;
        paused = null;
        // Nothing changed: Cancel still goes back to the sound as it was when the dialog opened.
        begin(session.store.getState() === was.before ? was.snap : undefined);
      }
    };
    check(importStore.getState());
    return importStore.subscribe(check);
  }, [begin, end]);
  return { begin, end, baseName };
}

function SoundBrowserDialog({ trackId: openedFor, onClose }: { trackId: Id; onClose(): void }) {
  // The part it opened for, whatever gets selected meanwhile (an import put on another part selects that part).
  const [trackId] = useState(openedFor);
  const info = useProject(
    (p) => {
      const t = p.tracks.find((x) => x.id === trackId);
      if (!t) return null;
      return {
        name: t.name,
        kind: t.instrument.kind,
        soundId: soundIdOf(t.instrument),
        sound: soundName(p, t.instrument),
        hasNotes: t.clips.some((c) => !!c && c.notes.length > 0),
        arp: t.instrument.kind !== 'drums' && t.arp.enabled,
      };
    },
    shallowEqual,
  );
  const samples = useProject((p) => p.samples);
  const keyName = useProject((p) => keyLabel(p.root, p.scale));
  const takeLocked = useRuntime((s) => s.recording === 'performance');
  const recordingNotesHere = useRuntime((s) => s.recording === 'notes' && s.recordTarget?.trackId === trackId);
  const previewOff = takeLocked || recordingNotesHere;
  const currentCategory = info ? categoryOfSound(info.kind, info.soundId || null) : undefined;
  const startCategory: SoundCategory = currentCategory ?? (info?.kind === 'drums' ? 'drums' : info?.kind === 'sampler' ? 'recordings' : 'keys');
  const [category, setCategory] = useState<SoundCategory>(startCategory);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<Scope>(startCategory);
  const [autoPreview, setAutoPreview] = useState(true);
  const [active, setActive] = useState<string | null>(null);
  const importStatus = useStore(importStore, (st) => importStatusOf(st, trackId));
  const importing = importStatus.phase === 'decoding' ? importStatus.fileName : null;
  const importResult = importStatus.phase === 'done' ? importStatus : null;
  const browse = useBrowse(trackId);
  const fileRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const currentRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const searchId = useId();
  const preview = usePreview(trackId);

  const searching = query.trim().length > 0;
  const sections = useMemo(
    () => (searching ? searchSections(query, samples, scope === 'all' ? undefined : scope) : categorySections(category, samples)),
    [searching, query, samples, scope, category],
  );
  const counts = useMemo(() => categoryCounts(samples, searching ? query : ''), [samples, searching, query]);
  const entries = useMemo(() => sections.flatMap((s) => s.entries), [sections]);
  const keyOf = (e: SoundEntry) => `${e.kind}:${e.id}`;
  const currentKey = info ? `${info.kind}:${info.soundId}` : '';
  // The roving tab stop: the focused card, else the current sound, else the first card.
  const tabStop = active && entries.some((e) => keyOf(e) === active) ? active : entries.some((e) => keyOf(e) === currentKey) ? currentKey : entries[0] ? keyOf(entries[0]) : null;

  const importBusy = importStatus.phase === 'confirm' || importStatus.phase === 'decoding';

  if (!info) return null;

  const choose = (entry: SoundEntry) => {
    setActive(keyOf(entry));
    if (keyOf(entry) !== currentKey) {
      if (!session.accepted(changeInstrumentSound(session.store, trackId, entry.kind, entry.id))) return;
    }
    if (autoPreview && !previewOff) void preview();
  };

  const selectCategory = (c: SoundCategory, focus: boolean) => {
    setActive(null);
    if (searching) setScope(c);
    else setCategory(c);
    if (focus) tabsRef.current?.querySelector<HTMLElement>(`[data-category="${c}"]`)?.focus();
  };

  const tabIds: Scope[] = [...(searching ? (['all'] as const) : []), ...SOUND_CATEGORIES.map((c) => c.id)];
  const selectedTab: Scope = searching ? scope : category;
  const onTabsKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabIds.indexOf(selectedTab);
    let next: Scope | undefined;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = tabIds[(i + 1) % tabIds.length];
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = tabIds[(i - 1 + tabIds.length) % tabIds.length];
    else if (e.key === 'Home') next = tabIds[0];
    else if (e.key === 'End') next = tabIds[tabIds.length - 1];
    if (!next) return;
    e.preventDefault();
    if (next === 'all') {
      setScope('all');
      setActive(null);
      tabsRef.current?.querySelector<HTMLElement>('[data-category="all"]')?.focus();
    } else selectCategory(next, true);
  };

  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.getAttribute('role') !== 'option' || !listRef.current) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const entry = entries.find((x) => keyOf(x) === target.dataset.key);
      if (entry && !e.repeat) choose(entry);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const next = neighbour(listRef.current, target, e.key);
    if (next) {
      setActive(next.dataset.key ?? null);
      next.focus();
      next.scrollIntoView({ block: 'nearest' });
    }
  };

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape' && query) {
      // First Escape clears the search; the next one closes the dialog.
      e.preventDefault();
      e.stopPropagation();
      setQuery('');
      setScope(category);
    } else if (e.key === 'ArrowDown') {
      const first = listRef.current?.querySelector<HTMLElement>('[role="option"][tabindex="0"]') ?? listRef.current?.querySelector<HTMLElement>('[role="option"]');
      if (first) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  const onImport = (file: File | undefined) => {
    if (!file) return;
    // Checked first; the browse pauses while it is decoded and put on a part (useBrowse).
    // Its result is said in the dialog's status line (a toast would only cover the dialog's keys).
    void chooseFileForPart(file, trackId, { toast: false }).then((res) => {
      if (res?.ok && autoPreview && !isRecordingPart(runtimeStore.getState(), trackId)) void preview();
    });
  };

  const visibleKinds = new Set<InstrumentKind>(entries.map((e) => e.kind));
  const showsDrums = visibleKinds.has('drums');
  const showsMelodic = visibleKinds.has('bass') || visibleKinds.has('poly') || visibleKinds.has('sampler');
  const crossToDrums = info.hasNotes && info.kind !== 'drums' && showsDrums;
  const crossFromDrums = info.hasNotes && info.kind === 'drums' && showsMelodic;
  const melodicWord = visibleKinds.has('sampler') && !visibleKinds.has('bass') && !visibleKinds.has('poly') ? 'sampler' : 'synth';
  const previewWhat =
    info.kind === 'drums'
      ? 'a kick, snare and hat together'
      : info.kind === 'bass'
        ? `the root note of ${keyName}`
        : info.kind === 'poly'
          ? `a chord in ${keyName}`
          : 'the recording at its original pitch';
  const canPreview = !(info.kind === 'sampler' && !info.soundId) && !previewOff;
  const previewTip = `Plays ${previewWhat} on ${info.name} with its current sound (${info.sound})${info.arp ? ' as held notes (previews skip the arpeggiator)' : ''}.`;
  const showImport = searching ? scope === 'recordings' : category === 'recordings';
  const resultCount = entries.length;
  const panelLabel = searching ? `Sounds matching "${query.trim()}"` : soundCategoryInfo(category).name;
  const blurb = searching ? null : soundCategoryInfo(category).blurb;

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Change instrument: ${info.name}`}
      description={
        <>
          Any part can play any sound. Choosing one changes <strong>{info.name}</strong> right away, so you can compare: Done keeps your choice (one Undo goes back), Cancel goes back to {browse.baseName || 'its sound'} as you had it.
        </>
      }
      size="lg"
      className={styles.dialog}
      initialFocusRef={currentRef}
      actions={
        <>
          <span className={styles.now} aria-live="polite">
            <span className={styles.nowLamp} aria-hidden="true" />
            <span className={styles.nowText}>
              Now: <strong>{info.sound}</strong> · {INSTRUMENT_LABEL[info.kind]}
            </span>
          </span>
          <Switch label="Preview on choose" size="sm" checked={autoPreview} onChange={setAutoPreview} tip="Plays a short example each time you choose a sound." />
          <Button icon="play" onClick={() => void preview()} disabled={!canPreview} tip={previewTip}>
            Preview
          </Button>
          <Button
            variant="secondary"
            className={styles.cancel}
            aria-label={`Cancel (back to ${browse.baseName} as you had it)`}
            disabled={importBusy}
            onClick={() => {
              browse.end('cancel');
              onClose();
            }}
            tip={`Puts ${info.name} back to ${browse.baseName} exactly as you had it, with your knob settings and effects, and leaves no undo step for the sounds you tried.`}
          >
            Cancel <span className={styles.cancelWhere}>(back to {browse.baseName} as you had it)</span>
          </Button>
          <Button variant="primary" onClick={onClose} tip="Keeps the sound chosen now. One Undo goes back to the sound you had.">
            Done
          </Button>
        </>
      }
    >
      <div className={styles.layout}>
        <div className={styles.side}>
          <label className={styles.search} htmlFor={searchId}>
            <Icon name="search" size={16} />
            <span className="visually-hidden">Search all sounds</span>
            <input
              id={searchId}
              type="search"
              className={styles.searchInput}
              placeholder="Search: piano, 808, strings…"
              value={query}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => {
                const v = e.currentTarget.value;
                setQuery(v);
                setActive(null);
                // A new search looks everywhere; a category tab narrows it afterwards.
                setScope(v.trim() ? 'all' : category);
              }}
              onKeyDown={onSearchKey}
            />
          </label>
          <div ref={tabsRef} role="tablist" aria-orientation="vertical" aria-label="Sound categories" className={styles.tabs} onKeyDown={onTabsKey}>
            {searching && (
              <button
                type="button"
                role="tab"
                data-category="all"
                aria-selected={scope === 'all'}
                aria-controls={panelId}
                tabIndex={scope === 'all' ? 0 : -1}
                className={styles.tab}
                onClick={() => {
                  setScope('all');
                  setActive(null);
                }}
              >
                <Icon name="search" size={18} />
                <span className={styles.tabName}>All matches</span>
                <span className={styles.count}>
                  {Object.values(counts).reduce((a, b) => a + b, 0)}
                  <span className="visually-hidden"> sounds</span>
                </span>
              </button>
            )}
            {SOUND_CATEGORIES.map((c) => {
              const selected = selectedTab === c.id;
              const n = counts[c.id];
              return (
                <button
                  key={c.id}
                  type="button"
                  role="tab"
                  data-category={c.id}
                  aria-selected={selected}
                  aria-controls={panelId}
                  tabIndex={selected ? 0 : -1}
                  className={styles.tab}
                  data-empty={searching && n === 0 ? true : undefined}
                  data-current={c.id === currentCategory || undefined}
                  onClick={() => selectCategory(c.id, false)}
                >
                  <Icon name={CATEGORY_ICON[c.id]} size={18} />
                  <span className={styles.tabName}>{c.name}</span>
                  {c.id === currentCategory && <span className="visually-hidden"> (current sound is here)</span>}
                  <span className={styles.count}>
                    {n}
                    <span className="visually-hidden">{n === 1 ? ' sound' : ' sounds'}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div id={panelId} role="tabpanel" aria-label={panelLabel} className={styles.panel}>
          <div className={styles.panelHead}>
            <h3 className={styles.panelTitle}>{panelLabel}</h3>
            {blurb && <p className={styles.blurb}>{blurb}</p>}
            <p className="visually-hidden" aria-live="polite">
              {searching ? (resultCount === 0 ? `No sounds match "${query.trim()}".` : `${resultCount} ${resultCount === 1 ? 'sound matches' : 'sounds match'} "${query.trim()}".`) : ''}
            </p>
          </div>
          {takeLocked && (
            <Notice tone="warning" className={styles.notice}>
              A performance is recording, so sound choices are locked until you stop. Preview is off while the take runs.
            </Notice>
          )}
          {recordingNotesHere && (
            <Notice tone="warning" className={styles.notice}>
              Record Notes is recording into {info.name}, so Preview is off while you record. You can still choose a sound.
            </Notice>
          )}
          {crossToDrums && (
            <Notice tone="info" className={styles.notice}>
              The clips on {info.name} hold melody notes. A drum kit plays only drum hits, so they stay silent until you add drum steps. Undo switches back.
            </Notice>
          )}
          {crossFromDrums && (
            <Notice tone="info" className={styles.notice}>
              The clips on {info.name} hold drum hits, which a {melodicWord} would play as very low notes. Write new notes after switching; Undo switches back.
            </Notice>
          )}

          <div
            ref={listRef}
            role="listbox"
            aria-label={`${panelLabel}: sounds for ${info.name}`}
            aria-disabled={takeLocked || undefined}
            className={styles.list}
            onKeyDown={onListKey}
          >
            {searching && resultCount === 0 && (
              <p className={styles.empty}>
                No sounds match “{query.trim()}”. Try a simpler word such as piano, bass, bell, pad or kick{scope !== 'all' ? ', or look in All matches' : ''}.
              </p>
            )}
            {sections.map((section) => (
              <div key={section.id} role="group" aria-label={section.heading} className={styles.section}>
                {(sections.length > 1 || searching) && (
                  <h4 className={styles.heading} aria-hidden="true">
                    {searching && <Icon name={CATEGORY_ICON[section.entries[0]?.category ?? 'keys']} size={14} />}
                    {section.heading}
                  </h4>
                )}
                {section.entries.length === 0 ? (
                  section.empty ? <p className={styles.empty}>{section.empty}</p> : null
                ) : (
                  <div className={styles.grid}>
                    {section.entries.map((entry) => {
                      const k = keyOf(entry);
                      const current = k === currentKey;
                      const cardId = `${panelId}-${section.id}-${entry.id}`.replace(/[^A-Za-z0-9_-]/g, '_');
                      return (
                        <div
                          key={k}
                          ref={current ? currentRef : undefined}
                          role="option"
                          aria-selected={current}
                          aria-disabled={takeLocked || undefined}
                          aria-labelledby={`${cardId}-name`}
                          aria-describedby={`${cardId}-desc`}
                          tabIndex={k === tabStop ? 0 : -1}
                          data-key={k}
                          data-current={current || undefined}
                          className={styles.card}
                          onClick={() => choose(entry)}
                          onFocus={() => setActive(k)}
                        >
                          <span className={styles.cardHead}>
                            <span className={styles.lamp} aria-hidden="true" />
                            <span id={`${cardId}-name`} className={styles.cardName}>
                              {entry.name}
                            </span>
                            {current && <span className={styles.badge}>Current</span>}
                          </span>
                          <span id={`${cardId}-desc`} className={styles.cardDesc}>
                            <span className={styles.kind}>{INSTRUMENT_LABEL[entry.kind]}</span> {entry.description}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>

          {showImport && (
            <div className={styles.import}>
              <input
                ref={fileRef}
                type="file"
                accept=".wav,.mp3,audio/wav,audio/x-wav,audio/mpeg"
                className="visually-hidden"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(e) => {
                  const f = e.currentTarget.files?.[0];
                  e.currentTarget.value = '';
                  onImport(f);
                }}
              />
              <div className={styles.importRow}>
                <Button
                  icon="upload"
                  size="sm"
                  onClick={() => fileRef.current?.click()}
                  disabled={importBusy || takeLocked}
                  tip={`${IMPORT_LIMITS.description} It goes into a new clip on ${info.name} (an empty pad), at its recorded pitch.`}
                >
                  {importing ? 'Importing…' : 'Import WAV or MP3…'}
                </Button>
                <span className={styles.importNote} role="status" data-tone={importResult && !importResult.ok ? 'error' : undefined}>
                  {importing ? `Decoding "${importing}" on this device…` : importResult?.ok ? importResult.message : importResult ? '' : IMPORT_LIMITS.description}
                </span>
              </div>
              {importResult && !importResult.ok && (
                <Notice tone="warning" className={styles.importRefused} onDismiss={() => clearImportStatus(trackId)} dismissLabel="Dismiss import message">
                  {importResult.message}
                </Notice>
              )}
              <ImportConfirm trackId={trackId} />
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
