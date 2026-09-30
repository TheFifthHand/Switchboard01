/**
 * Drums mode: a 4x4 performance pad layout for the selected part's drum kit.
 *
 * Pad index 0 is bottom-left and rows run bottom-to-top, matching the
 * computer keys (Z X C V / A S D F / Q W E R / 1 2 3 4). A pad plays its kit
 * voice through the session (so Record Notes and Record Performance capture
 * it) with a velocity from where it is struck, lights while it is held
 * (runtime `held`), and selects its voice for step editing (teal ring).
 *
 * If the selected part is not a drum kit, a chooser lists the project's
 * drum-kit parts, so there is always a way forward.
 *
 * Also exports the pieces the Notes pads share: the pad order, grid arrow
 * navigation, the part list, the part switch, the chooser and the hit readout.
 */
import { memo, useCallback, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Button, Pad, Tooltip, drumKeyHint, useComputerKeyboard, useKeyCapLabels, type PadPressEvent } from '../../ui/components';
import { getKitVoiceNames } from '../../audio/instruments/kits';
import { kitInfo } from '../../content/catalog';
import type { Id, InstrumentKind, Project } from '../../project/types';
import { drumVoiceFor, selectDrumVoice, selectTrack, setPadMode } from '../../state/uiStore';
import { session, useProject, useUi } from '../instance';
import { useRuntime } from '../runtime';
import { INSTRUMENT_LABEL, soundName } from '../labels';
import styles from './DrumPads.module.css';

/* ------------------------------------------------------------------ */
/* Shared with NotesPads                                               */
/* ------------------------------------------------------------------ */

/** Pad indices in screen order, top row first (index 0 = bottom-left). */
export const PAD_ROWS: readonly (readonly number[])[] = [
  [12, 13, 14, 15],
  [8, 9, 10, 11],
  [4, 5, 6, 7],
  [0, 1, 2, 3],
];
export const PAD_ORDER: readonly number[] = PAD_ROWS.flat();

/** Arrow keys move focus between pads whose ids are `${prefix}${index}` (Home/End: first/last pad of the row). */
export function padGridKeyDown(prefix: string) {
  return (e: KeyboardEvent<HTMLElement>) => {
    const id = (e.target as HTMLElement).id;
    if (!id.startsWith(prefix)) return;
    const index = Number(id.slice(prefix.length));
    if (!Number.isInteger(index) || index < 0 || index > 15) return;
    const row = Math.floor(index / 4);
    const col = index % 4;
    let r = row;
    let c = col;
    switch (e.key) {
      case 'ArrowUp':
        r = Math.min(3, row + 1);
        break;
      case 'ArrowDown':
        r = Math.max(0, row - 1);
        break;
      case 'ArrowLeft':
        c = Math.max(0, col - 1);
        break;
      case 'ArrowRight':
        c = Math.min(3, col + 1);
        break;
      case 'Home':
        c = 0;
        break;
      case 'End':
        c = 3;
        break;
      default:
        return;
    }
    e.preventDefault();
    const next = e.currentTarget.querySelector<HTMLElement>(`#${prefix}${r * 4 + c}`);
    next?.focus();
  };
}

export interface PartInfo {
  id: Id;
  /** Position on the console, 1-based. */
  number: number;
  name: string;
  kind: InstrumentKind;
  /** Kit, preset or recording name. */
  sound: string;
  /** Drum kit id (drum parts only). */
  kitId: string | null;
}

function partsOf(p: Project): PartInfo[] {
  return p.tracks.map((t, i) => ({
    id: t.id,
    number: i + 1,
    name: t.name,
    kind: t.instrument.kind,
    sound: soundName(p, t.instrument),
    kitId: t.instrument.kind === 'drums' ? t.instrument.kitId : null,
  }));
}

function sameParts(a: PartInfo[], b: PartInfo[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.id !== y.id || x.name !== y.name || x.kind !== y.kind || x.sound !== y.sound || x.kitId !== y.kitId) return false;
  }
  return true;
}

/** The project's parts (re-renders only when a name, sound or instrument changes). */
export function useParts(): PartInfo[] {
  return useProject(partsOf, sameParts);
}

const article = (word: string) => (/^[aeiou]/i.test(word) ? 'an' : 'a');

/**
 * Choose which part the pads play: a radio group of part keys (teal lamp =
 * selected). Arrow keys move and select.
 */
export function PartSwitch(props: { parts: readonly PartInfo[]; selectedId: Id; label: string; columns?: 1 | 2; compact?: boolean }) {
  const { parts, selectedId, label, columns = 1, compact = false } = props;
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selectedIndex = parts.findIndex((p) => p.id === selectedId);
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % parts.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + parts.length) % parts.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = parts.length - 1;
    if (next < 0) return;
    e.preventDefault();
    refs.current[next]?.focus();
    selectTrack(parts[next].id);
  };
  return (
    <div className={styles.switch} role="radiogroup" aria-label={label} data-columns={columns}>
      {parts.map((p, i) => {
        const on = p.id === selectedId;
        const key = (
          <button
            key={p.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={`${p.name} (part ${p.number}, ${p.sound})`}
            tabIndex={on || (selectedIndex < 0 && i === 0) ? 0 : -1}
            className={styles.partKey}
            data-on={on || undefined}
            data-compact={compact || undefined}
            onClick={() => selectTrack(p.id)}
            onKeyDown={(e) => onKey(e, i)}
          >
            <span className={styles.lamp} aria-hidden="true" />
            <span className={`${styles.partNum} mono`} aria-hidden="true">
              {p.number}
            </span>
            <span className={styles.partText} aria-hidden="true">
              <span className={styles.partName}>{p.name}</span>
              {!compact && <span className={styles.partSound}>{p.sound}</span>}
            </span>
          </button>
        );
        // Compact keys show only the part name; the sound appears on hover/focus.
        return compact ? (
          <Tooltip key={p.id} name={p.sound}>
            {key}
          </Tooltip>
        ) : (
          key
        );
      })}
    </div>
  );
}

/**
 * Shown when the selected part does not suit the pad mode: explains why and
 * offers every part that does (and the other pad mode for the current part).
 */
export function PartChooser(props: { mode: 'drums' | 'notes'; current: PartInfo | undefined; options: readonly PartInfo[] }) {
  const { mode, current, options } = props;
  const drums = mode === 'drums';
  const kindWord = current ? INSTRUMENT_LABEL[current.kind].toLowerCase() : '';
  const reason = current ? `${current.name} is ${article(kindWord)} ${kindWord}.` : 'No part is selected.';
  const ask = options.length
    ? drums
      ? `Choose a drum part to play on the pads:`
      : `Choose a part to play on the pads:`
    : drums
      ? 'No part in this project uses a drum kit yet. Give a part a drum kit to play it here.'
      : 'Every part in this project is a drum kit. Give a part a synth or sampler to play notes here.';
  const titleId = `${mode}-chooser-title`;
  return (
    <div className={styles.chooser}>
      <section className={styles.chooserCard} aria-labelledby={titleId}>
        <p className={styles.eyebrow}>{drums ? 'Drum pads' : 'Note pads'}</p>
        <h3 id={titleId} className={styles.chooserTitle}>
          {drums ? 'These pads play a drum kit' : 'These pads play notes on a melodic part'}
        </h3>
        <p className={styles.chooserText}>
          {reason} {ask}
        </p>
        {options.length > 0 && (
          <div className={styles.chooserList} role="group" aria-label={drums ? 'Drum parts' : 'Melodic parts'}>
            {options.map((p) => (
              <button key={p.id} type="button" className={styles.chooserOption} onClick={() => selectTrack(p.id)} aria-label={`Play ${p.name} (part ${p.number}, ${p.sound})`}>
                <span className={`${styles.partNum} mono`} aria-hidden="true">
                  {p.number}
                </span>
                <span className={styles.partText} aria-hidden="true">
                  <span className={styles.partName}>{p.name}</span>
                  <span className={styles.partSound}>
                    {p.sound} · {INSTRUMENT_LABEL[p.kind]}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
        {current && (
          <div className={styles.chooserAlt}>
            <span className={styles.chooserOr}>or</span>
            <Button size="sm" variant="secondary" onClick={() => setPadMode(drums ? 'notes' : 'drums')}>
              Play {current.name} on {drums ? 'Notes' : 'Drums'} pads
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}

export interface Hit {
  name: string;
  velocity: number;
}

/** The last pad the player struck and how hard (real input only). */
export function HitReadout(props: { hit: Hit | null; label: string }) {
  const { hit, label } = props;
  const pct = hit ? Math.round(hit.velocity * 100) : 0;
  return (
    <div className={styles.readout}>
      <span className={styles.eyebrow}>{label}</span>
      <div className={styles.readRow} aria-hidden="true">
        <span className={styles.readName}>{hit ? hit.name : 'None yet'}</span>
        <span className={`${styles.readValue} mono`}>{hit ? `${pct}%` : '—'}</span>
      </div>
      <div className={styles.velTrack} aria-hidden="true">
        <span className={styles.velFill} style={{ width: `${pct}%` }} />
      </div>
      <span className="visually-hidden">{hit ? `${hit.name}, velocity ${pct} percent` : 'Nothing played yet'}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Drum pads                                                           */
/* ------------------------------------------------------------------ */

const DRUM_PAD_ID = 'drum-pad-';

const DrumPad = memo(function DrumPad(props: { trackId: Id; voice: number; name: string; keyHint?: string; selected: boolean; onHit(voice: number, velocity: number): void }) {
  const { trackId, voice, name, keyHint, selected, onHit } = props;
  const lit = useRuntime((s) => s.held[trackId]?.includes(voice) ?? false);
  const onPress = useCallback(
    (e: PadPressEvent) => {
      session.noteOn(trackId, voice, e.velocity, 'pad');
      onHit(voice, e.velocity);
    },
    [trackId, voice, onHit],
  );
  const onRelease = useCallback(() => session.noteOff(trackId, voice, 'pad'), [trackId, voice]);
  const spoken = `${name}, pad ${voice + 1}${keyHint ? `, key ${keyHint}` : ''}${selected ? ', selected for step editing' : ''}`;
  return (
    <Pad
      id={`${DRUM_PAD_ID}${voice}`}
      state={lit ? 'playing' : 'ready'}
      caption={null}
      selected={selected}
      label={name}
      keyHint={keyHint}
      onPress={onPress}
      onRelease={onRelease}
      ariaLabel={spoken}
    />
  );
});

const onDrumGridKey = padGridKeyDown(DRUM_PAD_ID);

function DrumKit(props: { part: PartInfo; drumParts: readonly PartInfo[] }) {
  const { part, drumParts } = props;
  const trackId = part.id;
  const kitId = part.kitId ?? '';
  const names = useMemo(() => getKitVoiceNames(kitId), [kitId]);
  const kit = kitInfo(kitId);
  const kitName = kit?.name ?? part.sound;
  const padMode = useUi((s) => s.padMode);
  const selectedVoice = useUi((s) => drumVoiceFor(s, trackId));
  const capLabels = useKeyCapLabels();
  const [hit, setHit] = useState<{ voice: number; velocity: number } | null>(null);

  // Striking a pad also chooses its sound for step editing (like hardware).
  const onHit = useCallback(
    (voice: number, velocity: number) => {
      selectDrumVoice(trackId, voice);
      setHit({ voice, velocity });
    },
    [trackId],
  );

  // Computer keys play the pads in Drums mode (this component is keyed by
  // part, so held keys are released before another part is shown).
  useComputerKeyboard({
    enabled: padMode === 'drums',
    layout: 'drums',
    onNoteOn: (voice, velocity) => {
      session.noteOn(trackId, voice, velocity, 'computer');
      onHit(voice, velocity);
    },
    onNoteOff: (voice) => session.noteOff(trackId, voice, 'computer'),
  });

  const keyFor = (voice: number) => drumKeyHint(voice, capLabels);
  const rowKeys = PAD_ROWS.map((row) => `${keyFor(row[0]) ?? ''}–${keyFor(row[3]) ?? ''}`).join(', ');
  const selectedKey = keyFor(selectedVoice);

  return (
    <div className={styles.root}>
      <div className={styles.layout}>
        <div className={styles.info} role="group" aria-label={`${kitName} drum kit`}>
          <div className={styles.block}>
            <p className={styles.eyebrow}>Drum kit</p>
            <h3 className={styles.title}>{kitName}</h3>
            {kit?.description && <p className={styles.desc}>{kit.description}</p>}
          </div>

          {drumParts.length > 1 && (
            <div className={styles.block}>
              <p className={styles.eyebrow}>Drum part</p>
              <PartSwitch parts={drumParts} selectedId={trackId} label="Drum part the pads play" columns={drumParts.length > 3 ? 2 : 1} compact={drumParts.length > 3} />
            </div>
          )}

          <div className={styles.block}>
            <p className={styles.eyebrow}>Selected sound</p>
            <div className={styles.selRow}>
              <span className={styles.selDot} aria-hidden="true" />
              <span className={styles.selName}>{names[selectedVoice]}</span>
              <span className={`${styles.selMeta} mono`}>
                Pad {selectedVoice + 1}
                {selectedKey ? ` · ${selectedKey}` : ''}
              </span>
            </div>
            <p className={styles.desc}>Steps edits this sound. Tap a pad to choose another.</p>
          </div>

          <div className={styles.block}>
            <HitReadout label="Last hit" hit={hit ? { name: names[hit.voice] ?? `Pad ${hit.voice + 1}`, velocity: hit.velocity } : null} />
          </div>

          <div className={styles.foot}>
            <p className={styles.hint}>
              Tap pads or use keys <span className={`${styles.keys} mono`}>{rowKeys}</span>
            </p>
            <p className={styles.subHint}>Strike lower on a pad to play harder.</p>
          </div>
        </div>

        <div className={styles.gridWrap}>
          <div className={styles.grid} role="group" aria-label={`${kitName} pads for ${part.name}, 4 by 4. Arrow keys move between pads.`} onKeyDown={onDrumGridKey}>
            {PAD_ORDER.map((voice) => (
              <DrumPad key={voice} trackId={trackId} voice={voice} name={names[voice] ?? `Pad ${voice + 1}`} keyHint={keyFor(voice)} selected={voice === selectedVoice} onHit={onHit} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function DrumPads() {
  const trackId = useUi((s) => s.selectedTrackId);
  const parts = useParts();
  const part = parts.find((p) => p.id === trackId);
  const drumParts = useMemo(() => parts.filter((p) => p.kind === 'drums'), [parts]);
  if (!part || part.kind !== 'drums') return <PartChooser mode="drums" current={part} options={drumParts} />;
  return <DrumKit key={part.id} part={part} drumParts={drumParts} />;
}
