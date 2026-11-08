/**
 * The Sound panel of one instrument (EASY_SPEC §6): on the Song screen's
 * right, in place of LOOPS, opened by clicking an instrument's name.
 *
 *   [🎹 Chords ✎ (rename on click)          ✕]
 *   House Stab · a short, bright synth stab
 *   [ Change sound… ]
 *   (Volume)  [Mute] [Hear it alone]
 *   Tone   Space   Echo        the six big knobs, each with its plain caption
 *   Motion Drive   Pump
 *   Every setting ▸
 *
 * Every control is the real one: Change sound… is the Sound browser (Cancel
 * goes back to the sound as it was), Volume is the channel's level (the
 * same as the row's slider and Mix), Mute and Hear it alone are the part's
 * Mute and Solo, and the big knobs are Simple Shape's (session.setMacro, so
 * undo, performance takes and the take lock behave as there). Every setting
 * opens the Shape view on this instrument (in Simple the shell shows it as a
 * sheet over the song). ✕ (or Esc inside the panel) goes back to LOOPS; the
 * panel goes back by itself when its instrument is gone.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Button, Icon, IconButton, Knob, type KnobChangeInfo } from '../../../ui/components';
import { builtinSampleInfo, kitInfo, presetInfo } from '../../../content/catalog';
import { CHANNEL_PARAMS, specById } from '../../../project/params';
import { MACRO_IDS, type Id, type InstrumentKind } from '../../../project/types';
import * as cmd from '../../../state/commands';
import { shallowEqual } from '../../../state/store';
import { selectTrack, setView } from '../../../state/uiStore';
import { session, useProject, useUi } from '../../instance';
import { soundName } from '../../labels';
import { LOCKED_TEXT, useEditLocked } from '../ClipMenu';
import { channelController, channelOf, channelValue } from '../mix/mixState';
import { KIND_ICON, MacroTile } from '../shape/SimpleShape';
import { SoundBrowser } from '../SoundBrowser';
import { instrumentName } from './songHome';
import styles from './SoundPanel.module.css';

const LEVEL = specById(CHANNEL_PARAMS, 'level')!;

interface Info {
  name: string;
  kind: InstrumentKind;
  sound: string;
  description: string;
  mute: boolean;
  solo: boolean;
  /** Another instrument plays alone, so this one is not heard. */
  quiet: boolean;
  channel: Id | null;
  level: number;
  levelBy: string | null;
}

function useInfo(trackId: Id): Info | null {
  return useProject<Info | null>((p) => {
    const t = p.tracks.find((x) => x.id === trackId);
    if (!t) return null;
    const inst = t.instrument;
    const description =
      inst.kind === 'drums'
        ? (kitInfo(inst.kitId)?.description ?? '')
        : inst.kind === 'sampler'
          ? inst.sampleId
            ? (builtinSampleInfo(inst.sampleId)?.description ?? 'A recording, played at its own pitch.')
            : 'No recording yet: choose one, or record your own.'
          : (presetInfo(inst.presetId)?.description ?? '');
    return {
      // The picker's word for 2.4's default names (Lead → Melody) until renamed; the project keeps its names.
      // Renaming marks the part renamed, so typing "Lead" for Melody stores the mark and shows "Lead".
      name: instrumentName(t.name, t.role, t.renamed),
      kind: inst.kind,
      sound: soundName(p, inst),
      description,
      mute: t.mute,
      solo: t.solo,
      quiet: !t.solo && p.tracks.some((x) => x.solo),
      channel: channelOf(p, trackId),
      level: channelValue(p, trackId, 'level'),
      levelBy: channelController(p, trackId, 'level'),
    };
  }, shallowEqual);
}

/** The instrument's name; a click turns it into a field (Enter or leaving it keeps the name, Esc leaves it as it was). */
function NameField({ trackId, name, headId }: { trackId: Id; name: string; headId: string }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);
  const done = (keep: boolean) => {
    setEditing(false);
    const next = text.trim();
    if (keep && next && next !== name) session.accepted(cmd.renameTrack(session.store, trackId, next));
    requestAnimationFrame(() => buttonRef.current?.focus({ preventScroll: true }));
  };
  return (
    <h2 id={headId} className={styles.name}>
      {editing ? (
        <input
          ref={inputRef}
          className={styles.nameInput}
          value={text}
          maxLength={60}
          aria-label="Instrument name"
          onChange={(e) => setText(e.target.value)}
          onBlur={() => done(true)}
          onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              done(true);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setText(name);
              done(false);
            }
          }}
        />
      ) : (
        <button
          ref={buttonRef}
          type="button"
          className={styles.nameButton}
          aria-label={`${name} (click to rename)`}
          onClick={() => {
            setText(name);
            setEditing(true);
          }}
        >
          <span className={styles.nameText}>{name}</span>
          <Icon name="pencil" size={12} className={styles.nameEdit} />
        </button>
      )}
    </h2>
  );
}

export function SoundPanel({ trackId, onClose }: { trackId: Id; onClose(): void }) {
  const info = useInfo(trackId);
  const advanced = useUi((s) => s.uiMode === 'advanced');
  const locked = useEditLocked();
  const headId = useId();
  const [browsing, setBrowsing] = useState(false);
  // Another instrument: the browser was opened for the one left.
  useEffect(() => setBrowsing(false), [trackId]);
  // The instrument went (deleted, or an Undo took it away): back to LOOPS.
  const gone = info === null;
  useEffect(() => {
    if (gone) onClose();
  }, [gone, onClose]);
  if (!info) return null;
  const setLevel = (v: number, i: KnobChangeInfo) => {
    if (info.channel) session.setModuleParam(info.channel, 'level', v, i.gesture);
  };
  const everySetting = () => {
    selectTrack(trackId);
    setView('shape');
  };
  const status = info.mute ? `${info.name} is muted: you do not hear it.` : info.quiet ? `Another instrument plays alone: ${info.name} is not heard.` : info.solo ? `You hear ${info.name} alone.` : '';
  return (
    <aside
      className={styles.panel}
      aria-labelledby={headId}
      data-testid="sound-panel"
      data-sound-panel={trackId}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        if ((e.target as HTMLElement).closest('input, [role="dialog"], [role="menu"], [role="slider"]')) return;
        e.preventDefault();
        onClose();
      }}
    >
      <div className={styles.head}>
        <span className={styles.icon} aria-hidden="true">
          <Icon name={KIND_ICON[info.kind]} size={20} />
        </span>
        <NameField key={trackId} trackId={trackId} name={info.name} headId={headId} />
        <IconButton icon="close" label="Close the sound (back to the loops)" size="sm" variant="ghost" onClick={onClose} />
      </div>

      <section className={styles.sound} aria-label="Sound">
        <div className={styles.soundName}>{info.sound}</div>
        {info.description && <p className={styles.desc}>{info.description}</p>}
        <Button
          variant="primary"
          icon="search"
          aria-haspopup="dialog"
          disabled={locked}
          onClick={() => setBrowsing(true)}
          tip={locked ? `${LOCKED_TEXT}: the take keeps the sounds it started with.` : `Choose another sound for ${info.name}. Cancel goes back to this one, and so does Undo.`}
          className={styles.change}
        >
          Change sound…
        </Button>
      </section>

      <section className={styles.mix} aria-label={`${info.name}: volume, mute and hear it alone`}>
        <Knob
          spec={LEVEL}
          value={info.level}
          size="md"
          label="Volume"
          showValue={advanced}
          controlledBy={info.levelBy ?? undefined}
          disabled={!info.channel}
          onChange={setLevel}
          tip={`How loud ${info.name} is in the song.`}
          id={`sound-volume-${trackId}`}
        />
        <div className={styles.toggles}>
          <Button size="sm" icon="speaker" pressed={info.mute} tone="coral" onClick={() => session.setMute(trackId, !info.mute)} tip={info.mute ? `Hear ${info.name} again.` : `Silence ${info.name} (it keeps its place in the song).`}>
            Mute
          </Button>
          <Button size="sm" icon="headphones" pressed={info.solo} onClick={() => session.setSolo(trackId, !info.solo)} tip={info.solo ? 'Hear every instrument again.' : `Hear only ${info.name}.`}>
            Hear it alone
          </Button>
        </div>
      </section>
      <p className={styles.status} role="status">
        {status}
      </p>

      <section className={styles.knobs} aria-label="Big knobs">
        {MACRO_IDS.map((m) => (
          <MacroTile key={m} trackId={trackId} macro={m} size="md" idBase={`sound-macro-${trackId}`} />
        ))}
      </section>

      <Button variant="ghost" size="sm" icon="sliders" onClick={everySetting} tip={`Every setting and effect of ${info.name}.`} className={styles.every}>
        Every setting ▸
      </Button>
      <SoundBrowser open={browsing} trackId={trackId} onClose={() => setBrowsing(false)} />
    </aside>
  );
}
