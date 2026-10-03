/**
 * The Channel drawer: the selected part's insert effects, edited in place, so
 * tone and dynamics decisions do not need a trip to Shape. It takes the
 * mastering's place (beside the mixer, or under it), so the mixer keeps its
 * faders and meters in sight, and scrolls inside itself.
 *
 *   CHANNEL  3 Bass ──────────────────────────────── [×]
 *   [+ Add EQ] [+ Add Compressor] [Open in Shape]
 *   (why the keys are off, when they are: a take, the limit, custom routing)
 *   [ the part's effects rack, as in Shape: cards, channel, shared returns ]
 *
 * The rack is Shape's own EffectsRack (the same cards, knobs and commands).
 * Add EQ and Add Compressor insert one more effect at the end of the part's
 * chain (insertEffect: one undo step, refused during a performance take, at
 * the effect limit and on custom routing). When they cannot, they stay
 * focusable (aria-disabled) and the reason is shown in words above the rack.
 * Opening the drawer ends an A/B comparison (its key is hidden meanwhile).
 */
import { useEffect, useId, useRef } from 'react';
import { Button, Icon, IconButton, Panel } from '../../../ui/components';
import { MODULE_DEFS, PATCH_LIMITS } from '../../../project/modules';
import type { Id, ModuleType } from '../../../project/types';
import * as cmd from '../../../state/commands';
import { useStore } from '../../../state/store';
import { selectModule, selectTrack, setView } from '../../../state/uiStore';
import { session, useProject, useUi } from '../../instance';
import { notify } from '../../runtime';
import { EffectsRack } from '../shape/EffectsRack';
import { closeChannelDrawer, useChannelDrawer } from './channelDrawer';
import { releaseCompare } from './compare';
import { chainEffectCount } from './mixState';
import styles from './ChannelDrawer.module.css';

const QUICK: readonly { type: ModuleType; words: string; tip: string }[] = [
  { type: 'eq', words: 'Add EQ', tip: 'Add an EQ at the end of this part’s effects: lows, mids, highs, low cut and high cut. It starts flat (changes nothing) until you turn a band.' },
  { type: 'compressor', words: 'Add Compressor', tip: 'Add a compressor at the end of this part’s effects: it evens out loud and quiet moments. Its meter shows how much it turns down.' },
];

export function ChannelDrawer(props: { className?: string }) {
  const { open, seq } = useChannelDrawer();
  const selected = useUi((s) => s.selectedTrackId);
  const trackId = useProject<Id | null>((p) => (p.tracks.some((t) => t.id === selected) ? selected : (p.tracks[0]?.id ?? null)));
  const index = useProject((p) => p.tracks.findIndex((t) => t.id === trackId));
  const name = useProject((p) => p.tracks.find((t) => t.id === trackId)?.name ?? '');
  const count = useProject((p) => (trackId ? chainEffectCount(p, trackId) : null));
  const lock = useStore(session.store.info, (s) => s.lock);
  const ref = useRef<HTMLDivElement>(null);
  const noteId = useId();

  // The drawer covers the mastering (and its A/B key): hear the mastering again.
  useEffect(() => {
    if (open) releaseCompare();
  }, [open]);

  // Opened (or asked for again from a strip): bring it into view.
  useEffect(() => {
    if (!open) return;
    const el = ref.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    return () => cancelAnimationFrame(raf);
  }, [open, seq]);

  if (!open || !trackId) return null;
  const custom = count === null;
  const full = count !== null && count >= PATCH_LIMITS.maxEffectsPerTrack;
  const why = lock ? 'A performance is recording: effects cannot be added or removed until it stops. Their knobs still work.' : custom ? `${name} has custom routing: place effects with the cables in Shape.` : full ? `${name} has ${PATCH_LIMITS.maxEffectsPerTrack} effects, the most a part can hold. Remove one to add an EQ or a compressor.` : null;

  const add = (type: ModuleType) => {
    if (why) return;
    const r = cmd.insertEffect(session.store, trackId, type);
    if (!session.accepted(r)) return;
    if (r.moduleId) selectModule(r.moduleId);
    notify(`Added ${MODULE_DEFS[type].label === 'EQ' ? 'an EQ' : `a ${MODULE_DEFS[type].label}`} to ${name}, at the end of its effects.`, 'info', 'undo');
  };
  const openInShape = () => {
    selectTrack(trackId);
    setView('shape');
  };

  return (
    <div ref={ref} className={[styles.drawer, props.className].filter(Boolean).join(' ')} data-testid="channel-drawer">
      <Panel
        title="Channel"
        subtitle={
          <span className={styles.part}>
            <span className="mono">{index + 1}</span> {name}
          </span>
        }
        className={styles.panel}
        bodyClassName={styles.body}
        actions={<IconButton icon="close" size="sm" label="Close the Channel drawer" onClick={closeChannelDrawer} />}
      >
        <div className={styles.keys} role="group" aria-label={`${name} channel`}>
          {QUICK.map((q) => (
            <Button
              key={q.type}
              size="sm"
              variant="secondary"
              icon="plus"
              aria-disabled={why !== null || undefined}
              data-blocked={why !== null ? '' : undefined}
              aria-describedby={why ? noteId : undefined}
              onClick={() => add(q.type)}
              tip={why ?? q.tip}
            >
              {q.words}
            </Button>
          ))}
          <Button size="sm" variant="ghost" icon="sliders" onClick={openInShape} tip={`Open ${name} in Shape: its instrument, big knobs and effects together.`}>
            Open in Shape
          </Button>
        </div>
        {why && (
          <p id={noteId} className={styles.note} role="note" data-testid="channel-drawer-note">
            {lock && <Icon name="lock" size={13} />} {why}
          </p>
        )}
        <EffectsRack trackId={trackId} className={styles.rack} />
      </Panel>
    </div>
  );
}
