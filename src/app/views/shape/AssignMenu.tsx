/**
 * A knob's menu: "Assign to big knob" with the six big knobs (macros) of the
 * part the setting belongs to. A big knob already moving it is checked;
 * choosing it again stops it, choosing another one moves the setting there
 * (one undo step). A new assignment sweeps half the knob's travel around its
 * value now (assignRange), so assigning never jumps the sound.
 *
 * Opened by right-click, a long press, Shift+F10 or the menu key on any
 * ParamKnob (see knobExtras). Assignments are refused while a performance
 * records, and the rows say so.
 */
import type { ParamSpec } from '../../../project/params';
import { MACRO_IDS, type Id, type MacroId, type MacroTarget, type Project } from '../../../project/types';
import * as cmd from '../../../state/commands';
import { shallowEqual } from '../../../state/store';
import { session, useProject } from '../../instance';
import { MACRO_CAPTION, MACRO_SPECS } from '../../macros';
import { notify } from '../../runtime';
import { LOCKED_REASON, MenuHeader, MenuItem, MenuSeparator, Popover, useEditLocked, type MenuAnchor } from '../ClipMenu';
import { assignRange } from './macroAssign';
import { controllingTarget, effectiveValue, moduleName } from './paramState';

export interface AssignMenuProps {
  moduleId: Id;
  param: string;
  spec: ParamSpec;
  /** The part whose view shows the knob (its big knobs are offered for a shared module). */
  ownerTrackId?: Id;
  anchor: MenuAnchor;
  returnFocus: HTMLElement | null;
  onClose(): void;
}

interface Info {
  /** Part whose big knobs are offered. */
  trackId: Id | null;
  partName: string;
  setting: string;
  /** The big knob moving the setting now (of `byTrack`), or null. */
  by: MacroId | null;
  byTrack: Id | null;
  /** That big knob's name ("Tone", or "Bass Tone" for another part's). */
  byName: string;
}

function info(moduleIdStr: Id, param: string, spec: ParamSpec, ownerTrackId?: Id): (p: Project) => Info {
  return (p) => {
    const mod = p.patch.modules.find((m) => m.id === moduleIdStr);
    const trackId = mod?.trackId ?? ownerTrackId ?? null;
    const t = trackId ? p.tracks.find((x) => x.id === trackId) : undefined;
    const c = controllingTarget(p, moduleIdStr, param);
    const modName = mod ? moduleName(p, mod, trackId ?? undefined) : '';
    return {
      trackId: t ? t.id : null,
      partName: t?.name ?? '',
      setting: modName && modName !== spec.label ? `${modName} ${spec.label}` : spec.label,
      by: c?.macro ?? null,
      byTrack: c?.trackId ?? null,
      byName: c ? `${c.trackId !== trackId ? `${p.tracks.find((x) => x.id === c.trackId)?.name ?? ''} ` : ''}${MACRO_SPECS[c.macro].label}` : '',
    };
  };
}

/** Assign `moduleId.param` to a big knob of `trackId` (moving it from the one that moves it now). True when it changed. */
export function assignToMacro(trackId: Id, macro: MacroId, moduleIdStr: Id, param: string, spec: ParamSpec): boolean {
  const store = session.store;
  const p = store.getState();
  const track = p.tracks.find((t) => t.id === trackId);
  if (!track) return false;
  const current = controllingTarget(p, moduleIdStr, param);
  const value = effectiveValue(p, moduleIdStr, param) ?? (moduleIdStr.endsWith(':inst') ? track.instrument.params[param] : undefined) ?? spec.default;
  const range = assignRange(spec, value, track.macros[macro]);
  const target: MacroTarget = { module: moduleIdStr, param, min: range.min, max: range.max, curve: range.curve };
  if (range.macroFrom !== undefined) target.macroFrom = range.macroFrom;
  if (range.macroTo !== undefined) target.macroTo = range.macroTo;
  const name = MACRO_SPECS[macro].label;
  if (!current) {
    const r = cmd.setMacroTarget(store, trackId, macro, track.macroMap[macro].length, target);
    if (!session.accepted(r)) return false;
    notify(`The ${name} big knob now moves ${settingName(p, moduleIdStr, param, spec, trackId)} too.`, 'info', 'undo');
    return true;
  }
  // Move it: one undo step that takes it from the old big knob and gives it to the new one.
  store.beginGroup(`Assign to ${name}`);
  let ok = false;
  try {
    ok = session.accepted(cmd.removeMacroTarget(store, current.trackId, current.macro, current.index));
    if (ok) {
      const t2 = store.getState().tracks.find((t) => t.id === trackId)!;
      ok = session.accepted(cmd.setMacroTarget(store, trackId, macro, t2.macroMap[macro].length, target));
    }
  } finally {
    store.endGroup();
  }
  if (!ok) {
    // Half done (refused on the way): put it back as it was.
    if (store.getState() !== p) store.undo();
    return false;
  }
  notify(`The ${name} big knob now moves ${settingName(p, moduleIdStr, param, spec, trackId)} (the ${MACRO_SPECS[current.macro].label} big knob no longer does).`, 'info', 'undo');
  return true;
}

function settingName(p: Project, moduleIdStr: Id, param: string, spec: ParamSpec, trackId: Id): string {
  const mod = p.patch.modules.find((m) => m.id === moduleIdStr);
  const modName = mod ? moduleName(p, mod, trackId) : '';
  return modName && modName !== spec.label ? `${modName} ${spec.label}` : spec.label;
}

/** Stop the big knob that moves `moduleId.param`; its own knob sets it again. */
export function unassign(moduleIdStr: Id, param: string, spec: ParamSpec): boolean {
  const p = session.store.getState();
  const c = controllingTarget(p, moduleIdStr, param);
  if (!c) return false;
  if (!session.accepted(cmd.removeMacroTarget(session.store, c.trackId, c.macro, c.index))) return false;
  notify(`The ${MACRO_SPECS[c.macro].label} big knob no longer moves ${settingName(p, moduleIdStr, param, spec, c.trackId)}. Its own knob sets it now.`, 'info', 'undo');
  return true;
}

export function AssignMenu(props: AssignMenuProps) {
  const { moduleId: id, param, spec, ownerTrackId, anchor, returnFocus, onClose } = props;
  const locked = useEditLocked();
  const i = useProject(info(id, param, spec, ownerTrackId), shallowEqual);
  const offered = i.trackId !== null;
  const choose = (macro: MacroId) => {
    onClose();
    if (!i.trackId) return;
    if (i.by === macro && i.byTrack === i.trackId) unassign(id, param, spec);
    else assignToMacro(i.trackId, macro, id, param, spec);
  };
  return (
    <Popover anchor={anchor} label={`Assign ${i.setting} to a big knob`} onClose={onClose} returnFocus={returnFocus}>
      <MenuHeader eyebrow="Assign to big knob" title={i.setting}>
        {i.partName && <span className="visually-hidden">{`${i.partName} big knobs`}</span>}
      </MenuHeader>
      {offered &&
        MACRO_IDS.map((m) => {
          const checked = i.by === m && i.byTrack === i.trackId;
          return (
            <MenuItem
              key={m}
              role="menuitemcheckbox"
              checked={checked}
              disabled={locked}
              disabledReason={LOCKED_REASON}
              hint={checked ? 'moves it' : MACRO_CAPTION[m]}
              onSelect={() => choose(m)}
            >
              {MACRO_SPECS[m].label}
            </MenuItem>
          );
        })}
      {i.by && (
        <>
          <MenuSeparator />
          <MenuItem icon="close" disabled={locked} disabledReason={LOCKED_REASON} onSelect={() => (onClose(), unassign(id, param, spec))}>
            Stop {i.byName} moving it
          </MenuItem>
        </>
      )}
    </Popover>
  );
}
