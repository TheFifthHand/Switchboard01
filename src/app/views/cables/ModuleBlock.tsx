/**
 * A patch module drawn as a hardware block: name, short panel legend, an
 * On/Off (bypass) switch for effects and LFOs, and labelled sockets on its
 * edges — audio inputs left, outputs right, modulation inputs on the bottom
 * edge. Amber rings carry sound, teal rings carry modulation.
 */
import { memo, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Switch, Tooltip } from '../../../ui/components';
import { LFO_DIVISIONS, LFO_PARAMS, LFO_WAVES, readParam } from '../../../project/params';
import { MODULE_DEFS } from '../../../project/modules';
import type { Id } from '../../../project/types';
import * as cmd from '../../../state/commands';
import { selectModule } from '../../../state/uiStore';
import { session, useProject } from '../../instance';
import { soundName } from '../../labels';
import type { BlockGeom, SocketGeom } from './model';
import styles from './CablePanel.module.css';

export interface SocketUi {
  /** Socket a cable is being dragged from, or that is armed for click-to-connect. */
  anchorKey: string | null;
  armed: boolean;
  /** While a plug is in hand: sockets that would accept it. */
  compat: ReadonlySet<string> | null;
  hoverKey: string | null;
  focusKey: string | null;
  locked: boolean;
}

export interface SocketHandlers {
  down(e: ReactPointerEvent<HTMLButtonElement>, key: string): void;
  keyDown(e: ReactKeyboardEvent<HTMLButtonElement>, key: string): void;
  focus(key: string): void;
}

export interface SocketText {
  /** Full accessible name, e.g. "Filter Out, audio output, 1 cable: to Channel In". */
  aria: string;
}

function Socket(props: { s: SocketGeom; ui: SocketUi; handlers: SocketHandlers; aria: string; count: number }) {
  const { s, ui, handlers, aria, count } = props;
  const compat = ui.compat ? (ui.compat.has(s.key) ? 'yes' : 'no') : undefined;
  const anchor = ui.anchorKey === s.key;
  return (
    <button
      type="button"
      className={styles.socket}
      data-socket-key={s.key}
      data-kind={s.kind}
      data-side={s.side}
      data-dir={s.dir}
      data-compat={anchor ? undefined : compat}
      data-anchor={anchor || undefined}
      data-armed={(anchor && ui.armed) || undefined}
      data-hover={ui.hoverKey === s.key || undefined}
      data-used={count > 0 || undefined}
      aria-label={aria}
      aria-disabled={ui.locked || undefined}
      aria-keyshortcuts="Enter"
      tabIndex={ui.focusKey === s.key ? 0 : -1}
      style={{ left: s.rx, top: s.ry }}
      onPointerDown={(e) => handlers.down(e, s.key)}
      onKeyDown={(e) => handlers.keyDown(e, s.key)}
      onFocus={() => handlers.focus(s.key)}
    >
      <span className={styles.jack} aria-hidden="true" />
      <span className={styles.socketLabel} aria-hidden="true">
        {s.label}
      </span>
    </button>
  );
}

function InstrumentCaption({ trackId }: { trackId: Id }) {
  const text = useProject((p) => {
    const t = p.tracks.find((x) => x.id === trackId);
    return t ? soundName(p, t.instrument) : '';
  });
  return <span className={styles.caption}>{text}</span>;
}

const WAVE = LFO_PARAMS.find((x) => x.id === 'wave')!;
const RATE = LFO_PARAMS.find((x) => x.id === 'division')!;

function LfoCaption({ moduleId }: { moduleId: Id }) {
  const text = useProject((p) => {
    const m = p.patch.modules.find((x) => x.id === moduleId);
    if (!m) return '';
    const wave = LFO_WAVES[readParam(LFO_PARAMS, m.params, WAVE.id)] ?? '';
    const rate = LFO_DIVISIONS[readParam(LFO_PARAMS, m.params, RATE.id)] ?? '';
    return `${wave} · ${rate}`;
  });
  return <span className={styles.caption}>{text}</span>;
}

const CAPTION: Partial<Record<BlockGeom['type'], string>> = {
  master: 'Limiter · −1 dBFS ceiling',
};

const TITLE_TIP: Partial<Record<BlockGeom['type'], string>> = {
  instrument: 'The sound source of this part. Its Out is where the sound starts.',
  channel: "This part's mixer: level, pan, pump and the two sends. Its Out goes to the Master Out.",
  master: 'Everything cabled into the Master Out is heard, through a limiter that never exceeds −1 dBFS.',
  lfo: 'A tempo-synced movement source. Cable its Mod Out to a teal socket to make that setting move.',
};

export interface ModuleBlockProps {
  geom: BlockGeom;
  name: string;
  /** For the Other parts strip: "2 Percussion". */
  partLabel?: string;
  bypass: boolean;
  selected: boolean;
  ui: SocketUi;
  handlers: SocketHandlers;
  socketAria: Record<string, string>;
  socketCount: Record<string, number>;
}

export const ModuleBlock = memo(function ModuleBlock(props: ModuleBlockProps) {
  const { geom, name, partLabel, bypass, selected, ui, handlers, socketAria, socketCount } = props;
  const def = MODULE_DEFS[geom.type];
  const canBypass = !def.protected && geom.variant !== 'other';
  const shared = geom.variant === 'return';
  const switchLabel = geom.type === 'lfo' ? `${name} movement` : `${name} effect`;
  const switchTip =
    geom.type === 'lfo'
      ? `Off stops ${name}'s movement; its cables stay in place.`
      : shared
        ? `Off bypasses the shared ${name} for every part: sound passes through unchanged.`
        : `Off bypasses the ${name}: the sound passes through unchanged.`;
  const tip = shared ? `Shared by all parts: ${def.description}` : (TITLE_TIP[geom.type] ?? def.description);
  const sockets = geom.sockets.map((s) => <Socket key={s.key} s={s} ui={ui} handlers={handlers} aria={socketAria[s.key] ?? s.label} count={socketCount[s.key] ?? 0} />);

  if (geom.variant === 'other') {
    return (
      <div className={styles.block} data-variant="other" role="group" aria-label={`${partLabel ?? name} channel`} style={{ left: geom.x, top: geom.y, width: geom.w, height: geom.h }}>
        <span className={styles.otherName}>{partLabel}</span>
        {sockets}
      </div>
    );
  }

  const bypassSwitch = canBypass && (
    <Switch
      size="sm"
      className={styles.bypass}
      label={switchLabel}
      hideLabel
      checked={!bypass}
      disabled={ui.locked}
      tip={switchTip}
      onChange={(on) => session.accepted(cmd.setBypass(session.store, geom.id, !on))}
    />
  );
  const switchInHead = geom.variant === 'return' || geom.variant === 'lfo';
  const caption =
    geom.type === 'instrument' && geom.trackId ? (
      <InstrumentCaption trackId={geom.trackId} />
    ) : geom.type === 'lfo' ? (
      <LfoCaption moduleId={geom.id} />
    ) : CAPTION[geom.type] ? (
      <span className={styles.caption}>{CAPTION[geom.type]}</span>
    ) : null;
  const sub = !switchInHead && bypassSwitch ? bypassSwitch : caption;

  return (
    <div
      className={styles.block}
      data-variant={geom.variant}
      data-type={geom.type}
      data-bypassed={(canBypass && bypass) || undefined}
      data-selected={selected || undefined}
      data-module={geom.id}
      role="group"
      aria-label={`${name} module${canBypass && bypass ? ', off (bypassed)' : ''}${shared ? ', shared by all parts' : ''}`}
      style={{ left: geom.x, top: geom.y, width: geom.w, height: geom.h }}
    >
      <div className={styles.blockHead}>
        <Tooltip name={name} tip={tip} detail={selected ? 'Selected. Click again to clear the selection.' : 'Click to select it here and in the effects rack.'}>
          <button type="button" className={styles.blockName} aria-pressed={selected} onClick={() => selectModule(selected ? null : geom.id)}>
            {name}
          </button>
        </Tooltip>
        <span className={`${styles.legend} mono`} data-kind={geom.type === 'lfo' ? 'mod' : undefined} aria-hidden="true">
          {def.short}
        </span>
        {switchInHead && bypassSwitch}
      </div>
      {sub && <div className={styles.blockSub}>{sub}</div>}
      {canBypass && bypass && geom.variant === 'effect' && (
        <span className={styles.bypassNote} aria-hidden="true">
          Bypassed
        </span>
      )}
      {sockets}
    </div>
  );
});
