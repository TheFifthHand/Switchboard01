/**
 * Song view edits of the time line and of the sections' order, each one
 * undoable song command run through the session: insert empty bars, take
 * bars out, move a section to another place in the order (ripple, as
 * GarageBand's arrangement track does), or one place earlier or later.
 *
 * Edits made from a menu or a key say what happened, with Undo; a drag says
 * nothing (the timeline shows the result). While a performance take records
 * the song is locked, and an edit is refused at once with one plain line.
 */
import type { Id } from '../../../project/types';
import * as songCmd from '../../../state/commands';
import type { SongEditResult } from '../../../state/commands';
import { session } from '../../instance';
import { notify } from '../../runtime';
import { setSelection } from './laneStore';
import { LOCKED_TEXT, songLocked } from './songActions';
import { barsText, rangeText } from './songModel';

/** How many bars "Insert … bars here" offers. */
export const INSERT_CHOICES = [4, 8] as const;

function lockedNow(): boolean {
  if (!songLocked()) return false;
  notify(LOCKED_TEXT, 'warn');
  return true;
}

function said(text: string): void {
  notify(text, 'info', 'undo');
}

/** Empty bars inserted at bar `at` (0-based): everything from there moves later. */
export function insertBarsAt(at: number, bars: number): SongEditResult | null {
  if (lockedNow()) return null;
  const r = songCmd.insertBars(session.store, at, bars);
  if (session.accepted(r)) said(`Inserted ${barsText(bars)} at bar ${at + 1}`);
  return r;
}

/** Bars [from, to) taken out: what lay there goes and everything after moves earlier. */
export function removeBarsRange(from: number, to: number): SongEditResult | null {
  if (lockedNow()) return null;
  const r = songCmd.removeBars(session.store, from, to);
  if (session.accepted(r)) said(`Removed ${rangeText(from, to).toLowerCase()}`);
  return r;
}

/** A section moved to just before `before` (null: to the end) with its music; its loops are selected. */
export function reorderSectionTo(id: Id, before: Id | null, opts: { say?: boolean } = {}): SongEditResult | null {
  if (lockedNow()) return null;
  const r = songCmd.reorderSection(session.store, id, before);
  if (!session.accepted(r)) return r;
  if (r.ids?.length) setSelection({ ids: [...r.ids], focus: r.ids[0] });
  if (opts.say) said(session.store.undoLabel() ?? 'Moved the section');
  return r;
}

/** A section one place earlier (-1) or later (1) with its music (the section menu's Move earlier / Move later, Alt+← →). */
export function moveSectionStepNow(id: Id, dir: -1 | 1): SongEditResult | null {
  if (lockedNow()) return null;
  const r = songCmd.moveSectionStep(session.store, id, dir);
  if (!session.accepted(r)) return r;
  if (r.ids?.length) setSelection({ ids: [...r.ids], focus: r.ids[0] });
  const name = session.store.getState().arrangement.sections.find((s) => s.id === id)?.name ?? 'The section';
  said(`${name} moved ${dir < 0 ? 'earlier' : 'later'}`);
  return r;
}
