/**
 * Scenes → song: when a loop is made on a pad (drawn, tapped, chosen, pasted
 * or recorded) in a scene the song plays, offer once, for that loop, to add
 * it where the scene plays: "Add Bass 2 to the song where Groove plays (2
 * places)?" [Add] (songActions.addClipWhereScenePlays, one undo step).
 *
 * It watches the project for a pad loop with a new id made by an edit (not
 * an undo or redo, another project, or a new part), one at a time: an edit
 * that makes several (a scene pasted) offers nothing. A loop made while a
 * pad is being recorded is offered once the recording stops, if it is still
 * there and holds notes; nothing is offered for a loop made while a performance records, or
 * for the song's own copies (Put on a pad, made `quietly`). The offer goes
 * away when its loop does.
 */
import type { Clip, Id, Project } from '../../../project/types';
import { session } from '../../instance';
import { notify, offer, runtimeStore, withdrawOffer } from '../../runtime';
import { addClipWhereScenePlays } from './songActions';
import { sceneOfferText, scenePlaces } from './songModel';

let quiet = 0;

/** Run an edit whose new pad loops the song itself made (no offer for them). */
export function quietly<T>(fn: () => T): T {
  quiet += 1;
  try {
    return fn();
  } finally {
    quiet -= 1;
  }
}

/** Where a pad loop is now (pads stay put, but look it up by id anyway). */
function padRow(p: Project, trackId: Id, clipId: Id): number {
  const t = p.tracks.find((x) => x.id === trackId);
  return t ? t.clips.findIndex((c) => c?.id === clipId) : -1;
}

/** Offer the loop if the song plays its scene somewhere this part is free (once per loop). */
function offerFor(trackId: Id, clipId: Id, offered: Set<Id>, showing: { current: { trackId: Id; clipId: Id } | null }): void {
  if (offered.has(clipId)) return;
  const p = session.store.getState();
  const row = padRow(p, trackId, clipId);
  if (row < 0) return;
  const places = scenePlaces(p, row, trackId);
  if (!places.length) return;
  offered.add(clipId);
  const clip = p.tracks.find((t) => t.id === trackId)!.clips[row]!;
  const scene = p.scenes[row]?.name || `Scene ${row + 1}`;
  const projectId = p.id;
  showing.current = { trackId, clipId };
  offer(sceneOfferText(clip.name, scene, places.length), 'Add', () => {
    showing.current = null;
    const now = session.store.getState();
    const at = now.id === projectId ? padRow(now, trackId, clipId) : -1;
    if (at < 0) {
      notify(`${clip.name} is no longer on its pad, so nothing was added.`, 'warn');
      return;
    }
    addClipWhereScenePlays(trackId, at);
  });
}

/** Start watching (App, once). Returns the stop function. */
export function watchSceneOffers(): () => void {
  const offered = new Set<Id>();
  const showing: { current: { trackId: Id; clipId: Id } | null } = { current: null };
  /** Pad loops made during a pad recording, offered when it stops. */
  let pending: { trackId: Id; clipId: Id }[] = [];
  let projectId = session.store.getState().id;
  /** Each part's pads as last seen (immer keeps the array while nothing on them changed). */
  let pads = new Map<Id, readonly (Clip | null)[]>();
  const remember = (p: Project) => {
    pads = new Map(p.tracks.map((t) => [t.id, t.clips]));
  };
  remember(session.store.getState());

  const offProject = session.store.subscribe((p) => {
    const before = pads;
    remember(p);
    const shown = showing.current;
    if (shown && padRow(p, shown.trackId, shown.clipId) < 0) {
      showing.current = null;
      withdrawOffer();
    }
    if (p.id !== projectId) {
      projectId = p.id;
      pending = [];
      if (showing.current) {
        showing.current = null;
        withdrawOffer();
      }
      return;
    }
    if (session.store.lastChange().kind !== 'edit' || quiet > 0) return;
    const made: { trackId: Id; clipId: Id }[] = [];
    for (const t of p.tracks) {
      const old = before.get(t.id);
      if (!old || old === t.clips) continue;
      const known = new Set(old.map((c) => c?.id));
      for (const c of t.clips) if (c && !known.has(c.id)) made.push({ trackId: t.id, clipId: c.id });
    }
    if (made.length !== 1) return;
    const rt = runtimeStore.getState();
    if (rt.recording === 'performance') return;
    if (rt.recording !== 'off') pending.push(made[0]);
    else offerFor(made[0].trackId, made[0].clipId, offered, showing);
  });
  const offRuntime = runtimeStore.subscribe((s, prev) => {
    if (s.recording !== 'off' || prev.recording === 'off' || !pending.length) return;
    const waiting = pending;
    pending = [];
    // A performance that ran meanwhile made the song's own changes: nothing then.
    if (prev.recording === 'performance') return;
    const p = session.store.getState();
    for (const m of waiting) {
      // Only a take that kept something (a pass with no notes leaves an empty loop: nothing to add).
      const c = p.tracks.find((t) => t.id === m.trackId)?.clips.find((x) => x?.id === m.clipId);
      if (c && (c.notes.length > 0 || c.sample)) offerFor(m.trackId, m.clipId, offered, showing);
    }
  });
  return () => {
    offProject();
    offRuntime();
  };
}
