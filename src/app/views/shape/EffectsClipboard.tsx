/**
 * Copy effects / Paste effects on a part's effects header (Simple and
 * Advanced): copy keeps the part's effects (types, settings as they sound
 * now, on/off) for this session (uiStore.effectClipboard); paste puts them
 * after another part's effects or instead of them, in one undo step.
 * The part's default Drive and Filter are not copied while they do nothing,
 * and a replace keeps them (its big knobs drive them).
 */
import { useRef, useState } from 'react';
import { Button } from '../../../ui/components';
import { trackChain } from '../../../project/graph';
import { MODULE_DEFS } from '../../../project/modules';
import type { Id } from '../../../project/types';
import * as cmd from '../../../state/commands';
import { setEffectClipboard } from '../../../state/uiStore';
import { session, useProject, useUi } from '../../instance';
import { notify } from '../../runtime';
import { LOCKED_REASON, MenuHeader, MenuItem, Popover, anchorFromElement, useEditLocked } from '../ClipMenu';
import { possessive } from './shared';
import shared from './shared.module.css';

const count = (n: number) => `${n} effect${n === 1 ? '' : 's'}`;

export function EffectsClipboard(props: { trackId: Id; size?: 'sm' | 'md'; className?: string; idPrefix?: string }) {
  const { trackId, size = 'sm', className, idPrefix = 'shape' } = props;
  const locked = useEditLocked();
  const clip = useUi((s) => s.effectClipboard);
  const partName = useProject((p) => p.tracks.find((t) => t.id === trackId)?.name ?? 'this part');
  const linear = useProject((p) => trackChain(p.patch, trackId) !== null);
  const [open, setOpen] = useState(false);
  const pasteRef = useRef<HTMLButtonElement>(null);

  const copy = () => {
    const c = cmd.copyEffectChain(session.store.getState(), trackId);
    if (!c) {
      notify(`${partName} has custom cable routing, so its effects cannot be copied as a chain.`, 'warn');
      return;
    }
    if (c.effects.length === 0) {
      notify(`${partName} has no effects to copy (its Drive and Filter do nothing yet).`, 'info');
      return;
    }
    setEffectClipboard(c);
    notify(`Copied ${count(c.effects.length)} from ${c.from}: ${c.effects.map((e) => MODULE_DEFS[e.type].label).join(', ')}. Paste them onto another part.`, 'info');
  };

  const paste = (replace: boolean) => {
    setOpen(false);
    if (!clip) return;
    const r = cmd.pasteEffectChain(session.store, trackId, clip, { replace });
    if (!session.accepted(r)) return;
    const n = r.moduleIds?.length ?? 0;
    notify(
      replace
        ? `${possessive(partName)} effects are now the ${count(n)} copied from ${clip.from}${r.removed ? ` (${count(r.removed)} replaced)` : ''}.`
        : `Pasted ${count(n)} from ${clip.from} after ${possessive(partName)} effects.`,
      'info',
      'undo',
    );
  };

  const pasteReason = locked ? LOCKED_REASON : !clip ? 'Copy a part’s effects first.' : !linear ? `${partName} has custom cable routing.` : null;
  return (
    <span className={[shared.clipboard, className].filter(Boolean).join(' ')}>
      <Button
        id={`${idPrefix}-copy-effects`}
        size={size}
        variant="ghost"
        icon="copy"
        onClick={copy}
        tip={`Copy ${possessive(partName)} effects (with their settings as they sound now) to paste onto another part.`}
        detail="Kept until you close Omni Song. Big-knob mappings stay with each part."
      >
        Copy effects
      </Button>
      <Button
        ref={pasteRef}
        id={`${idPrefix}-paste-effects`}
        size={size}
        variant="ghost"
        icon="paste"
        iconRight="chevronDown"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={pasteReason !== null}
        onClick={() => setOpen((o) => !o)}
        tip={pasteReason ?? `Paste the ${count(clip!.effects.length)} copied from ${clip!.from} onto ${partName}: after its effects, or instead of them.`}
      >
        Paste effects
      </Button>
      {open && clip && (
        <Popover anchor={anchorFromElement(pasteRef.current)} label="Paste effects" onClose={() => setOpen(false)} returnFocus={pasteRef.current} ignore={pasteRef.current}>
          <MenuHeader eyebrow="Paste effects" title={`${count(clip.effects.length)} from ${clip.from}`} />
          <MenuItem icon="plus" disabled={locked} disabledReason={LOCKED_REASON} hint="keeps its own" onSelect={() => paste(false)}>
            After {possessive(partName)} effects
          </MenuItem>
          <MenuItem icon="paste" disabled={locked} disabledReason={LOCKED_REASON} hint="keeps Drive, Filter" onSelect={() => paste(true)}>
            Instead of {possessive(partName)} effects
          </MenuItem>
        </Popover>
      )}
    </span>
  );
}
