/**
 * EFFECTS column: the selected part's insert chain, its channel strip, the
 * shared returns and its LFOs.
 *
 * The rack edits the same `project.patch` as the cable panel (through the
 * patch commands), so every change here shows up there immediately and vice
 * versa. When the part's routing is not a simple chain the rack lists the
 * part's effects without reordering and points to the cable panel.
 */
import { memo, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button, Icon, IconButton, Notice, Panel, Switch, Tooltip } from '../../../ui/components';
import { DELAY_ID, MASTER_ID, REVERB_ID, moduleId as mid } from '../../../project/factory';
import { connectionKind, describePathProblem, findModule, inputPortDef, trackChain } from '../../../project/graph';
import { INSERTABLE_EFFECTS, MODULE_DEFS, PATCH_LIMITS } from '../../../project/modules';
import { MODULE_PARAMS } from '../../../project/params';
import type { Id, ModuleType, Patch } from '../../../project/types';
import * as cmd from '../../../state/commands';
import { shallowEqual } from '../../../state/store';
import { selectModule, setCablesOpen } from '../../../state/uiStore';
import { session, useProject, useUi } from '../../instance';
import { notify } from '../../runtime';
import { ParamKnob } from './ParamKnob';
import { moduleName, sameItems } from './paramState';
import styles from './EffectsRack.module.css';

const focusLater = (id: string, fallback?: string) =>
  requestAnimationFrame(() => {
    const el = document.getElementById(id) as HTMLButtonElement | null;
    if (el && !el.disabled) el.focus();
    else if (fallback) (document.getElementById(fallback) as HTMLElement | null)?.focus();
  });

/* ------------------------------------------------------------------ */
/* Add effect menu                                                     */
/* ------------------------------------------------------------------ */

function AddEffectMenu(props: { trackId: Id; disabled: boolean; disabledReason?: string }) {
  const { trackId, disabled, disabledReason } = props;
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || buttonRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  const add = (type: ModuleType) => {
    close(true);
    const r = cmd.insertEffect(session.store, trackId, type);
    if (session.accepted(r) && r.moduleId) {
      selectModule(r.moduleId);
      const newId = r.moduleId;
      requestAnimationFrame(() => document.getElementById(`rack-card-${newId}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    }
  };

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    switch (e.key) {
      case 'ArrowDown':
        next = (i + 1) % items.length;
        break;
      case 'ArrowUp':
        next = (i - 1 + items.length) % items.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = items.length - 1;
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        close(true);
        return;
      case 'Tab':
        close(false);
        return;
      default:
        return;
    }
    e.preventDefault();
    items[next]?.focus();
  };

  return (
    <div className={styles.addWrap}>
      <Button
        ref={buttonRef}
        size="sm"
        icon="plus"
        iconRight="chevronDown"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        tip={disabled ? disabledReason : 'Add an effect at the end of this part’s chain, just before its channel.'}
        detail={`Up to ${PATCH_LIMITS.maxEffectsPerTrack} effects per part.`}
      >
        Add effect
      </Button>
      {open && (
        <div ref={menuRef} id={menuId} className={styles.menu} role="menu" aria-label="Add effect" onKeyDown={onMenuKey}>
          {INSERTABLE_EFFECTS.map((type) => (
            <button key={type} type="button" role="menuitem" tabIndex={-1} className={styles.menuItem} onClick={() => add(type)}>
              <span className={styles.menuLabel}>{MODULE_DEFS[type].label}</span>
              <span className={styles.menuDesc}>{MODULE_DEFS[type].description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Effect cards                                                        */
/* ------------------------------------------------------------------ */

interface CardInfo {
  type: ModuleType;
  bypass: boolean;
  name: string;
}

/** True when an audio path runs from the part's instrument through `id` to the master output. */
function onAudiblePath(patch: Patch, trackId: Id, id: Id): boolean {
  const audio = patch.connections.filter((c) => connectionKind(patch, c) === 'audio');
  const walk = (start: Id, forward: boolean): Set<Id> => {
    const seen = new Set<Id>([start]);
    const stack = [start];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const c of audio) {
        const [a, b] = forward ? [c.from.module, c.to.module] : [c.to.module, c.from.module];
        if (a === cur && !seen.has(b)) {
          seen.add(b);
          stack.push(b);
        }
      }
    }
    return seen;
  };
  return walk(mid.inst(trackId), true).has(id) && walk(MASTER_ID, false).has(id);
}

/**
 * Where a card sits: 'chain' = at `index` of a linear chain of `count` effects (movable);
 * 'custom' = the part's routing is not a simple chain; 'outside' = not part of the part's linear chain.
 */
type CardMode = 'chain' | 'custom' | 'outside';

const EffectCard = memo(function EffectCard(props: { trackId: Id; moduleId: Id; mode: CardMode; index?: number; count?: number }) {
  const { trackId, moduleId, mode, index = 0, count = 1 } = props;
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
  };

  const status = silent ? 'not heard: no path from the instrument to the output' : mode === 'outside' ? 'patched outside the chain' : null;
  const label = [name, inChain ? `effect ${index + 1} of ${count}` : null, status, bypass ? 'bypassed' : null].filter(Boolean).join(', ');
  return (
    <article id={`rack-card-${moduleId}`} className={styles.card} data-bypassed={bypass || undefined} data-selected={selected || undefined} aria-label={label}>
      <header className={styles.cardHead}>
        <Tooltip tip={selected ? `${name} is selected: it is highlighted in the cable panel too.` : `Select ${name}: it is highlighted in the cable panel too.`}>
          <button type="button" className={styles.cardName} aria-pressed={selected} onClick={() => selectModule(selected ? null : moduleId)}>
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
      <div className={styles.cardKnobs}>
        {MODULE_PARAMS[info.type].map((spec) => (
          <ParamKnob key={spec.id} moduleId={moduleId} param={spec.id} spec={spec} ownerTrackId={trackId} size="sm" />
        ))}
      </div>
      <footer className={styles.cardFoot}>
        <Switch
          size="sm"
          label={name}
          hideLabel
          checked={!bypass}
          onText="On"
          offText="Off"
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
                disabled={index === 0}
                onClick={() => move(-1)}
              />
              <IconButton
                id={rightId}
                icon="chevronRight"
                size="sm"
                label={`Move ${name} later`}
                tip="Later in the chain: this effect processes what the earlier ones made."
                disabled={index === count - 1}
                onClick={() => move(1)}
              />
            </>
          )}
          <IconButton icon="trash" size="sm" variant="danger" label={`Remove ${name}`} tip="Take this effect out. The sound keeps flowing; Undo puts it back." onClick={remove} />
        </span>
      </footer>
    </article>
  );
});

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
    <ModuleRow title="Channel" note="Level, pan, sends and pump" label="Channel strip">
      {MODULE_PARAMS.channel.map((spec) => (
        <ParamKnob key={spec.id} moduleId={ch} param={spec.id} spec={spec} ownerTrackId={trackId} size="sm" />
      ))}
    </ModuleRow>
  );
}

function ReturnRow(props: { trackId: Id; id: Id }) {
  const { trackId, id } = props;
  const info = useProject<CardInfo | null>((p) => {
    const m = findModule(p.patch, id);
    return m ? { type: m.type, bypass: m.bypass, name: MODULE_DEFS[m.type].label } : null;
  }, shallowEqual);
  if (!info) {
    const label = id === REVERB_ID ? 'Reverb' : 'Delay';
    return (
      <div className={styles.missing}>
        The shared {label} is not in the patch.{' '}
        <Button size="sm" variant="ghost" onClick={() => session.accepted(cmd.restoreTrackPatch(session.store, trackId))} tip="Put this part’s default routing back, including the shared returns.">
          Restore routing
        </Button>
      </div>
    );
  }
  const { name, bypass } = info;
  return (
    <ModuleRow
      title={name}
      note={id === REVERB_ID ? 'Shared room for every part' : 'Shared echo, locked to tempo'}
      label={`Shared ${name} return`}
      bypassed={bypass}
      tools={
        <Switch
          size="sm"
          label={`Shared ${name}`}
          hideLabel
          checked={!bypass}
          tip={bypass ? `Turn the shared ${name} back on (for every part).` : `Bypass the shared ${name} for every part.`}
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

function LfoRow(props: { trackId: Id; id: Id }) {
  const { trackId, id } = props;
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
    if (session.accepted(r)) notify(`Removed ${name} and its cables.`, 'info', 'undo');
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
            tip={bypass ? `Turn ${name} back on.` : `Stop ${name}'s movement.`}
            onChange={(on) => session.accepted(cmd.setBypass(session.store, id, !on))}
          />
          {extra && <IconButton icon="trash" size="sm" variant="danger" label={`Remove ${name}`} tip="Remove this LFO and its cables. Undo puts them back." onClick={remove} />}
        </>
      }
    >
      {MODULE_PARAMS.lfo.map((spec) => (
        <ParamKnob key={spec.id} moduleId={id} param={spec.id} spec={spec} ownerTrackId={trackId} size="sm" />
      ))}
    </ModuleRow>
  );
}

function Lfos(props: { trackId: Id }) {
  const { trackId } = props;
  const ids = useProject<Id[]>((p) => p.patch.modules.filter((m) => m.type === 'lfo' && m.trackId === trackId).map((m) => m.id), sameItems);
  const add = () => {
    const r = cmd.addLfo(session.store, trackId);
    if (!session.accepted(r) || !r.moduleId) return;
    selectModule(r.moduleId);
    setCablesOpen(true);
    notify('Added an LFO. Drag from its Mod Out to a teal socket in the cable panel to make something move.', 'info', 'undo');
  };
  return (
    <section className={styles.group} aria-label="Movement">
      <h3 className={styles.groupTitle}>
        Movement
        <Button size="sm" variant="ghost" icon="plus" onClick={add} tip="Add another tempo-synced LFO to this part, then cable it to what should move." className={styles.groupAction}>
          Add LFO
        </Button>
      </h3>
      {ids.length === 0 && <p className={styles.hint}>This part has no LFO.</p>}
      {ids.map((id) => (
        <LfoRow key={id} trackId={trackId} id={id} />
      ))}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Column                                                              */
/* ------------------------------------------------------------------ */

function FlowLine(props: { trackId: Id; chain: readonly Id[] }) {
  const { trackId, chain } = props;
  const names = useProject<string[]>(
    (p) => chain.map((id) => (id === mid.inst(trackId) ? 'Instrument' : id === mid.channel(trackId) ? 'Channel' : moduleName(p, findModule(p.patch, id), trackId))),
    sameItems,
  );
  const off = useProject<boolean[]>((p) => chain.map((id) => findModule(p.patch, id)?.bypass ?? false), sameItems);
  const steps = [...names.map((name, i) => ({ name, off: off[i] ?? false, end: i === 0 || i === names.length - 1 })), { name: 'Master', off: false, end: true }];
  return (
    <ol className={styles.flow} aria-label="Signal flow">
      {steps.map((step, i) => (
        <li key={i} className={styles.flowItem}>
          {i > 0 && (
            <span className={styles.flowArrow} aria-hidden="true">
              →
            </span>
          )}
          <span className={styles.flowChip} data-end={step.end || undefined} data-off={step.off || undefined}>
            <span className={styles.flowName}>{step.name}</span>
            {step.off && <span className={styles.flowOff}> off</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function EffectsRack(props: { trackId: Id; className?: string }) {
  const { trackId, className } = props;
  const chain = useProject((p) => trackChain(p.patch, trackId), sameItems);
  const partEffects = useProject<Id[]>((p) => p.patch.modules.filter((m) => m.trackId === trackId && MODULE_DEFS[m.type].family === 'effect').map((m) => m.id), sameItems);
  const noPath = useProject((p) => describePathProblem(p.patch, trackId) !== null);
  const linear = chain !== null;
  const effects = linear ? chain.slice(1, -1) : partEffects;
  // Effects of this part that its linear chain does not pass through (unpatched, or patched elsewhere with cables).
  const offPath = linear ? partEffects.filter((id) => !chain.includes(id)) : [];
  const restore = () => {
    if (session.accepted(cmd.restoreTrackPatch(session.store, trackId))) notify('Restored this part’s default routing.', 'info', 'undo');
  };

  return (
    <Panel
      title="Effects"
      subtitle={<span className={`${styles.count} mono`}>{linear ? `${effects.length} of ${PATCH_LIMITS.maxEffectsPerTrack}` : 'Custom routing'}</span>}
      className={className}
      bodyClassName={styles.scroll}
      dense
      actions={<AddEffectMenu trackId={trackId} disabled={!linear} disabledReason="This part has custom routing: add and place effects with the cable panel, or restore its default routing." />}
    >
      {noPath && (
        <Notice tone="warning" title="This part has no path to the output." action={{ label: 'Restore Connection', onAction: restore }}>
          Its sound never reaches the master, so you will not hear it.
        </Notice>
      )}
      {linear ? (
        <FlowLine trackId={trackId} chain={chain} />
      ) : (
        <div className={styles.custom} role="status">
          <Icon name="cable" size={16} className={styles.customIcon} />
          <span>
            <strong>Custom routing — edit it with the cables below.</strong> This part’s effects are listed here; their order is set by the cables.
          </span>
          <Button size="sm" variant="ghost" onClick={restore} tip="Rebuild the default chain Instrument → Drive → Filter → Channel for this part. Undo brings your cables back.">
            Restore default
          </Button>
        </div>
      )}
      {effects.length === 0 ? (
        <p className={styles.hint}>{linear ? 'No insert effects: the instrument goes straight to its channel. Add one above.' : 'This part has no effect modules of its own.'}</p>
      ) : (
        <div className={styles.cards} role="list" aria-label={linear ? 'Insert effects in signal order' : 'Effects of this part'}>
          {effects.map((id, i) => (
            <div key={id} role="listitem" className={styles.cardCell}>
              <EffectCard trackId={trackId} moduleId={id} mode={linear ? 'chain' : 'custom'} index={i} count={effects.length} />
            </div>
          ))}
        </div>
      )}
      {offPath.length > 0 && (
        <section className={styles.group} aria-label="Outside the chain">
          <h3 className={styles.groupTitle}>Outside the chain</h3>
          <p className={styles.hint}>Effects of this part that are not between its instrument and channel. The cable panel shows where they are patched; one with no path to the output is not heard.</p>
          <div className={styles.cards} role="list" aria-label="Effects outside the chain">
            {offPath.map((id) => (
              <div key={id} role="listitem" className={styles.cardCell}>
                <EffectCard trackId={trackId} moduleId={id} mode="outside" />
              </div>
            ))}
          </div>
        </section>
      )}
      <section className={styles.group} aria-label="Mix">
        <h3 className={styles.groupTitle}>Mix</h3>
        <ChannelRow trackId={trackId} />
      </section>
      <section className={styles.group} aria-label="Shared returns">
        <h3 className={styles.groupTitle}>Shared returns</h3>
        <ReturnRow trackId={trackId} id={REVERB_ID} />
        <ReturnRow trackId={trackId} id={DELAY_ID} />
      </section>
      <Lfos trackId={trackId} />
    </Panel>
  );
}
