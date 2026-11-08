/**
 * Shape, Simple mode: the selected part's sound in two plain blocks.
 *
 *   [ Instrument card: icon, type, sound, Change instrument ]
 *   [ Sound: 3–4 knobs for this instrument, Edit sound       ]
 *   [ Big knobs: the six macros, large, with a caption      ]
 *
 * The part's effects (cards, chain, Add effect) are under "Show every
 * setting" (Advanced): the big knobs already turn what the effects do, so
 * Simple shows each control once.
 *
 * Every control edits the real project through the session and commands
 * (the same edits as the Advanced view), so undo, performance recording and
 * the take lock behave exactly as there. Edit sound and the header open
 * every setting in Advanced.
 *
 * A big knob whose settings are gone or not heard (macroReach) says "Moves
 * nothing here" and is unavailable; Reset big knobs gives each one back what
 * the part's sound designs it to move.
 *
 * Every part shares one SimpleShape (no remount per part): per-part local
 * state (the sound browser) closes on a part switch.
 */
import { memo, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Button, Icon, Knob, Panel, newGestureId, type IconName, type KnobSize } from '../../../ui/components';
import { useElementSize } from '../../../ui/hooks/useElementSize';
import { builtinSampleInfo, kitInfo, presetInfo } from '../../../content/catalog';
import { MACRO_IDS, type Id, type InstrumentKind, type MacroId } from '../../../project/types';
import { shallowEqual } from '../../../state/store';
import { session, useProject } from '../../instance';
import { INSTRUMENT_LABEL, soundName } from '../../labels';
import { MACRO_SPECS, macroHomeNote, macroPlainDefault, macroSpecFor } from '../../macros';
import { SoundBrowser } from '../SoundBrowser';
import { resetBigKnobs } from './bigKnobs';
import { bigKnobReach, offCaption, offSentence } from './bigKnobReach';
import { useKnobExtras } from './knobExtras';
import { MACRO_CAPTION, macroDetail, useMacroRows } from './MacroColumn';
import { setAdvancedTab, useMediaQuery } from './shapeLayout';
import { useAdvancedSwitch, useEditLock } from './shared';
import { SoundCard } from './SoundCard';
import { RecordAudio } from '../sampler/RecordAudio';
import styles from './SimpleShape.module.css';

export { resetBigKnobs };

/** Switch to Advanced with the part's instrument column in view (its tab on a short window) and its first control focused. */
export function showInstrumentInAdvanced(toAdvanced: () => void): void {
  setAdvancedTab('instrument');
  toAdvanced();
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const col = document.getElementById('shape-col-instrument');
      col?.scrollIntoView({ block: 'nearest' });
      col?.querySelector<HTMLElement>('[role="slider"]:not([aria-disabled="true"]), button:not([disabled])')?.focus({ preventScroll: true });
    }),
  );
}

/* ------------------------------------------------------------------ */
/* Instrument card                                                     */
/* ------------------------------------------------------------------ */

export const KIND_ICON: Record<InstrumentKind, IconName> = { drums: 'drum', bass: 'wave', poly: 'keys', sampler: 'mic' };

interface InstInfo {
  kind: InstrumentKind;
  sound: string;
  description: string;
  kitId: string | null;
}

function useInstInfo(trackId: Id): InstInfo | null {
  return useProject<InstInfo | null>((p) => {
    const t = p.tracks.find((x) => x.id === trackId);
    if (!t) return null;
    const inst = t.instrument;
    const description =
      inst.kind === 'drums'
        ? (kitInfo(inst.kitId)?.description ?? '')
        : inst.kind === 'sampler'
          ? inst.sampleId
            ? (builtinSampleInfo(inst.sampleId)?.description ?? 'A recording, played at its own pitch.')
            : 'No recording yet: choose one or import your own.'
          : (presetInfo(inst.presetId)?.description ?? '');
    return { kind: inst.kind, sound: soundName(p, inst), description, kitId: inst.kind === 'drums' ? inst.kitId : null };
  }, shallowEqual);
}

function InstrumentCard(props: { trackId: Id; info: InstInfo; children?: ReactNode }) {
  const { trackId, info, children } = props;
  const [open, setOpen] = useState(false);
  const headId = useId();
  // A part switch closes the sound browser (it was opened for the part left).
  useEffect(() => setOpen(false), [trackId]);
  return (
    <section className={styles.inst} aria-labelledby={headId}>
      <span className={styles.instIcon} aria-hidden="true">
        <Icon name={KIND_ICON[info.kind]} size={24} />
      </span>
      <div className={styles.instText}>
        <h2 id={headId} className={styles.instType}>
          Instrument <span aria-hidden="true">·</span> {INSTRUMENT_LABEL[info.kind]}
        </h2>
        <div className={styles.instSound}>{info.sound}</div>
        {info.description && <div className={styles.instDesc}>{info.description}</div>}
      </div>
      <Button
        id="simple-change-instrument"
        className={styles.big}
        variant="primary"
        icon="search"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        tip="Choose a different drum kit, synth sound or recording for this part. Undo brings the old one back."
      >
        Change instrument
      </Button>
      <SoundBrowser open={open} trackId={trackId} onClose={() => setOpen(false)} />
      {children}
      {info.kind === 'sampler' && (
        // Record your voice or an instrument straight into this part (same control as in Advanced).
        <div className={styles.instRecord}>
          <RecordAudio trackId={trackId} />
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Big knobs                                                           */
/* ------------------------------------------------------------------ */

interface MacroState {
  value: number;
  home: number;
  /** Moves nothing heard (what it moved is gone or not heard): disabled. */
  inert: boolean;
  /** Waits for switched-off effects (their names, joined): still set-able; turning them on makes it heard. */
  off: string;
}

function useMacroState(trackId: Id, macro: MacroId): MacroState {
  return useProject<MacroState>((p) => {
    const t = p.tracks.find((x) => x.id === trackId);
    const r = t ? bigKnobReach(p, trackId, macro) : { reach: 'none' as const, off: [] };
    return {
      value: t?.macros[macro] ?? 0,
      home: macroSpecFor(t, macro).default,
      inert: r.reach === 'none',
      off: r.reach === 'off' ? r.off.join('\u0000') : '',
    };
  }, shallowEqual);
}

/** One big knob with its plain caption (also the Song screen's Sound panel's). */
export const MacroTile = memo(function MacroTile(props: { trackId: Id; macro: MacroId; size: KnobSize; idBase?: string }) {
  const { trackId, macro, size, idBase = 'shape-macro' } = props;
  const base = MACRO_SPECS[macro];
  const st = useMacroState(trackId, macro);
  const rows = useMacroRows(trackId, macro);
  const spec = st.home === base.default ? base : { ...base, default: st.home };
  const id = `${idBase}-${macro}`;
  useKnobExtras(id, { onAltReset: st.inert ? undefined : () => session.setMacro(trackId, macro, macroPlainDefault(macro), newGestureId('knob-reset')) });
  const off = st.off ? st.off.split('\u0000') : null;
  return (
    <div className={styles.macro} role="group" aria-label={`${base.label} big knob`} data-macro={macro} data-inert={st.inert || undefined} data-off={off ? true : undefined}>
      <Knob
        spec={spec}
        value={st.value}
        size={size}
        id={id}
        disabled={st.inert}
        tip={
          st.inert
            ? `${base.label} moves nothing here: what it moved is gone or not heard. “Reset big knobs” gives it back what this sound is designed to move.`
            : off
              ? `${offSentence(off, base.label)} You can still set it now.`
              : base.tip
        }
        detail={[macroDetail(rows), macroHomeNote(macro, st.home)].filter(Boolean).join(' ')}
        onChange={(v, info) => session.setMacro(trackId, macro, v, info.gesture)}
      />
      <div className={styles.macroCaption} data-inert={st.inert || off ? true : undefined}>
        {st.inert ? 'Moves nothing here' : off ? offCaption(off) : MACRO_CAPTION[macro]}
      </div>
    </div>
  );
});

/** Big knobs grow to 'xl' when their grid has room for three of that size across and two rows. */
const XL_MIN_WIDTH = 3 * 120 + 2 * 8;
const XL_MIN_HEIGHT = 2 * 178 + 10;
/** …or for all six of that size in one row (the panel across the view, on a laptop). */
const XL_ROW_MIN_WIDTH = 6 * 120 + 5 * 8;
const XL_ROW_MIN_HEIGHT = 178;
/**
 * The Big knobs panel with its 'lg' knobs in two rows of three needs this
 * much height (measured: two rows of 124 px tiles and the 8 px gap between
 * them, and 56 px of header and padding). With less room under the
 * instrument card (a sampler's recording controls, or Percussion's longer
 * names, on a short window), the six knobs go into one row at 'md' instead,
 * so nothing scrolls.
 */
const LG_PANEL_HEIGHT = 124 + 8 + 124 + 56;
/** A grid this wide holds the six 'lg' knobs in one row (the 880 px container query): one row of height is enough. */
const LG_ONE_ROW_WIDTH = 880;
const LG_ONE_ROW_HEIGHT = 124 + 56;
/** Six 'md' tiles in a row need at least this much width. */
const ROW_MIN_WIDTH = 6 * 84 + 5 * 6;

function MacroPanel(props: { trackId: Id; room: number }) {
  const { trackId, room } = props;
  const gridRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(gridRef);
  const locked = useEditLock() !== null;
  const xlGrid = size.width >= XL_MIN_WIDTH && size.height >= XL_MIN_HEIGHT;
  const xlRow = !xlGrid && size.width >= XL_ROW_MIN_WIDTH && size.height >= XL_ROW_MIN_HEIGHT;
  const xl = xlGrid || xlRow;
  const lgHeight = size.width >= LG_ONE_ROW_WIDTH ? LG_ONE_ROW_HEIGHT : LG_PANEL_HEIGHT;
  const row = !xl && room > 0 && room < lgHeight && size.width >= ROW_MIN_WIDTH;
  return (
    <Panel
      title="Big knobs"
      subtitle={<span className={styles.panelNote}>Each turns several settings at once</span>}
      dense
      className={styles.macroPanel}
      bodyClassName={styles.macroBody}
      actions={
        <Button
          id="simple-reset-big-knobs"
          size="sm"
          variant="ghost"
          icon="undo"
          disabled={locked}
          onClick={() => resetBigKnobs(trackId)}
          tip={locked ? 'Big knob assignments cannot change while a performance records.' : 'Give every big knob back what this sound is designed to move (after effects were removed or mappings changed).'}
          detail="Where each knob sits stays as it is; double-click a big knob to return it to this sound’s position. Undo brings your mappings back."
        >
          Reset big knobs
        </Button>
      }
    >
      <div ref={gridRef} className={styles.macros} data-xl={xl || undefined} data-xl-row={xlRow || undefined} data-row={row || undefined}>
        {MACRO_IDS.map((m) => (
          <MacroTile key={m} trackId={trackId} macro={m} size={xl ? 'xl' : row ? 'md' : 'lg'} />
        ))}
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* View                                                                */
/* ------------------------------------------------------------------ */

/**
 * The height a column leaves under its first child (the instrument card), in
 * px: what the Big knobs panel can have without the column scrolling. 0 until
 * measured. Follows both sizes (ResizeObserver).
 */
function useRoomBelowFirst(ref: RefObject<HTMLElement | null>): number {
  const [room, setRoom] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const first = el.firstElementChild as HTMLElement | null;
      const gap = parseFloat(getComputedStyle(el).rowGap) || 0;
      const r = Math.max(0, Math.floor(el.clientHeight - (first ? first.offsetHeight + gap : 0)));
      setRoom((x) => (Math.abs(x - r) < 2 ? x : r));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const first = el.firstElementChild;
    if (first) ro.observe(first);
    measure();
    return () => ro.disconnect();
  }, [ref]);
  return room;
}

export function SimpleShape(props: { trackId: Id }) {
  const { trackId } = props;
  const info = useInstInfo(trackId);
  const { toAdvanced } = useAdvancedSwitch();
  // Room for medium Sound knobs on a tall window; small ones keep 1366 × 768 free of scrolling.
  const tall = useMediaQuery('(min-height: 900px)');
  const leftRef = useRef<HTMLDivElement>(null);
  const room = useRoomBelowFirst(leftRef);
  return (
    <div className={styles.simple}>
      <div ref={leftRef} className={styles.left}>
        {info && (
          <InstrumentCard trackId={trackId} info={info}>
            <SoundCard trackId={trackId} kind={info.kind} kitId={info.kitId ?? undefined} size={tall ? 'md' : 'sm'} onEditSound={() => showInstrumentInAdvanced(toAdvanced)} />
          </InstrumentCard>
        )}
        <MacroPanel trackId={trackId} room={room} />
      </div>
    </div>
  );
}
