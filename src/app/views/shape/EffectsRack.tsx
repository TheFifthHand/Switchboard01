/**
 * EFFECTS column (Advanced): the selected part's insert chain with every
 * setting, its channel strip, the shared effects and its LFOs.
 *
 * The rack edits the same `project.patch` as the cable panel (through the
 * patch commands), so every change here shows up there immediately and vice
 * versa. Effects are reordered by dragging a card's grip or with its arrow
 * buttons (the keyboard alternative); each move is one undo step. When the
 * part's routing is not a simple chain the rack lists the part's effects
 * without reordering and points to the cable panel. While a performance take
 * records, routing edits are locked and the rack says so; knobs keep working.
 */
import { memo, useCallback, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import { Button, Icon, IconButton, Panel, Switch, Tooltip } from '../../../ui/components';
import { DELAY_ID, REVERB_ID, moduleId as mid } from '../../../project/factory';
import { findModule, inputPortDef } from '../../../project/graph';
import { MODULE_DEFS, PATCH_LIMITS } from '../../../project/modules';
import { MODULE_PARAMS } from '../../../project/params';
import type { Id, ModuleType } from '../../../project/types';
import * as cmd from '../../../state/commands';
import { shallowEqual } from '../../../state/store';
import { selectModule, setCablesOpen } from '../../../state/uiStore';
import { session, useProject, useUi } from '../../instance';
import { notify } from '../../runtime';
import { AddEffectMenu } from './AddEffectMenu';
import { RACK_ROWS, rackRows } from './effectCatalog';
import { ParamKnob } from './ParamKnob';
import { moduleName, sameItems } from './paramState';
import { FlowLine, LockNotice, PathWarning, focusLater, onAudiblePath, useEditLock, usePartEffects } from './shared';
import { useEffectDrag, type EffectDragView } from './useEffectDrag';
import styles from './EffectsRack.module.css';

const ADD_ID = 'shape-add-effect';

/* ------------------------------------------------------------------ */
/* Effect cards                                                        */
/* ------------------------------------------------------------------ */

interface CardInfo {
  type: ModuleType;
  bypass: boolean;
  name: string;
}

/**
 * Where a card sits: 'chain' = at `index` of a linear chain of `count` effects (movable);
 * 'custom' = the part's routing is not a simple chain; 'outside' = not part of the part's linear chain.
 */
type CardMode = 'chain' | 'custom' | 'outside';

function CardKnobs(props: { trackId: Id; moduleId: Id; type: ModuleType }) {
  const { trackId, moduleId, type } = props;
  const rows = rackRows(type);
  const fixed = RACK_ROWS[type] !== undefined;
  return (
    <div className={styles.cardKnobs}>
      {rows.map((row, i) => (
        <div key={i} className={styles.knobRow} data-fixed={fixed || undefined} style={fixed ? ({ '--cols': Math.max(...rows.map((r) => r.length)) } as CSSProperties) : undefined}>
          {row.map((spec) => (
            <ParamKnob key={spec.id} moduleId={moduleId} param={spec.id} spec={spec} ownerTrackId={trackId} size="sm" />
          ))}
        </div>
      ))}
    </div>
  );
}

interface EffectCardProps {
  trackId: Id;
  moduleId: Id;
  mode: CardMode;
  index?: number;
  count?: number;
  /** Card to focus after this one is removed. */
  next?: Id | null;
  locked: boolean;
  onGripDown?(e: PointerEvent<HTMLElement>, id: Id): void;
}

const EffectCard = memo(function EffectCard(props: EffectCardProps) {
  const { trackId, moduleId, mode, index = 0, count = 1, next = null, locked, onGripDown } = props;
  const inChain = mode === 'chain';
  const info = useProject<CardInfo | null>((p) => {
    const m = findModule(p.patch, moduleId);
    return m ? { type: m.type, bypass: m.bypass, name: moduleName(p, m, trackId) } : null;
  }, shallowEqual);
  const silent = useProject((p) => !inChain && !onAudiblePath(p.patch, trackId, moduleId));
  const selected = useUi((s) => s.selectedModuleId === moduleId);
  if (!info) return null;
  const { name, bypass } = info;
  const leftId = `rack-${moduleId}-left`;
  const rightId = `rack-${moduleId}-right`;
  const nameId = `rack-${moduleId}-name`;

  const move = (dir: -1 | 1) => {
    // The card's DOM moves (and a button at the end of the chain becomes disabled), which drops focus
    // without a blur event: blur first so the button's tooltip closes, then focus follows the card.
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
    if (session.accepted(cmd.moveEffect(session.store, moduleId, index + dir))) focusLater(dir < 0 ? leftId : rightId, dir < 0 ? rightId : leftId);
    else if (active instanceof HTMLElement) active.focus();
  };
  const remove = () => {
    const r = cmd.removeEffect(session.store, moduleId);
    if (!session.accepted(r)) return;
    if (selected) selectModule(null);
    notify(silent ? `Removed ${name}.` : `Removed ${name}. The sound now flows straight past it.`, 'info', 'undo');
    focusLater(next ? `rack-${next}-name` : ADD_ID, ADD_ID);
  };

  const status = silent ? 'not heard: no path from the instrument to the output' : mode === 'outside' ? 'patched outside the chain' : null;
  const label = [name, inChain ? `effect ${index + 1} of ${count}` : null, status, bypass ? 'bypassed' : null].filter(Boolean).join(', ');
  const canDrag = inChain && count > 1 && onGripDown;
  return (
    <article id={`rack-card-${moduleId}`} className={styles.card} data-type={info.type} data-bypassed={bypass || undefined} data-selected={selected || undefined} aria-label={label}>
      <header className={styles.cardHead}>
        {canDrag && (
          <Tooltip
            name="Drag to reorder"
            tip={locked ? 'Effects cannot be moved while a performance records.' : `Drag ${name} to a new place in the chain. The arrow buttons below do the same from the keyboard.`}
          >
            <span className={styles.grip} data-locked={locked || undefined} aria-hidden="true" data-grip={moduleId} onPointerDown={(e) => onGripDown(e, moduleId)}>
              <Icon name="drag" size={16} />
            </span>
          </Tooltip>
        )}
        <Tooltip tip={selected ? `${name} is selected: it is highlighted in the cable panel too.` : `Select ${name}: it is highlighted in the cable panel too.`}>
          <button id={nameId} type="button" className={styles.cardName} aria-pressed={selected} onClick={() => selectModule(selected ? null : moduleId)}>
            {inChain && <span className={`${styles.slot} mono`}>{index + 1}</span>}
            <span className={styles.cardTitle}>{name}</span>
          </button>
        </Tooltip>
        {silent ? (
          <span className={styles.cardState} data-tone="attention" aria-hidden="true">
            Not heard
          </span>
        ) : bypass ? (
          <span className={styles.cardState} aria-hidden="true">
            Bypassed
          </span>
        ) : null}
      </header>
      <CardKnobs trackId={trackId} moduleId={moduleId} type={info.type} />
      <footer className={styles.cardFoot}>
        <Switch
          size="sm"
          label={name}
          hideLabel
          checked={!bypass}
          onText="On"
          offText="Off"
          disabled={locked}
          tip={bypass ? `Turn ${name} back on.` : `Bypass ${name}: the sound passes through unprocessed.`}
          onChange={(on) => session.accepted(cmd.setBypass(session.store, moduleId, !on))}
        />
        <span className={styles.footTools}>
          {inChain && (
            <>
              <IconButton
                id={leftId}
                icon="chevronLeft"
                size="sm"
                label={`Move ${name} earlier`}
                tip="Earlier in the chain: the sound reaches this effect sooner."
                disabled={index === 0 || locked}
                onClick={() => move(-1)}
              />
              <IconButton
                id={rightId}
                icon="chevronRight"
                size="sm"
                label={`Move ${name} later`}
                tip="Later in the chain: this effect processes what the earlier ones made."
                disabled={index === count - 1 || locked}
                onClick={() => move(1)}
              />
            </>
          )}
          <IconButton icon="trash" size="sm" variant="danger" disabled={locked} label={`Remove ${name}`} tip="Take this effect out. The sound keeps flowing; Undo puts it back." onClick={remove} />
        </span>
      </footer>
    </article>
  );
});

/** Where a dragged card would land, relative to one cell: a bar before it, after it, or none. */
function dropMark(drag: EffectDragView | null, effects: readonly Id[], id: Id): 'before' | 'after' | undefined {
  if (!drag || drag.index === drag.from || id === drag.id) return undefined;
  const others = effects.filter((e) => e !== drag.id);
  if (drag.index < others.length) return others[drag.index] === id ? 'before' : undefined;
  return others[others.length - 1] === id ? 'after' : undefined;
}

/* ------------------------------------------------------------------ */
/* Channel, returns, LFOs                                              */
/* ------------------------------------------------------------------ */

function ModuleRow(props: { title: string; note?: string; status?: ReactNode; tools?: ReactNode; children: ReactNode; bypassed?: boolean; label: string }) {
  return (
    <div className={styles.modRow} role="group" aria-label={props.label} data-bypassed={props.bypassed || undefined}>
      <div className={styles.modInfo}>
        <div className={styles.modTitle}>{props.title}</div>
        {props.note && <div className={styles.modNote}>{props.note}</div>}
        {props.status}
        {props.tools && <div className={styles.modTools}>{props.tools}</div>}
      </div>
      <div className={styles.modKnobs}>{props.children}</div>
    </div>
  );
}

function ChannelRow(props: { trackId: Id }) {
  const { trackId } = props;
  const ch = mid.channel(trackId);
  const exists = useProject((p) => !!findModule(p.patch, ch));
  if (!exists) return null;
  return (
    <ModuleRow title="Channel" note="Level, pan, the amounts sent to the shared Reverb and Delay, and pump" label="Channel strip">
      {MODULE_PARAMS.channel.map((spec) => (
        <ParamKnob key={spec.id} moduleId={ch} param={spec.id} spec={spec} ownerTrackId={trackId} size="sm" />
      ))}
    </ModuleRow>
  );
}

function ReturnRow(props: { trackId: Id; id: Id; locked: boolean }) {
  const { trackId, id, locked } = props;
  const info = useProject<CardInfo | null>((p) => {
    const m = findModule(p.patch, id);
    return m ? { type: m.type, bypass: m.bypass, name: MODULE_DEFS[m.type].label } : null;
  }, shallowEqual);
  if (!info) {
    const label = id === REVERB_ID ? 'Reverb' : 'Delay';
    return (
      <div className={styles.missing}>
        The shared {label} is not in the patch.{' '}
        <Button
          size="sm"
          variant="ghost"
          disabled={locked}
          onClick={() => session.accepted(cmd.restoreTrackPatch(session.store, trackId))}
          tip="Put this part’s default routing back, including the shared effects."
        >
          Restore routing
        </Button>
      </div>
    );
  }
  const { name, bypass } = info;
  return (
    <ModuleRow
      title={name}
      note={id === REVERB_ID ? 'One room for every part. Reverb Amount sets how much of this part goes in.' : 'One echo for every part, locked to the tempo. Echo Amount sets how much goes in.'}
      label={`Shared ${name} return`}
      bypassed={bypass}
      tools={
        <Switch
          size="sm"
          label={`Shared ${name}`}
          hideLabel
          checked={!bypass}
          disabled={locked}
          tip={bypass ? `Turn the shared ${name} back on (for every part).` : `Turn the shared ${name} off for every part: they are heard without it.`}
          onChange={(on) => session.accepted(cmd.setBypass(session.store, id, !on))}
        />
      }
    >
      {MODULE_PARAMS[info.type].map((spec) => (
        <ParamKnob key={spec.id} moduleId={id} param={spec.id} spec={spec} ownerTrackId={trackId} size="sm" />
      ))}
    </ModuleRow>
  );
}

function LfoRow(props: { trackId: Id; id: Id; locked: boolean }) {
  const { trackId, id, locked } = props;
  const info = useProject<CardInfo | null>((p) => {
    const m = findModule(p.patch, id);
    return m ? { type: m.type, bypass: m.bypass, name: moduleName(p, m, trackId) } : null;
  }, shallowEqual);
  const targets = useProject<string[]>((p) => {
    const out: string[] = [];
    for (const c of p.patch.connections) {
      if (c.from.module !== id) continue;
      const to = findModule(p.patch, c.to.module);
      const port = inputPortDef(p.patch, c.to);
      const amount = c.amount ?? 1;
      out.push(`${moduleName(p, to, trackId)} ${port?.label ?? c.to.port}${amount !== 1 ? ` (${Math.round(amount * 100)}%)` : ''}`);
    }
    return out;
  }, sameItems);
  if (!info) return null;
  const { name, bypass } = info;
  const extra = id !== mid.lfo(trackId);
  const remove = () => {
    const r = cmd.removeEffect(session.store, id);
    if (session.accepted(r)) {
      notify(`Removed ${name} and its cables.`, 'info', 'undo');
      focusLater('shape-add-lfo');
    }
  };
  return (
    <ModuleRow
      title={name}
      label={`${name}${bypass ? ', bypassed' : ''}`}
      bypassed={bypass}
      status={
        <div className={styles.lfoTargets} data-empty={targets.length === 0 || undefined}>
          {targets.length ? `Cabled to ${targets.join(', ')}` : 'Not cabled — patch its Mod Out to a teal socket below'}
        </div>
      }
      tools={
        <>
          <Switch
            size="sm"
            label={name}
            hideLabel
            checked={!bypass}
            disabled={locked}
            tip={bypass ? `Turn ${name} back on.` : `Stop ${name}'s movement.`}
            onChange={(on) => session.accepted(cmd.setBypass(session.store, id, !on))}
          />
          {extra && <IconButton icon="trash" size="sm" variant="danger" disabled={locked} label={`Remove ${name}`} tip="Remove this LFO and its cables. Undo puts them back." onClick={remove} />}
        </>
      }
    >
      {MODULE_PARAMS.lfo.map((spec) => (
        <ParamKnob key={spec.id} moduleId={id} param={spec.id} spec={spec} ownerTrackId={trackId} size="sm" />
      ))}
    </ModuleRow>
  );
}

function Section(props: { label: string; title: string; hint?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className={styles.group} aria-label={props.label}>
      <h3 className={styles.groupTitle}>
        <span>{props.title}</span>
        {props.action}
      </h3>
      {props.hint && <p className={styles.groupHint}>{props.hint}</p>}
      {props.children}
    </section>
  );
}

function Lfos(props: { trackId: Id; locked: boolean }) {
  const { trackId, locked } = props;
  const ids = useProject<Id[]>((p) => p.patch.modules.filter((m) => m.type === 'lfo' && m.trackId === trackId).map((m) => m.id), sameItems);
  const add = () => {
    const r = cmd.addLfo(session.store, trackId);
    if (!session.accepted(r) || !r.moduleId) return;
    selectModule(r.moduleId);
    setCablesOpen(true);
    notify('Added an LFO. Drag from its Mod Out to a teal socket in the cable panel to make something move.', 'info', 'undo');
  };
  return (
    <Section
      label="Movement"
      title="Movement (LFOs)"
      hint="Tempo-synced movers: cable one to a teal socket to make that setting sway with the beat."
      action={
        <Button
          id="shape-add-lfo"
          size="sm"
          variant="ghost"
          icon="plus"
          disabled={locked}
          onClick={add}
          tip="Add another tempo-synced LFO to this part, then cable it to what should move."
          className={styles.groupAction}
        >
          Add LFO
        </Button>
      }
    >
      {ids.length === 0 && <p className={styles.hint}>This part has no LFO.</p>}
      {ids.map((id) => (
        <LfoRow key={id} trackId={trackId} id={id} locked={locked} />
      ))}
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Column                                                              */
/* ------------------------------------------------------------------ */

export function EffectsRack(props: { trackId: Id; className?: string }) {
  const { trackId, className } = props;
  const { chain, effects, offPath } = usePartEffects(trackId);
  const lock = useEditLock();
  const locked = lock !== null;
  const linear = chain !== null;
  const full = linear && effects.length >= PATCH_LIMITS.maxEffectsPerTrack;
  const restore = () => {
    if (session.accepted(cmd.restoreTrackPatch(session.store, trackId))) notify('Restored this part’s default routing.', 'info', 'undo');
  };
  const names = useProject<string[]>((p) => effects.map((id) => moduleName(p, findModule(p.patch, id), trackId)), sameItems);
  const nameOf = useCallback((id: Id) => names[effects.indexOf(id)] ?? 'the effect', [names, effects]);
  const { drag, onGripDown } = useEffectDrag({
    effects,
    lock,
    nameOf,
    cellOf: (id) => document.querySelector<HTMLElement>(`[data-rack-cell="${CSS.escape(id)}"]`),
    cardOf: (id) => document.getElementById(`rack-card-${id}`),
  });
  const addReason = locked
    ? 'Effects cannot be added while a performance records.'
    : !linear
      ? 'This part has custom routing: add and place effects with the cable panel, or restore its default routing.'
      : `This part already has ${PATCH_LIMITS.maxEffectsPerTrack} effects, the most it can hold. Remove one to add another.`;
  const onAdded = (id: Id) => {
    selectModule(id);
    requestAnimationFrame(() => document.getElementById(`rack-card-${id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  };

  return (
    <Panel
      title="Effects"
      subtitle={<span className={`${styles.count} mono`}>{linear ? `${effects.length} of ${PATCH_LIMITS.maxEffectsPerTrack}` : 'Custom routing'}</span>}
      className={className}
      bodyClassName={styles.scroll}
      dense
      actions={<AddEffectMenu id={ADD_ID} trackId={trackId} disabled={!linear || full || locked} disabledReason={addReason} onAdded={onAdded} />}
    >
      <PathWarning trackId={trackId} />
      <LockNotice lock={lock} />
      <Section
        label="Insert effects"
        title="In this part’s chain"
        hint={linear ? (effects.length > 1 ? 'The sound passes through these in order. Drag a card by its grip, or use its arrows, to reorder.' : undefined) : undefined}
      >
        {linear ? (
          <FlowLine trackId={trackId} chain={chain} />
        ) : (
          <div className={styles.custom} role="status">
            <Icon name="cable" size={16} className={styles.customIcon} />
            <span>
              <strong>Custom routing — edit it with the cables below.</strong> This part’s effects are listed here; their order is set by the cables.
            </span>
            <Button size="sm" variant="ghost" disabled={locked} onClick={restore} tip="Rebuild the default chain Instrument → Drive → Filter → Channel for this part. Undo brings your cables back.">
              Restore default
            </Button>
          </div>
        )}
        {effects.length === 0 ? (
          <p className={styles.hint}>{linear ? 'No insert effects: the instrument goes straight to its channel. Add one above.' : 'This part has no effect modules of its own.'}</p>
        ) : (
          <div className={styles.cards} role="list" aria-label={linear ? 'Insert effects in signal order' : 'Effects of this part'} data-dragging={drag ? true : undefined}>
            {effects.map((id, i) => (
              <div key={id} role="listitem" className={styles.cardCell} data-rack-cell={id} data-drop={dropMark(drag, effects, id)}>
                <EffectCard
                  trackId={trackId}
                  moduleId={id}
                  mode={linear ? 'chain' : 'custom'}
                  index={i}
                  count={effects.length}
                  next={effects[i + 1] ?? effects[i - 1] ?? null}
                  locked={locked}
                  onGripDown={linear ? onGripDown : undefined}
                />
              </div>
            ))}
          </div>
        )}
        {full && !locked && <p className={styles.hint}>{addReason}</p>}
      </Section>
      {offPath.length > 0 && (
        <Section
          label="Outside the chain"
          title="Outside the chain"
          hint="Effects of this part that are not between its instrument and channel. The cable panel shows where they are patched; one with no path to the output is not heard."
        >
          <div className={styles.cards} role="list" aria-label="Effects outside the chain">
            {offPath.map((id, i) => (
              <div key={id} role="listitem" className={styles.cardCell}>
                <EffectCard trackId={trackId} moduleId={id} mode="outside" next={offPath[i + 1] ?? offPath[i - 1] ?? effects[0] ?? null} locked={locked} />
              </div>
            ))}
          </div>
        </Section>
      )}
      <Section label="Mix" title="Channel">
        <ChannelRow trackId={trackId} />
      </Section>
      <Section label="Shared returns" title="Shared effects" hint="Every part can send to these two. Their settings change the room and echo for all parts.">
        <ReturnRow trackId={trackId} id={REVERB_ID} locked={locked} />
        <ReturnRow trackId={trackId} id={DELAY_ID} locked={locked} />
      </Section>
      <Lfos trackId={trackId} locked={locked} />
    </Panel>
  );
}
