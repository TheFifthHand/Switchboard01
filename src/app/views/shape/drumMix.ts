/**
 * Simple Shape's Drum mix: which of a kit's voices its knobs move.
 *
 * The voices are grouped by role (standard kits: Kick, Snare & clap, Hats,
 * Percussion, Toms, Cymbals; percussion kits: Low drums, High drums,
 * Shakers, Percussion). The mix shows the groups the part's clips actually
 * play, so every knob is heard: the three it plays most, in that order; a
 * part with no notes yet shows the first three. A group knob moves all of its voices
 * together and keeps their balance, also through 0 (the balance is
 * remembered per part). The tune knob tunes the first group's most played
 * voice ("Kick tune").
 *
 * Pure (no React, no audio): unit-tested in tests/unit/r4-shape-logic.test.ts.
 */
import { getKitVoiceNames } from '../../../audio/instruments/kits';
import { kitInfo } from '../../../content/catalog';
import { DRUM_VOICE_PARAM_SPECS, clampParam } from '../../../project/params';
import type { Id, Track } from '../../../project/types';

export interface MixGroup {
  key: string;
  /** "Snare & clap", or the voice's own name when the part plays only one of the group ("Clap"). */
  label: string;
  /** Every voice it moves (they keep their balance). */
  slots: readonly number[];
  /** The voice whose level the knob shows: the group's most played one. */
  lead: number;
  /** The names of the voices it moves, for its tooltip. */
  names: readonly string[];
}

interface Role {
  key: string;
  label: string;
  slots(names: readonly string[]): number[];
}

const isHat = (name: string | undefined) => /hat/i.test(name ?? '');

const KIT_ROLES: readonly Role[] = [
  { key: 'kick', label: 'Kick', slots: () => [0, 1] },
  { key: 'snare', label: 'Snare & clap', slots: () => [2, 3] },
  { key: 'hats', label: 'Hats', slots: (n) => (isHat(n[6]) ? [4, 5, 6] : [4, 5]) },
  { key: 'perc', label: 'Percussion', slots: (n) => (isHat(n[6]) ? [7, 11, 14, 15] : [6, 7, 11, 14, 15]) },
  { key: 'toms', label: 'Toms', slots: () => [8, 9, 10] },
  { key: 'cymbals', label: 'Cymbals', slots: () => [12, 13] },
];

const PERCUSSION_ROLES: readonly Role[] = [
  { key: 'low', label: 'Low drums', slots: () => [0, 1] },
  { key: 'high', label: 'High drums', slots: () => [2, 3] },
  { key: 'shakers', label: 'Shakers', slots: () => [4, 5, 6] },
  { key: 'perc', label: 'Percussion', slots: () => [7, 8, 9, 10, 11, 12, 13, 14, 15] },
];

/** How many notes of each voice (slot) the part's clips play. */
export function playedSlots(track: Pick<Track, 'clips'>): Map<number, number> {
  const out = new Map<number, number>();
  for (const c of track.clips) {
    if (!c) continue;
    for (const n of c.notes) {
      const s = Math.round(n.pitch);
      if (s >= 0 && s < 16) out.set(s, (out.get(s) ?? 0) + 1);
    }
  }
  return out;
}

/** A compact, stable key of `playedSlots` ("0:16,3:8,4:32"), for memoising the groups. */
export function playedKey(played: ReadonlyMap<number, number>): string {
  return [...played.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([s, n]) => `${s}:${n}`)
    .join(',');
}

/** The Drum mix's level knobs for a kit and the voices the part plays (at most three). */
export function drumMixGroups(kitId: string, played: ReadonlyMap<number, number>): MixGroup[] {
  const names = getKitVoiceNames(kitId);
  const roles = (kitInfo(kitId)?.family ?? 'kit') === 'kit' ? KIT_ROLES : PERCUSSION_ROLES;
  const nameOf = (s: number) => names[s] ?? `Sound ${s + 1}`;
  const count = (s: number) => played.get(s) ?? 0;
  const any = played.size > 0;
  const total = (r: Role) => r.slots(names).reduce((n, s) => n + count(s), 0);
  let chosen = any ? roles.filter((r) => total(r) > 0) : roles.slice(0, 3);
  if (chosen.length > 3) {
    // The three groups the part plays most, still in role order.
    const keep = new Set([...chosen].sort((a, b) => total(b) - total(a)).slice(0, 3));
    chosen = chosen.filter((r) => keep.has(r));
  }
  return chosen.map((r) => {
    const slots = r.slots(names);
    const heard = slots.filter((s) => count(s) > 0);
    const lead = heard.length ? heard.reduce((a, b) => (count(b) > count(a) ? b : a)) : slots[0];
    return { key: r.key, label: heard.length === 1 ? nameOf(heard[0]) : r.label, slots, lead, names: slots.map(nameOf) };
  });
}

/** The voice the tune knob tunes: the first group's lead ("Kick"), with its name. */
export function drumTuneVoice(kitId: string, groups: readonly MixGroup[]): { slot: number; name: string } {
  const slot = groups[0]?.lead ?? 0;
  return { slot, name: getKitVoiceNames(kitId)[slot] ?? `Sound ${slot + 1}` };
}

/** A group's balance: each voice's level as a share of the lead's, and the levels last written with it. */
export interface Balance {
  ratios: readonly number[];
  written: readonly number[];
}

const balances = new Map<string, Balance>();
const same = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 1e-9);

/**
 * The levels of a group's voices (in `group.slots` order) when its knob is
 * set to `v`: the lead at `v`, the others keeping their balance with it. The
 * balance is read from the current levels unless they are the ones this knob
 * last wrote (then the remembered balance holds, so turning the group down to
 * 0 or past the top and back keeps it); with the lead at 0 and nothing
 * remembered, every voice goes to `v`.
 */
export function groupLevels(group: MixGroup, current: readonly number[], v: number, memo?: Balance): { levels: number[]; memo: Balance } {
  const li = Math.max(0, group.slots.indexOf(group.lead));
  const lead = current[li] ?? 0;
  let ratios: readonly number[];
  if (memo && memo.ratios.length === current.length && same(memo.written, current)) ratios = memo.ratios;
  else if (lead > 1e-3) ratios = current.map((x) => x / lead);
  else ratios = memo && memo.ratios.length === current.length ? memo.ratios : current.map(() => 1);
  const levels = ratios.map((r, i) => (i === li ? clampParam(DRUM_VOICE_PARAM_SPECS.level, v) : clampParam(DRUM_VOICE_PARAM_SPECS.level, v * r)));
  return { levels, memo: { ratios, written: levels } };
}

/** groupLevels with the balance remembered for this part's group (for the session). */
export function setGroupLevels(trackId: Id, group: MixGroup, current: readonly number[], v: number): number[] {
  const key = `${trackId}\u0000${group.key}`;
  const r = groupLevels(group, current, v, balances.get(key));
  balances.set(key, r.memo);
  return r.levels;
}
