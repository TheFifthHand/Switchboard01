/**
 * The small keyboard: two octaves (three on a wide strip, its keys widening
 * to fill the strip), octave shift, a computer-key letter on every key it
 * plays (note names — C4, C5, the root — sit on a rail above their keys),
 * Musical Assist (in-key notes) with a visible explanation and a chromatic
 * mode. Simple shows the key as a summary ("Key: G Dorian"); Advanced adds
 * the key and scale pickers and the arpeggiator strip.
 *
 * A drum part gets 16 named sound keys with their letters, and the computer
 * keys always use the drum-pad layout (Z–V / A–F / Q–R / 1–4) — the same
 * table the Drums pads use — in every pad mode, so one key always plays one
 * kit sound. Musical Assist does nothing for drums, so its switch is hidden.
 *
 * Changing the key in Advanced asks once (a small popover) whether the song
 * moves with it: "Move the song" transposes every melodic clip in one undo
 * step (transposeSong; sampler parts only when ticked), "Only what I play"
 * changes the key alone. Asking never takes focus from the picker: arrow
 * keys there keep changing the key and the question follows; Tab from the
 * Scale picker goes into it. Escape or a press elsewhere keeps the old key.
 * The toast names the sampler parts that kept their pitch.
 *
 * The keyboard folds to a slim bar, remembered per view (Mix starts folded);
 * the computer keys still play then. The strip writes the height it covers
 * at the bottom of the window to `--keyboard-h` on :root (0 when folded or
 * when the page scrolls), so toasts sit above it.
 *
 * Every held key (mouse, touch or computer key) keeps the release of the note
 * it started, so changing the part, the octave or the arpeggiator while it is
 * down still ends that note, on its part and at its pitch.
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Button, IconButton, MiniKeyboard, Select, Switch, Tooltip, noteKeyLabels, useComputerKeyboard, useElementSize, useKeyCapLabels } from '../../ui/components';
import { getKitVoiceNames } from '../../audio/instruments/kits';
import { ROOT_NAMES, SCALES, SCALE_ORDER, keyInterval, keyLabel, keyNoteNames, keyRootName, noteName, scaleMask, type MusicalKey } from '../../music/scales';
import { setAssist, setKey, transposeSong } from '../../state/commands';
import { OCTAVE_RANGE, keyboardCollapsedFor, setKeyboardCollapsedFor, setKeyboardOctave, shiftKeyboardOctave } from '../../state/uiStore';
import { DRUM_VOICES, type Id, type Project, type ScaleId } from '../../project/types';
import { session, useProject, useUi } from '../instance';
import { notify, useRuntime } from '../runtime';
import { ArpStrip } from './ArpPanel';
import { Popover, anchorFromElement } from './ClipMenu';
import { kitKeyLabels, playLive } from './DrumPads';
import styles from './KeyboardStrip.module.css';

const SCALE_OPTIONS = SCALE_ORDER.map((id) => ({ value: id, label: SCALES[id].name }));
/** A kit keyboard always starts at C4: its keys are sounds, not pitches. */
const KIT_BASE_NOTE = 60;
/** Two octaves; three when the strip has room for them at KEYS_WIDE_MIN_PX a white key. */
const KEYS_NARROW = 25;
const KEYS_WIDE = 37;
const WHITES_WIDE = 22;
const KEYS_WIDE_MIN_PX = 46;
/** The widest a white key gets (px): wide strips get a third octave rather than wider keys. */
export const KEY_MAX_PX = 60;
/** The widest a kit sound key gets (px). */
export const KIT_KEY_MAX_PX = 88;
/** Height of the keys (the strip is 100 px). */
const KEYS_HEIGHT = 90;

/** Release the note a key started (if it is still down) and forget it. */
function release(map: Map<number, () => void>, key: number): void {
  const r = map.get(key);
  map.delete(key);
  r?.();
}

/**
 * Keep `--keyboard-h` on :root equal to the height the strip covers at the
 * bottom of the window: its height while it is docked there and unfolded;
 * 0 when folded, when the page scrolls (narrow windows) or once it is gone.
 */
function useKeyboardHeightVar(ref: RefObject<HTMLElement | null>, collapsed: boolean): void {
  useLayoutEffect(() => {
    const el = ref.current;
    const root = document.documentElement;
    if (!el) return;
    const write = () => {
      const r = el.getBoundingClientRect();
      const docked = !collapsed && r.height > 0 && Math.abs(r.bottom - window.innerHeight) < 2;
      root.style.setProperty('--keyboard-h', `${docked ? Math.round(r.height) : 0}px`);
    };
    write();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(write) : null;
    ro?.observe(el);
    window.addEventListener('resize', write);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', write);
      root.style.setProperty('--keyboard-h', '0px');
    };
  }, [ref, collapsed]);
}

/* ------------------------------------------------------------------ */
/* Moving the song with a key change                                   */
/* ------------------------------------------------------------------ */

interface SongMovePlan {
  /** Synth parts with notes: they move. */
  moving: string[];
  /** Sampler parts with notes: they keep their pitch unless ticked. */
  samplers: { id: Id; name: string }[];
  /** Any drum part with notes (they never move). */
  drums: boolean;
}

function songMovePlan(p: Project): SongMovePlan {
  const plan: SongMovePlan = { moving: [], samplers: [], drums: false };
  for (const t of p.tracks) {
    if (!t.clips.some((c) => c && c.notes.length > 0)) continue;
    if (t.instrument.kind === 'drums') plan.drums = true;
    else if (t.instrument.kind === 'sampler') plan.samplers.push({ id: t.id, name: t.name });
    else plan.moving.push(t.name);
  }
  return plan;
}

function samePlan(a: SongMovePlan, b: SongMovePlan): boolean {
  return a.drums === b.drums && a.moving.join('|') === b.moving.join('|') && a.samplers.map((s) => s.id + s.name).join('|') === b.samplers.map((s) => s.id + s.name).join('|');
}

/** "Bass", "Bass and Pad", "Bass, Chords, Lead and Pad". */
function listWords(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** How the melodic parts move: "move up 2", "moves down 3", "move to its notes", "move up 2 into its notes". */
function moveWords(count: number, from: MusicalKey, to: MusicalKey): string {
  const verb = count === 1 ? 'moves' : 'move';
  const d = keyInterval(from.root, to.root);
  const by = d > 0 ? `up ${d}` : d < 0 ? `down ${-d}` : '';
  if (from.scale === to.scale) return `${verb} ${by}`;
  return by ? `${verb} ${by} into its notes` : `${verb} to its notes`;
}

/** The question: "Move the song to A Dorian too? Bass, Chords, Lead and Pad move up 2; drums stay." */
export function songMoveQuestion(p: Project, to: MusicalKey): string {
  const plan = songMovePlan(p);
  const from = { root: p.root, scale: p.scale };
  const parts = plan.moving.length ? `${listWords(plan.moving)} ${moveWords(plan.moving.length, from, to)}` : 'No synth part has notes to move';
  return `Move the song to ${keyLabel(to.root, to.scale)} too? ${parts}${plan.drums ? '; drums stay.' : '.'}`;
}

const KEY_CHANGE_ID = 'key-change-question';

function KeyChange(props: { pending: MusicalKey; anchor: HTMLElement | null; onDone(): void }) {
  const { pending, anchor, onDone } = props;
  const plan = useProject(songMovePlan, samePlan);
  const question = useProject((p) => songMoveQuestion(p, pending));
  const oldKey = useProject((p) => keyLabel(p.root, p.scale));
  const [ticked, setTicked] = useState<ReadonlySet<Id>>(() => new Set());
  const newKey = keyLabel(pending.root, pending.scale);
  // Asking never takes the keyboard away from the key picker: arrow keys there keep changing the key
  // (the question follows), and Tab from the Scale picker goes into the question.
  const [picker] = useState(() => (anchor && document.activeElement instanceof HTMLElement && anchor.contains(document.activeElement) ? document.activeElement : null));
  useLayoutEffect(() => {
    if (picker?.isConnected) picker.focus({ preventScroll: true });
  }, [picker]);

  const move = () => {
    const samplerParts = plan.samplers.filter((s) => ticked.has(s.id)).map((s) => s.id);
    const r = transposeSong(session.store, pending, { samplerParts });
    onDone();
    if (!session.accepted(r)) return;
    const kept = plan.samplers.filter((s) => !ticked.has(s.id)).map((s) => s.name);
    const extra = [
      plan.drums ? 'Drums stayed.' : '',
      kept.length ? `${listWords(kept)} kept ${kept.length === 1 ? 'its' : 'their'} pitch.` : '',
      r.clamped > 0 ? `${r.clamped} note${r.clamped === 1 ? '' : 's'} folded back an octave to stay in range.` : '',
      r.takesKept > 0 ? 'Recorded performances keep their key.' : '',
    ]
      .filter(Boolean)
      .join(' ');
    notify(`Moved the song to ${newKey}: ${r.notes} note${r.notes === 1 ? '' : 's'} in ${r.clips} clip${r.clips === 1 ? '' : 's'}.${extra ? ` ${extra}` : ''}`, 'info', 'undo');
  };
  const onlyMine = () => {
    const r = setKey(session.store, pending.root, pending.scale);
    onDone();
    if (session.accepted(r)) notify(`Key: ${newKey} for what you play. The song's clips stay in ${oldKey}.`, 'info', 'undo');
  };

  return (
    <Popover anchor={anchorFromElement(anchor)} placement="above" role="dialog" label={`Move the song to ${newKey}?`} onClose={onDone} ignore={anchor} className={styles.movePopover} id={KEY_CHANGE_ID}>
      <div className={styles.move}>
        <p className={styles.moveText} aria-live="polite">
          {question}
        </p>
        {plan.samplers.length > 0 && (
          <fieldset className={styles.moveSamplers}>
            <legend className={styles.moveLegend}>Recordings keep their pitch. Move these too:</legend>
            {plan.samplers.map((s) => (
              <label key={s.id} className={styles.moveCheck}>
                <input
                  type="checkbox"
                  checked={ticked.has(s.id)}
                  onChange={(e) => {
                    const on = e.currentTarget.checked;
                    setTicked((cur) => {
                      const next = new Set(cur);
                      if (on) next.add(s.id);
                      else next.delete(s.id);
                      return next;
                    });
                  }}
                />
                {s.name}
              </label>
            ))}
          </fieldset>
        )}
        <div className={styles.moveActions}>
          <Button variant="primary" size="sm" onClick={move} data-autofocus="">
            Move the song
          </Button>
          <Button variant="secondary" size="sm" onClick={onlyMine}>
            Only what I play
          </Button>
        </div>
      </div>
    </Popover>
  );
}

/* ------------------------------------------------------------------ */
/* The strip                                                           */
/* ------------------------------------------------------------------ */

export function KeyboardStrip(props: { children?: React.ReactNode }) {
  const trackId = useUi((s) => s.selectedTrackId);
  const padMode = useUi((s) => s.padMode);
  const view = useUi((s) => s.view);
  const octave = useUi((s) => s.keyboardOctave);
  const advanced = useUi((s) => s.uiMode === 'advanced');
  const collapsed = useUi((s) => keyboardCollapsedFor(s, s.view));
  const trackName = useProject((p) => p.tracks.find((t) => t.id === trackId)?.name ?? '');
  const kind = useProject((p) => p.tracks.find((t) => t.id === trackId)?.instrument.kind);
  const kitId = useProject((p) => {
    const inst = p.tracks.find((t) => t.id === trackId)?.instrument;
    return inst?.kind === 'drums' ? inst.kitId : null;
  });
  const isDrums = kind === 'drums';
  const isSampler = kind === 'sampler';
  const root = useProject((p) => p.root);
  const scale = useProject((p) => p.scale);
  const assist = useProject((p) => p.assist);
  const held = useRuntime((s) => s.held[trackId]);
  const arpOn = useProject((p) => {
    const t = p.tracks.find((x) => x.id === trackId);
    return !!t && t.arp.enabled && t.instrument.kind !== 'drums';
  });
  const capLabels = useKeyCapLabels();
  const stripRef = useRef<HTMLElement>(null);
  const keysRef = useRef<HTMLDivElement>(null);
  const keyRowRef = useRef<HTMLDivElement>(null);
  const keysBox = useElementSize(keysRef);
  const [pending, setPending] = useState<MusicalKey | null>(null);

  useKeyboardHeightVar(stripRef, collapsed);

  const baseNote = isDrums ? KIT_BASE_NOTE : (octave + 1) * 12;
  // A third octave when the keys would still be at least KEYS_WIDE_MIN_PX wide (and stay inside MIDI).
  const keyCount = keysBox.width >= WHITES_WIDE * KEYS_WIDE_MIN_PX && baseNote + KEYS_WIDE - 1 <= 127 ? KEYS_WIDE : KEYS_NARROW;
  // Drum pads own the computer keys only while they are on screen with a kit selected (same layout, same table).
  const drumPadsOwnKeys = padMode === 'drums' && view === 'play' && isDrums;
  const mask = useMemo(() => (assist ? scaleMask(root, scale) : undefined), [assist, root, scale]);
  const pitchNames = useMemo(() => keyNoteNames(root, scale), [root, scale]);
  const kitNames = useMemo(() => (kitId ? getKitVoiceNames(kitId) : []), [kitId]);
  // Every key the computer plays shows its letter; note names go on the rail above the keys.
  const keyLabels = useMemo(() => (isDrums ? kitKeyLabels(KIT_BASE_NOTE, capLabels) : noteKeyLabels(baseNote, capLabels)), [isDrums, baseNote, capLabels]);
  const active = useMemo(() => {
    if (!held) return new Set<number>();
    return new Set(isDrums ? held.map((v) => KIT_BASE_NOTE + v) : held);
  }, [held, isDrums]);

  // Kit keys: key n plays kit sound n.
  const toPitch = useCallback((midi: number) => (isDrums ? Math.max(0, Math.min(DRUM_VOICES - 1, midi - KIT_BASE_NOTE)) : midi), [isDrums]);

  // Releases of the notes held down: by MIDI note (on-screen keys) and by key index (computer keys).
  const pointerNotes = useRef(new Map<number, () => void>());
  const keyNotes = useRef(new Map<number, () => void>());

  const onNoteOn = useCallback(
    (midi: number, velocity: number) => {
      release(pointerNotes.current, midi);
      pointerNotes.current.set(midi, playLive(trackId, toPitch(midi), velocity, 'keyboard'));
    },
    [trackId, toPitch],
  );
  const onNoteOff = useCallback((midi: number) => release(pointerNotes.current, midi), []);

  // Computer keys: a kit always uses the drum-pad layout (index = kit sound); a melodic part the notes layout.
  useComputerKeyboard({
    enabled: !drumPadsOwnKeys,
    layout: isDrums ? 'drums' : 'notes',
    onNoteOn: (index, velocity) => {
      release(keyNotes.current, index);
      keyNotes.current.set(index, playLive(trackId, isDrums ? index : baseNote + index, velocity, 'computer'));
    },
    onNoteOff: (index) => release(keyNotes.current, index),
    onOctave: (delta) => {
      if (!isDrums) shiftKeyboardOctave(delta);
    },
  });

  // Key changes ask first (see KeyChange); nothing to move: the key just changes.
  const askKey = (to: MusicalKey) => {
    const p = session.store.getState();
    if (to.root === p.root && to.scale === p.scale) {
      setPending(null);
      return;
    }
    const plan = songMovePlan(p);
    if (plan.moving.length === 0 && plan.samplers.length === 0) {
      setPending(null);
      session.accepted(setKey(session.store, to.root, to.scale));
      return;
    }
    setPending(to);
  };
  const shownRoot = pending?.root ?? root;
  const shownScale = pending?.scale ?? scale;
  const rootOptions = useMemo(() => ROOT_NAMES.map((_, i) => ({ value: String(i), label: keyRootName(i, shownScale) })), [shownScale]);

  const assistTip = !assist
    ? 'Musical Assist is off: the keyboard is chromatic and plays exactly the key you press.'
    : isSampler
      ? `Musical Assist is on, but ${trackName} plays a recording, which Assist never re-pitches: every key plays exactly as pressed, and the Root Note key plays it at its own pitch. The dots show the notes of ${keyLabel(root, scale)}.`
      : `Musical Assist is on: every key plays a note from ${keyLabel(root, scale)}. Keys outside the key (dimmed) play the nearest in-key note.`;
  // One short line that fits the column whole (the tip says more, e.g. that the dots still show the key).
  const assistNote = isDrums
    ? `${trackName}: keys play the kit sounds.`
    : !assist
      ? 'Every key plays as pressed'
      : isSampler
        ? 'Recordings play as pressed'
        : `Snapping to ${keyLabel(root, scale)}`;

  const keyName = keyLabel(root, scale);
  // Simple hides the arpeggiator strip; a part whose arpeggiator is on still says so.
  const arpNote = !advanced && arpOn ? 'Arpeggiator on (settings in Advanced)' : null;
  // Musical Assist does nothing for drums: the switch is not shown for a kit.
  const assistSwitch = isDrums ? null : (
    <Tooltip tip={assistTip} detail="Recorded notes follow the same rule. Recordings (sampler parts) are never re-pitched by Assist.">
      <div>
        <Switch checked={assist} onChange={(on) => session.accepted(setAssist(session.store, on))} label="Musical Assist" onText="IN KEY" offText="CHROMATIC" tone="teal" size="sm" />
      </div>
    </Tooltip>
  );
  const foldKey = (
    <IconButton
      icon={collapsed ? 'chevronUp' : 'chevronDown'}
      label={collapsed ? 'Show the keyboard' : 'Hide the keyboard'}
      tip={collapsed ? 'Show the on-screen keyboard.' : 'Fold the keyboard away to give this view more room. The computer keys still play. Each view remembers its choice.'}
      size="sm"
      variant="ghost"
      aria-expanded={!collapsed}
      onClick={() => setKeyboardCollapsedFor(view, !collapsed)}
      className={styles.fold}
    />
  );

  if (collapsed) {
    return (
      <section ref={stripRef} className={styles.strip} data-collapsed="" aria-label="Keyboard">
        {foldKey}
        <span className={styles.foldedLabel}>Keyboard</span>
        <span className={styles.foldedNote}>
          {isDrums ? `${trackName}: computer keys play the kit sounds.` : `Computer keys play ${trackName}. ${assist ? `Key: ${keyName}.` : 'Chromatic.'}`}
        </span>
        {props.children}
      </section>
    );
  }

  return (
    <section ref={stripRef} className={styles.strip} aria-label="Keyboard">
      {foldKey}
      {isDrums ? (
        <div className={styles.octave} data-kit="">
          <div className={styles.octLabel}>
            <span className={`${styles.octValue} mono`}>KIT</span>
            <span className={styles.octCaption}>16 sounds</span>
          </div>
        </div>
      ) : (
        <div className={styles.octave}>
          <IconButton icon="octaveDown" label="Octave down (Z)" size="sm" onClick={() => shiftKeyboardOctave(-1)} disabled={octave <= OCTAVE_RANGE.min} />
          <div className={styles.octLabel}>
            <span className={`${styles.octValue} mono`}>{noteName(baseNote)}</span>
            <span className={styles.octCaption}>lowest key</span>
          </div>
          <IconButton icon="octaveUp" label="Octave up (X)" size="sm" onClick={() => shiftKeyboardOctave(1)} disabled={octave >= OCTAVE_RANGE.max} />
          <Tooltip tip="Put the lowest key back on C4.">
            <button type="button" className={styles.reset} onClick={() => setKeyboardOctave(4)} aria-label="Reset octave to C4">
              <span aria-hidden="true">↺</span> C4
            </button>
          </Tooltip>
        </div>
      )}

      <div ref={keysRef} className={styles.keys}>
        {isDrums ? (
          <MiniKeyboard
            variant="kit"
            kitLayout="row"
            kitNames={kitNames}
            baseNote={KIT_BASE_NOTE}
            onNoteOn={onNoteOn}
            onNoteOff={onNoteOff}
            activeNotes={active}
            keyLabels={keyLabels}
            height={KEYS_HEIGHT}
            fit
            keyMaxWidth={KIT_KEY_MAX_PX}
            label={`Keyboard playing ${trackName}: 16 kit sounds`}
          />
        ) : (
          <MiniKeyboard
            baseNote={baseNote}
            onNoteOn={onNoteOn}
            onNoteOff={onNoteOff}
            activeNotes={active}
            scaleMask={mask}
            keyLabels={keyLabels}
            rootPc={root}
            pitchNames={pitchNames}
            noteNames="above"
            keys={keyCount}
            height={KEYS_HEIGHT}
            fit
            keyMaxWidth={KEY_MAX_PX}
            label={`Keyboard playing ${trackName}`}
          />
        )}
      </div>

      <div className={styles.assist}>
        {advanced ? (
          <div
            ref={keyRowRef}
            className={styles.keyRow}
            onKeyDown={(e) => {
              // While the question is open, Tab from the Scale picker (the last one) goes into it.
              if (!pending || e.key !== 'Tab' || e.shiftKey || e.target !== keyRowRef.current?.querySelectorAll('select')[1]) return;
              const first = document.getElementById(KEY_CHANGE_ID)?.querySelector<HTMLElement>('input, button');
              if (!first) return;
              e.preventDefault();
              first.focus();
            }}
          >
            <Select
              label="Key"
              layout="inline"
              size="sm"
              value={String(shownRoot)}
              options={rootOptions}
              onChange={(v) => askKey({ root: Number(v), scale: shownScale })}
              width={60}
              tip="The home note of the project. Notes pads and Musical Assist use it; changing it offers to move the song too."
            />
            <Select
              label="Scale"
              hideLabel
              size="sm"
              value={shownScale}
              options={SCALE_OPTIONS}
              onChange={(v) => askKey({ root: shownRoot, scale: v as ScaleId })}
              width={132}
              tip="Which notes belong to the key. Changing it offers to move the song too."
            />
          </div>
        ) : (
          // Plain text (not a tab stop: it does nothing); the pointer still gets the explanation.
          <Tooltip tip={`The project's key is ${keyName}. The Notes pads and Musical Assist use it.`} detail="Advanced shows the key and scale pickers.">
            <p className={styles.keySummary}>
              Key: <strong>{keyName}</strong>
            </p>
          </Tooltip>
        )}
        {assistSwitch}
        <p className={styles.assistNote} aria-live="polite">
          {arpNote ?? assistNote}
        </p>
      </div>
      {advanced && <ArpStrip trackId={trackId} stripRef={stripRef} />}
      {advanced && pending && <KeyChange pending={pending} anchor={keyRowRef.current} onDone={() => setPending(null)} />}
      {props.children}
    </section>
  );
}
