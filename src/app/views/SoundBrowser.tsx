/**
 * Sound browser: choose the sound of one part — a drum kit, a bass or poly
 * synth preset (presets suggested for the part's role first), or a sampler
 * recording (built-in or imported into this project).
 *
 * Choosing applies the sound at once (one undoable edit) and keeps the
 * dialog open so sounds can be compared. Preview plays a short chord on the
 * part with its *current* sound through the normal note path (drums: kick,
 * snare and hat together; bass: the key's root; poly: a triad in the project
 * key; sampler: the recording at its original pitch).
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Button, Dialog, Notice, SegmentedControl, Switch } from '../../ui/components';
import { BUILTIN_SAMPLES, KITS, SYNTH_PRESETS } from '../../content/catalog';
import { SCALES, keyLabel } from '../../music/scales';
import { IMPORT_LIMITS } from '../../persistence/audioImport';
import type { Id, Instrument, InstrumentKind, Project, SampleMeta, TrackRole } from '../../project/types';
import { changeInstrumentSound } from '../../state/commands';
import { shallowEqual } from '../../state/store';
import { session, useProject } from '../instance';
import { notify, useRuntime } from '../runtime';
import { INSTRUMENT_LABEL, soundName } from '../labels';
import styles from './SoundBrowser.module.css';

interface SoundEntry {
  kind: InstrumentKind;
  id: string;
  name: string;
  description: string;
}

interface Section {
  heading: string;
  entries: SoundEntry[];
}

const TABS: readonly { value: InstrumentKind; label: string }[] = [
  { value: 'drums', label: 'Drum kits' },
  { value: 'bass', label: 'Bass synth' },
  { value: 'poly', label: 'Poly synth' },
  { value: 'sampler', label: 'Sampler' },
];

const ROLE_WORDS: Record<TrackRole, string> = {
  drums: 'drums',
  percussion: 'percussion',
  bass: 'bass lines',
  chords: 'chords',
  lead: 'leads',
  pad: 'pads',
  texture: 'textures',
  sampler: 'sampler parts',
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

function synthSections(kind: 'bass' | 'poly', role: TrackRole): Section[] {
  const all = SYNTH_PRESETS.filter((p) => p.kind === kind).map((p) => ({ kind, id: p.id, name: p.name, description: p.description, roles: p.roles }));
  const suggested = all.filter((p) => p.roles.includes(role));
  const label = kind === 'bass' ? 'bass' : 'poly synth';
  if (suggested.length === 0 || suggested.length === all.length) return [{ heading: `All ${label} presets`, entries: all }];
  return [
    { heading: `Suggested for ${ROLE_WORDS[role]}`, entries: suggested },
    { heading: `All other ${label} presets`, entries: all.filter((p) => !suggested.includes(p)) },
  ];
}

function sectionsFor(kind: InstrumentKind, role: TrackRole, samples: readonly SampleMeta[]): Section[] {
  switch (kind) {
    case 'drums':
      return [{ heading: 'Drum kits', entries: KITS.map((k) => ({ kind, id: k.id, name: k.name, description: k.description })) }];
    case 'bass':
    case 'poly':
      return synthSections(kind, role);
    case 'sampler':
      return [
        { heading: 'Built-in recordings', entries: BUILTIN_SAMPLES.map((s) => ({ kind, id: s.id, name: s.name, description: s.description })) },
        {
          heading: 'Imported into this project',
          entries: samples.map((s) => ({ kind, id: s.id, name: s.name, description: `${s.duration.toFixed(1)} s · ${s.channels === 1 ? 'mono' : 'stereo'} · plays at its original pitch` })),
        },
      ];
  }
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

/** Plays and releases preview notes on a part; releases on stop/unmount so nothing hangs. */
function usePreview(trackId: Id) {
  const held = useRef<{ trackId: Id; pitches: number[]; timer: number } | null>(null);
  const alive = useRef(true);
  const stop = useCallback(() => {
    const h = held.current;
    if (!h) return;
    held.current = null;
    window.clearTimeout(h.timer);
    for (const pitch of h.pitches) session.noteOff(h.trackId, pitch, 'pad');
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
    // Must run inside the click: this is what may start browser audio.
    const ok = await session.startAudio();
    if (!ok || !alive.current) return;
    const { notes, holdMs } = previewNotesFor(session.store.getState(), trackId);
    if (notes.length === 0) {
      notify('This part has no recording to preview yet. Choose one from the list.', 'warn');
      return;
    }
    stop();
    for (const n of notes) session.noteOn(trackId, n.pitch, n.velocity, 'pad');
    held.current = { trackId, pitches: notes.map((n) => n.pitch), timer: window.setTimeout(stop, holdMs) };
  }, [trackId, stop]);
  return play;
}

/* ------------------------------------------------------------------ */
/* List navigation                                                     */
/* ------------------------------------------------------------------ */

/** Arrow keys move through the cards by their on-screen position (two columns). */
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

function SoundBrowserDialog({ trackId, onClose }: { trackId: Id; onClose(): void }) {
  const info = useProject(
    (p) => {
      const t = p.tracks.find((x) => x.id === trackId);
      if (!t) return null;
      return {
        name: t.name,
        role: t.role,
        kind: t.instrument.kind,
        soundId: soundIdOf(t.instrument),
        sound: soundName(p, t.instrument),
        hasNotes: t.clips.some((c) => !!c && c.notes.length > 0),
      };
    },
    shallowEqual,
  );
  const samples = useProject((p) => p.samples);
  const keyName = useProject((p) => keyLabel(p.root, p.scale));
  const takeLocked = useRuntime((s) => s.recording === 'performance');
  const [tab, setTab] = useState<InstrumentKind>(info?.kind ?? 'poly');
  const [autoPreview, setAutoPreview] = useState(true);
  const [active, setActive] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<{ ok: boolean; message: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const currentRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const preview = usePreview(trackId);

  const sections = useMemo(() => (info ? sectionsFor(tab, info.role, samples) : []), [tab, info, samples]);
  const entries = useMemo(() => sections.flatMap((s) => s.entries), [sections]);
  const keyOf = (e: SoundEntry) => `${e.kind}:${e.id}`;
  const currentKey = info ? `${info.kind}:${info.soundId}` : '';
  // The roving tab stop: the focused card, else the current sound, else the first card.
  const tabStop = active && entries.some((e) => keyOf(e) === active) ? active : entries.some((e) => keyOf(e) === currentKey) ? currentKey : entries[0] ? keyOf(entries[0]) : null;

  if (!info) return null;

  const choose = (entry: SoundEntry) => {
    setActive(keyOf(entry));
    if (keyOf(entry) !== currentKey) {
      if (!session.accepted(changeInstrumentSound(session.store, trackId, entry.kind, entry.id))) return;
    }
    if (autoPreview) void preview();
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

  const onImport = async (file: File | undefined) => {
    if (!file) return;
    setImporting(file.name);
    setImportResult(null);
    const res = await session.importSample(file, trackId);
    setImporting(null);
    setImportResult(res);
    if (res.ok && autoPreview) void preview();
  };

  const crossToDrums = info.hasNotes && info.kind !== 'drums' && tab === 'drums';
  const crossFromDrums = info.hasNotes && info.kind === 'drums' && tab !== 'drums';
  const previewWhat =
    info.kind === 'drums'
      ? 'a kick, snare and hat together'
      : info.kind === 'bass'
        ? `the root note of ${keyName}`
        : info.kind === 'poly'
          ? `a chord in ${keyName}`
          : 'the recording at its original pitch';
  const canPreview = !(info.kind === 'sampler' && !info.soundId);

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Sound for ${info.name}`}
      description={
        <>
          Choosing a sound changes <strong>{info.name}</strong> right away; Undo brings the previous one back. Compare them with Preview or by playing the keyboard.
        </>
      }
      size="lg"
      initialFocusRef={currentRef}
      actions={
        <>
          <span className={styles.now} aria-live="polite">
            <span className={styles.nowLamp} aria-hidden="true" />
            <span className={styles.nowText}>
              Now: <strong>{info.sound}</strong> · {INSTRUMENT_LABEL[info.kind]}
            </span>
          </span>
          <Switch
            label="Preview on choose"
            size="sm"
            checked={autoPreview}
            onChange={setAutoPreview}
            tip="Plays a short example each time you choose a sound."
          />
          <Button icon="play" onClick={() => void preview()} disabled={!canPreview} tip={`Plays ${previewWhat} on ${info.name} with its current sound (${info.sound}).`}>
            Preview
          </Button>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <div className={styles.tabs}>
        <SegmentedControl<InstrumentKind>
          label="Sound type"
          kind="tabs"
          size="sm"
          options={TABS}
          value={tab}
          onChange={(v) => {
            setTab(v);
            setActive(null);
          }}
          controls={panelId}
        />
      </div>

      <div id={panelId} role="tabpanel" aria-label={TABS.find((t) => t.value === tab)?.label} className={styles.panel}>
        {takeLocked && (
          <Notice tone="warning" className={styles.notice}>
            A performance is recording, so sound choices are locked until you stop. Preview still works.
          </Notice>
        )}
        {crossToDrums && (
          <Notice tone="info" className={styles.notice}>
            {info.name}'s clips hold melody notes. A drum kit plays only drum hits, so they stay silent until you add drum steps. Undo switches back.
          </Notice>
        )}
        {crossFromDrums && (
          <Notice tone="info" className={styles.notice}>
            {info.name}'s clips hold drum hits, which a {tab === 'sampler' ? 'sampler' : 'synth'} would play as very low notes. Write new notes after switching; Undo switches back.
          </Notice>
        )}

        <div ref={listRef} role="listbox" aria-label={`${TABS.find((t) => t.value === tab)?.label} for ${info.name}`} aria-disabled={takeLocked || undefined} className={styles.list} onKeyDown={onListKey}>
          {sections.map((section) => (
            <div key={section.heading} role="group" aria-label={section.heading} className={styles.section}>
              <h3 className={styles.heading} aria-hidden="true">
                {section.heading}
              </h3>
              {section.entries.length === 0 ? (
                <p className={styles.empty}>Nothing imported yet. Import a WAV or MP3 below and it appears here for every part of this project.</p>
              ) : (
                <div className={styles.grid}>
                  {section.entries.map((entry) => {
                    const k = keyOf(entry);
                    const current = k === currentKey;
                    return (
                      <div
                        key={k}
                        ref={current ? currentRef : undefined}
                        role="option"
                        aria-selected={current}
                        aria-disabled={takeLocked || undefined}
                        tabIndex={k === tabStop ? 0 : -1}
                        data-key={k}
                        data-current={current || undefined}
                        className={styles.card}
                        onClick={() => choose(entry)}
                        onFocus={() => setActive(k)}
                      >
                        <span className={styles.cardHead}>
                          <span className={styles.lamp} aria-hidden="true" />
                          <span className={styles.cardName}>{entry.name}</span>
                          {current && <span className={styles.badge}>Current</span>}
                        </span>
                        <span className={styles.cardDesc}>{entry.description}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>

        {tab === 'sampler' && (
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
                void onImport(f);
              }}
            />
            <Button icon="upload" size="sm" onClick={() => fileRef.current?.click()} disabled={!!importing || takeLocked} tip={IMPORT_LIMITS.description}>
              {importing ? 'Importing…' : 'Import WAV or MP3…'}
            </Button>
            <span className={styles.importNote} role="status" data-tone={importResult && !importResult.ok ? 'error' : undefined}>
              {importing ? `Decoding "${importing}" on this device…` : importResult ? importResult.message : IMPORT_LIMITS.description}
            </span>
          </div>
        )}
      </div>
    </Dialog>
  );
}
