/**
 * The selected part (right of the pads): Mute, Solo and Volume at the top
 * (Pan in Advanced), the instrument card with Change instrument, the six
 * macros with a one-line caption each, Variation and Keep pattern, and (where
 * there is room) a picture of the selected clip.
 *
 * Variation acts on the part's selected clip, the one ringed on the pads
 * (see selection.ts). Its main key makes a subtle variation; its menu has
 * Subtle, Bold and Back to original. Every press varies the clip's original
 * notes (kept for this session from before the first press), so pressing
 * again explores other variations instead of piling changes on changes; an
 * edit made some other way (Steps, a recording) makes the clip's new notes
 * the original. Keep pattern stops Variation changing the part.
 *
 * While a performance take records, Variation and Keep pattern are
 * unavailable and say why. On a big screen the big knobs grow (size 'xl')
 * when the panel has the room; a panel too short for everything shows a fade
 * at its bottom edge while more is below.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { Button, ClipSketch, Icon, Knob, Tooltip, type IconName } from '../../ui/components';
import { CHANNEL_PARAMS, specById } from '../../project/params';
import { moduleId } from '../../project/factory';
import { describeMacro } from '../../project/resolve';
import { MACRO_IDS, TICKS_PER_BAR, type Clip, type Id, type Instrument, type MacroId, type Note } from '../../project/types';
import { INTENSITY, applyVariation, setClipNotes, setLocked } from '../../state/commands';
import { variationSeed } from '../../music/variation';
import { setView, slotFor, uiStore } from '../../state/uiStore';
import { session, useProject, useUi } from '../instance';
import { notify, runtimeStore } from '../runtime';
import { barsLabel, soundName } from '../labels';
import { MACRO_CAPTION, MACRO_SPECS } from '../macros';
import { LOCKED_TEXT, MenuHeader, MenuItem, MenuSeparator, Popover, anchorFromElement, useEditLocked, type MenuAnchor } from './ClipMenu';
import { SoundBrowser } from './SoundBrowser';
import styles from './PartPanel.module.css';

const LEVEL_SPEC = specById(CHANNEL_PARAMS, 'level')!;
const PAN_SPEC = specById(CHANNEL_PARAMS, 'pan')!;

/** The instrument type in plain words, with its icon. */
const INSTRUMENT_TYPE: Record<Instrument['kind'], { name: string; icon: IconName }> = {
  drums: { name: 'Drum kit', icon: 'drum' },
  bass: { name: 'Bass synth', icon: 'wave' },
  poly: { name: 'Synth', icon: 'keys' },
  sampler: { name: 'Sampler', icon: 'mic' },
};

/** The big knobs grow to 'xl' when the panel's content is at least this wide (three 104 px knobs) and the panel this tall. */
const XL_MIN_WIDTH = 324;
const XL_MIN_HEIGHT = 820;

function MacroKnob(props: { trackId: string; macro: MacroId; size: 'lg' | 'xl' }) {
  const { trackId, macro, size } = props;
  const value = useProject((p) => p.tracks.find((t) => t.id === trackId)?.macros[macro] ?? 0);
  const targets = useProject((p) => {
    const t = p.tracks.find((x) => x.id === trackId);
    return t ? describeMacro(p, t, macro).map((d) => d.label).join(', ') : '';
  });
  const spec = MACRO_SPECS[macro];
  // The detail lists what this part's macro really moves (its live mappings), never a fixed description.
  const moves = targets ? `Moves: ${targets}.` : 'No mappings: this macro does nothing.';
  return (
    <div className={styles.macro}>
      <Knob
        spec={spec}
        value={value}
        size={size}
        onChange={(v, info) => session.setMacro(trackId, macro, v, info.gesture)}
        tip={spec.tip}
        detail={`${moves} ${spec.detail ? `${spec.detail} ` : ''}Shape shows and edits what it moves.`}
        id={`macro-${macro}`}
      />
      <span className={styles.macroCaption} aria-hidden="true">
        {targets ? MACRO_CAPTION[macro] : 'Moves nothing yet'}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Variation                                                           */
/* ------------------------------------------------------------------ */

/**
 * A clip's original notes for Variation, kept for this session: the notes
 * it had before its first press, and the note sets the presses made from
 * them. While the clip holds one of those (Undo and Redo bring them back
 * too), presses vary the original and Back to original returns to it. Any
 * other notes (an edit in Steps, a recording, a paste) become the original.
 */
interface KeptOriginal {
  notes: readonly Note[];
  sig: string;
  made: Set<string>;
}
const originals = new Map<Id, KeptOriginal>();

/** The notes' content as one string (ids left out: Undo can give the same notes new ids). */
function notesSig(notes: readonly Note[]): string {
  return notes
    .map((n) => `${n.tick},${n.pitch},${n.duration},${n.velocity}`)
    .sort()
    .join(';');
}

/** The original a press varies (taking the clip's notes as the original when they are not from Variation). */
function originalFor(clip: Clip): KeptOriginal {
  const sig = notesSig(clip.notes);
  const k = originals.get(clip.id);
  if (k && (k.sig === sig || k.made.has(sig))) return k;
  const fresh: KeptOriginal = { notes: clip.notes, sig, made: new Set() };
  originals.set(clip.id, fresh);
  return fresh;
}

/** Whether Back to original would change the clip: it holds notes a press made from its kept original. */
function canRestore(clip: Clip | null): boolean {
  if (!clip) return false;
  const k = originals.get(clip.id);
  if (!k) return false;
  const sig = notesSig(clip.notes);
  return sig !== k.sig && k.made.has(sig);
}

/** The selected part and its selected clip (the one the pad ring marks), for Variation. */
function selectedClip(trackId: Id) {
  const p = session.store.getState();
  const track = p.tracks.find((t) => t.id === trackId) ?? null;
  const slot = slotFor(uiStore.getState(), trackId);
  return { p, track, slot, clip: track?.clips[slot] ?? null };
}

type Strength = 'subtle' | 'bold';

function vary(trackId: Id, strength: Strength): void {
  const { p, track, slot, clip } = selectedClip(trackId);
  if (!track) return;
  if (!clip) {
    notify(`Slot ${slot + 1} of ${track.name} is empty. Select a clip with notes: Variation changes a pattern.`, 'warn');
    return;
  }
  const original = originalFor(clip);
  const generation = (clip.variation?.generation ?? 0) + 1;
  const seed = variationSeed(p.seed, clip.id, generation);
  const r = applyVariation(session.store, trackId, slot, seed, INTENSITY[strength], { from: original.notes });
  if (!session.accepted(r)) return;
  const after = session.store.getState().tracks.find((t) => t.id === trackId)?.clips[slot]?.notes ?? clip.notes;
  original.made.add(notesSig(after));
  const what = `${track.name} · ${clip.name}`;
  if (r.summary === 'No change') {
    notify(`Variation on ${what}: no change this time (a short clip has few notes to vary). Press again for another.`, 'info', 'undo');
    return;
  }
  // Varying a clip other than the one playing is silent until it is launched: say so
  // (unless it is already queued to start).
  const rt = runtimeStore.getState();
  const tr = rt.tracks[trackId];
  const playingSlot = rt.playing && tr?.queued?.slot !== slot ? (tr?.playingSlot ?? null) : null;
  const playingClip = playingSlot !== null && playingSlot !== slot ? track.clips[playingSlot] : null;
  const elsewhere = playingClip ? ` ${playingClip.name} is playing: launch ${clip.name} to hear it.` : '';
  const head = strength === 'bold' ? `Bold variation on ${what}` : `Variation on ${what}`;
  notify(`${head}: ${r.summary ?? 'changed'}.${elsewhere}`, 'info', 'undo');
}

function backToOriginal(trackId: Id): void {
  const { track, slot, clip } = selectedClip(trackId);
  if (!track || !clip || !canRestore(clip)) return;
  const original = originals.get(clip.id)!;
  if (session.accepted(setClipNotes(session.store, trackId, slot, original.notes, 'Back to original', { variation: null }))) {
    notify(`${track.name} · ${clip.name} is back to its original notes.`, 'info', 'undo');
  }
}

/** Variation as a split key: the main press makes a subtle variation; its menu has Subtle, Bold and Back to original. */
function VariationKey({ trackId, partName, keep, locked }: { trackId: Id; partName: string; keep: boolean; locked: boolean }) {
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const slot = useUi((s) => slotFor(s, trackId));
  const shown = useProject((p) => p.tracks.find((t) => t.id === trackId)?.clips[slot] ?? null);
  const off = keep || locked;
  const why = locked ? `${LOCKED_TEXT}.` : `${partName} keeps its pattern: Variation will not change it. Turn Keep pattern off to vary it.`;
  return (
    <div className={styles.split} role="group" aria-label="Variation choices">
      <Button
        icon="dice"
        onClick={() => vary(trackId, 'subtle')}
        disabled={off}
        tip={off ? why : 'A subtle variation of the selected clip (the one ringed on the pads): a few notes change. Press again for another one; Undo brings the last one back.'}
        detail="Each press varies the clip's original notes, so it never drifts far. Deterministic: the seed is stored, so saved projects and exports reproduce it."
        className={styles.splitMain}
      >
        Variation
      </Button>
      <Tooltip name="More Variation choices" tip={off ? why : 'Subtle, Bold, or Back to original.'}>
        <button
          ref={toggleRef}
          type="button"
          className={styles.splitMore}
          aria-label="More Variation choices"
          aria-haspopup="menu"
          aria-expanded={!!menu}
          disabled={off}
          onClick={() => setMenu(menu ? null : anchorFromElement(toggleRef.current))}
        >
          <Icon name="chevronDown" size={14} />
        </button>
      </Tooltip>
      {menu && (
        <Popover anchor={menu} label="Variation" align="end" onClose={() => setMenu(null)} returnFocus={toggleRef.current} ignore={toggleRef.current}>
          <MenuHeader eyebrow={partName} title={shown ? `Vary ${shown.name}` : 'Variation'} />
          <MenuItem
            icon="dice"
            hint="a few notes"
            onSelect={() => {
              setMenu(null);
              vary(trackId, 'subtle');
            }}
          >
            Subtle variation
          </MenuItem>
          <MenuItem
            icon="sparkle"
            hint="many notes"
            onSelect={() => {
              setMenu(null);
              vary(trackId, 'bold');
            }}
          >
            Bold variation
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon="undo"
            disabled={!canRestore(shown)}
            disabledReason={shown ? 'Already the original' : 'No clip selected'}
            onSelect={() => {
              setMenu(null);
              backToOriginal(trackId);
            }}
          >
            Back to original
          </MenuItem>
        </Popover>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The selected clip, where there is room                              */
/* ------------------------------------------------------------------ */

function SelectedClip({ trackId }: { trackId: Id }) {
  const slot = useUi((s) => slotFor(s, trackId));
  const info = useProject(
    (p) => {
      const t = p.tracks.find((x) => x.id === trackId);
      const clip = t?.clips[slot] ?? null;
      return clip && t ? { clip, scene: p.scenes[slot]?.name ?? `Row ${slot + 1}`, drums: t.instrument.kind === 'drums' } : null;
    },
    (a, b) => a === b || (!!a && !!b && a.clip === b.clip && a.scene === b.scene && a.drums === b.drums),
  );
  if (!info) return <div className={styles.clipView} />;
  const { clip } = info;
  return (
    <div className={styles.clipView}>
      <div className={styles.clipCard}>
        <div className={styles.clipHead}>
          <span className={styles.clipName}>{clip.name}</span>
          <span className={styles.clipWhere}>
            {info.scene} · {barsLabel(clip.bars)}
          </span>
        </div>
        <div className={styles.clipSketch} aria-hidden="true">
          <ClipSketch notes={clip.notes} lengthTicks={clip.bars * TICKS_PER_BAR} kind={info.drums ? 'drums' : 'notes'} />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

export function PartPanel() {
  const trackId = useUi((s) => s.selectedTrackId);
  const advanced = useUi((s) => s.uiMode === 'advanced');
  const header = useProject(
    (p) => {
      const t = p.tracks.find((x) => x.id === trackId);
      return t ? { name: t.name, sound: soundName(p, t.instrument), kind: t.instrument.kind, locked: t.locked, mute: t.mute, solo: t.solo, index: p.tracks.indexOf(t) } : null;
    },
    (a, b) =>
      a === b ||
      (!!a && !!b && a.name === b.name && a.sound === b.sound && a.kind === b.kind && a.locked === b.locked && a.mute === b.mute && a.solo === b.solo && a.index === b.index),
  );
  const anySolo = useProject((p) => p.tracks.some((t) => t.solo));
  const level = useProject((p) => p.patch.modules.find((m) => m.id === moduleId.channel(trackId))?.params.level ?? LEVEL_SPEC.default);
  const pan = useProject((p) => p.patch.modules.find((m) => m.id === moduleId.channel(trackId))?.params.pan ?? PAN_SPEC.default);
  const takeLocked = useEditLocked();
  const [soundOpen, setSoundOpen] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const [xl, setXl] = useState(false);

  // Big knobs grow with the panel (its own size, not the window's): 'xl' when three of them fit side by side and the panel is tall.
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const check = () => {
      const cs = getComputedStyle(el);
      const inner = el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
      const big = inner >= XL_MIN_WIDTH && el.clientHeight >= XL_MIN_HEIGHT && cs.overflowY !== 'visible';
      setXl((v) => (v === big ? v : big));
    };
    check();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [header !== null]);

  // A fade over the bottom edge while more of the panel is below it.
  useLayoutEffect(() => {
    const el = panelRef.current;
    const frame = el?.parentElement;
    if (!el || !frame) return;
    const check = () => {
      // More than the panel's own bottom padding is out of view.
      const pad = parseFloat(getComputedStyle(el).paddingBottom) || 0;
      const more = el.scrollHeight - el.clientHeight - el.scrollTop > pad + 2;
      if (more) frame.dataset.fade = '';
      else delete frame.dataset.fade;
    };
    check();
    el.addEventListener('scroll', check, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(check) : null;
    ro?.observe(el);
    for (const c of el.children) ro?.observe(c);
    return () => {
      el.removeEventListener('scroll', check);
      ro?.disconnect();
    };
  });

  if (!header) return null;
  const type = INSTRUMENT_TYPE[header.kind];
  const status = header.mute ? 'Muted' : anySolo && !header.solo ? 'Not soloed' : header.solo ? 'Solo' : null;
  const keepTip = takeLocked
    ? `${LOCKED_TEXT}.`
    : header.locked
      ? `${header.name} keeps its pattern: Variation will not change it.`
      : `Keep ${header.name}'s pattern so Variation never changes it.`;
  return (
    <div className={styles.frame}>
      <section ref={panelRef} className={styles.panel} aria-labelledby="part-title" data-xl={xl || undefined}>
        <div className={styles.head}>
          <div className={`${styles.num} mono`}>{header.index + 1}</div>
          <div className={styles.titles}>
            <h2 id="part-title" className={styles.title}>
              {header.name}
            </h2>
            {/* Its line is always there (empty when nothing is muted or soloed), so Mute and Solo never move the panel. */}
            <span className={styles.status} data-status={status === null ? undefined : status === 'Solo' ? 'solo' : status === 'Muted' ? 'muted' : 'quiet'}>
              {status}
            </span>
          </div>
          <Button size="sm" variant="ghost" icon="sliders" onClick={() => setView('shape')} tip="Open the Shape view: every sound setting and effect of this part.">
            Shape
          </Button>
        </div>

        <div className={styles.mix} role="group" aria-label={`${header.name}: mute, solo and volume`}>
          <div className={styles.mixKeys}>
            <Tooltip tip={header.mute ? `Unmute ${header.name}.` : `Silence ${header.name} (it keeps playing in time).`} detail="M mutes the selected part.">
              <button type="button" className={styles.toggle} data-kind="mute" aria-pressed={header.mute} aria-keyshortcuts="M" onClick={() => session.setMute(trackId, !header.mute)}>
                <Icon name="speaker" size={16} />
                <span>Mute</span>
              </button>
            </Tooltip>
            <Tooltip tip={header.solo ? `Stop soloing ${header.name}.` : `Hear only the soloed parts.`} detail="Solo has no key: S plays a note. M mutes the selected part.">
              <button type="button" className={styles.toggle} data-kind="solo" aria-pressed={header.solo} onClick={() => session.setSolo(trackId, !header.solo)}>
                <Icon name="headphones" size={16} />
                <span>Solo</span>
              </button>
            </Tooltip>
          </div>
          <Knob spec={LEVEL_SPEC} value={level} size="lg" label="Volume" onChange={(v, info) => session.setModuleParam(moduleId.channel(trackId), 'level', v, info.gesture)} className={styles.volume} />
          {advanced && <Knob spec={PAN_SPEC} value={pan} size="sm" onChange={(v, info) => session.setModuleParam(moduleId.channel(trackId), 'pan', v, info.gesture)} />}
        </div>

        <div className={styles.instrument}>
          <span className={styles.instrumentIcon} aria-hidden="true">
            <Icon name={type.icon} size={22} />
          </span>
          <div className={styles.instrumentText}>
            <span className={styles.instrumentType}>{type.name}</span>
            <span className={styles.instrumentSound}>{header.sound}</span>
          </div>
          <Button
            size="md"
            variant="primary"
            onClick={() => setSoundOpen(true)}
            aria-haspopup="dialog"
            aria-label={`Change instrument (now ${type.name}: ${header.sound})`}
            tip="Choose a different drum kit, synth sound or recording for this part. Undo brings the old one back."
            className={styles.change}
          >
            Change instrument
          </Button>
        </div>

        <div className={styles.macros} role="group" aria-label={`${header.name} macros`}>
          {MACRO_IDS.map((m) => (
            <MacroKnob key={m} trackId={trackId} macro={m} size={xl ? 'xl' : 'lg'} />
          ))}
        </div>

        <div className={styles.actions}>
          <VariationKey trackId={trackId} partName={header.name} keep={header.locked} locked={takeLocked} />
          <Tooltip tip={keepTip}>
            <Button
              icon={header.locked ? 'lock' : 'unlock'}
              variant="ghost"
              pressed={header.locked}
              disabled={takeLocked}
              onClick={() => session.accepted(setLocked(session.store, trackId, !header.locked))}
            >
              {header.locked ? 'Pattern kept' : 'Keep pattern'}
            </Button>
          </Tooltip>
        </div>
        <SelectedClip trackId={trackId} />
        <SoundBrowser open={soundOpen} trackId={trackId} onClose={() => setSoundOpen(false)} />
      </section>
      <div className={styles.fade} aria-hidden="true" />
    </div>
  );
}
