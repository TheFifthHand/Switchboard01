/**
 * Shared bits for the pads-keys tests (keyboard strip, kit keys, drum grid, chord pads, key
 * change): the whole app through r4-play-helpers, plus a recorder for what the instrument asks
 * the session to play and a real right-click.
 */
import { act } from 'react';
import { session } from '../../src/app/instance';
import type { NoteSource } from '../../src/app/session';
import type { Id } from '../../src/project/types';
import { uiStore } from '../../src/state/uiStore';
import { send, settleFrames, toPage, type Pt } from './r4-uikit-input';

export type Played = { on: boolean; trackId: Id; pitch: number; velocity?: number; source: NoteSource };

/** Record (instead of play) the notes the instrument sends to the session; restore() puts the real ones back. */
export function recordPlayed(): { played: Played[]; ons: () => Played[]; restore(): void } {
  const played: Played[] = [];
  const realOn = session.noteOn;
  const realOff = session.noteOff;
  session.noteOn = (trackId, pitch, velocity, source) => void played.push({ on: true, trackId, pitch, velocity, source });
  session.noteOff = (trackId, pitch, source) => void played.push({ on: false, trackId, pitch, source });
  return {
    played,
    ons: () => played.filter((p) => p.on),
    restore() {
      session.noteOn = realOn;
      session.noteOff = realOff;
    },
  };
}

/** A real right-click (contextmenu) at `p`. */
export async function rightClick(p: Pt): Promise<void> {
  const q = toPage(p);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: q.x, y: q.y, button: 'none', buttons: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: q.x, y: q.y, button: 'right', buttons: 2, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: q.x, y: q.y, button: 'right', buttons: 0, clickCount: 1 });
  await settleFrames();
}

/** Forget the keyboard's per-view folding (the tests share one browser's storage). */
export function resetKeyboardFold(): void {
  act(() => uiStore.setState((s) => ({ ...s, keyboardCollapsed: false, keyboardCollapsedByView: {}, notesChords: { on: false, size: 3 } })));
}

export const strip = () => document.querySelector<HTMLElement>('section[aria-label="Keyboard"]')!;
export const keyboard = () => document.querySelector<HTMLElement>('[role="group"][aria-label^="Keyboard playing"]')!;
