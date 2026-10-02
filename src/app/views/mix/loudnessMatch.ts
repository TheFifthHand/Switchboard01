/**
 * Loudness readings that belong to what is heard now, and Match target.
 *
 * Fresh readings (MIX-01). The integrated loudness averages everything since
 * the measurement last restarted, so after a change to what the output sounds
 * like (mastering on or off, a preset, a mastering knob, the master volume, or
 * the end of an A/B comparison) it still holds the old setting. While the
 * Mastering panel is open it watches those settings: a change marks the
 * readings as "measuring the new setting"; once the change is committed (no
 * further change for COMMIT_QUIET_MS: the end of a drag or a key burst) the
 * measurement restarts (session.resetLoudness). Until FRESH_MS of music has
 * played since then, the status line and Match use the short-term loudness,
 * and Match waits until that 3-second window holds only the new setting, so
 * it never acts on a reading of the old one. Part faders do not count: they
 * change one part, and the readings follow within the short-term window.
 *
 * Match target (MIX-17). Match moves the mastering Loudness control by the
 * difference between the target and the reading. The limiter swallows part of
 * a push, so while the music plays Match checks again after each fresh
 * 3-second reading and corrects again, until it is within MATCH_TOLERANCE_DB
 * or MATCH_PASSES passes have been made ("Matching… 2/3"). Stopping playback,
 * a change made by hand, another target, the A/B or leaving the view stops it.
 * Each pass is one undo step (the match command's own).
 *
 * Display and timing only: nothing here times audio.
 */
import { MASTERING_LOCKED_MESSAGE, matchLoudnessTarget, type LoudnessMatch } from '../../../state/commands';
import { createStore, useStore } from '../../../state/store';
import type { Project } from '../../../project/types';
import { meterWake } from '../../../ui/components';
import { session } from '../../instance';
import { notify, runtimeStore, type RuntimeState } from '../../runtime';
import { formatDb, formatLoudness } from './mixMeters';
import { loudnessTarget } from './mixPrefs';

/** Music needed after a restart before a reading holds only the new setting (the short-term window). */
export const FRESH_MS = 3000;
/** A change counts as committed once nothing else changed for this long (the end of a drag or key burst). */
export const COMMIT_QUIET_MS = 300;
/** Match stops once the reading is this close to the target (dB). */
export const MATCH_TOLERANCE_DB = 0.5;
/** Match corrects at most this many times. */
export const MATCH_PASSES = 3;
/** Within this many dB the status line says "on the target". */
export const ON_TARGET_DB = 1;

const MINUS = '−';
export const minusLufs = (lufs: number) => `${lufs < 0 ? MINUS : ''}${Math.abs(lufs)} LUFS`;

export interface LoudnessReading {
  integrated: number;
  shortTerm: number;
}

export interface MatchState {
  /** Something that changes the output's loudness changed; the readings are being taken again. */
  measuring: boolean;
  /** Match at work: passes made so far (0 while waiting for the first fresh reading). */
  matching: { applied: number } | null;
  /** What Match did or why it could not (shown under the button); null for nothing to say. */
  result: string | null;
  /** The Loudness control before the first pass and after the last one. */
  lastMatch: { before: number; after: number } | null;
}

const store = createStore<MatchState>({ measuring: false, matching: null, result: null, lastMatch: null });

function patch(next: Partial<MatchState>): void {
  store.setState((s) => {
    for (const k of Object.keys(next) as (keyof MatchState)[]) if (next[k] !== s[k]) return { ...s, ...next };
    return s;
  });
}

export function matchState(): MatchState {
  return store.getState();
}

export function useMatchState<T>(selector: (s: MatchState) => T): T {
  return useStore(store, selector);
}

/* ------------------------------------------------------------------ */
/* Fresh audio since the measurement restarted                         */
/* ------------------------------------------------------------------ */

/** Music played (ms) since the measurement last restarted, not counting the time now running. */
let freshMs = 0;
/** performance.now() when playback last started or resumed, while it runs. */
let runningSince: number | null = null;
let commitTimer: number | null = null;
/** Set while Match applies a pass: that change is Match's own, not one made by hand. */
let applying = false;

const isRunning = (s: Pick<RuntimeState, 'playing' | 'paused'>) => s.playing && !s.paused;

/** Music played since the measurement last restarted (ms). */
export function freshAudioMs(now = performance.now()): number {
  return freshMs + (runningSince !== null ? Math.max(0, now - runningSince) : 0);
}

/** Restart the measurement now: integrated loudness and true peak start again from the next block. */
function restart(): void {
  if (commitTimer !== null) window.clearTimeout(commitTimer);
  commitTimer = null;
  session.resetLoudness();
  freshMs = 0;
  runningSince = isRunning(runtimeStore.getState()) ? performance.now() : null;
  meterWake();
}

/**
 * What the output sounds like changed: `manual` (a setting, restarted once the
 * change is committed), `match` (a pass of Match), `compare` (the A/B ended).
 */
export function loudnessChanged(kind: 'manual' | 'match' | 'compare'): void {
  if (kind !== 'match' && store.getState().matching) stopMatch(kind === 'manual' ? 'Matching stopped: a setting changed.' : null);
  patch({ measuring: true });
  if (kind === 'manual') {
    if (commitTimer !== null) window.clearTimeout(commitTimer);
    commitTimer = window.setTimeout(restart, COMMIT_QUIET_MS);
    meterWake();
  } else restart();
}

/** Called a few times a second while readings are shown: the readings become fresh after FRESH_MS of music. */
function settle(now: number): void {
  const s = store.getState();
  if (s.measuring && commitTimer === null && freshAudioMs(now) >= FRESH_MS) patch({ measuring: false });
}

interface Snapshot {
  id: string;
  enabled: boolean;
  presetId: string | undefined;
  params: Project['mastering']['params'];
  volume: number;
}

const snap = (p: Project): Snapshot => ({ id: p.id, enabled: p.mastering.enabled, presetId: p.mastering.presetId, params: p.mastering.params, volume: p.masterVolumeDb });
const sameSound = (a: Snapshot, b: Snapshot) => a.enabled === b.enabled && a.presetId === b.presetId && a.params === b.params && a.volume === b.volume;
/** What was last seen (kept while the panel is closed, so changes made elsewhere meanwhile count too). */
let seen: Snapshot | null = null;

function observe(p: Project): void {
  const next = snap(p);
  const prev = seen;
  seen = next;
  if (!prev || sameSound(prev, next)) return;
  if (prev.id !== next.id) {
    // Another project: its own measurement starts with its playback.
    if (store.getState().matching) stopMatch(null);
    patch({ measuring: false, result: null, lastMatch: null });
    restart();
    return;
  }
  loudnessChanged(applying ? 'match' : 'manual');
}

let wasPaused = false;

function onRuntime(s: RuntimeState): void {
  const now = performance.now();
  const running = isRunning(s);
  if (running && runningSince === null) {
    // A fresh start restarts the engine's measurement too (a resume from Pause does not).
    if (!wasPaused) freshMs = 0;
    runningSince = now;
  } else if (!running && runningSince !== null) {
    freshMs += now - runningSince;
    runningSince = null;
    if (store.getState().matching) stopMatch('Matching stopped: the music stopped.');
  }
  wasPaused = s.paused;
}

/**
 * Watch the settings that change the output's loudness, and playback (call
 * while the Mastering panel is shown; returns the stop function).
 */
export function watchLoudness(): () => void {
  observe(session.store.getState());
  const s = runtimeStore.getState();
  wasPaused = s.paused;
  runningSince = isRunning(s) ? (runningSince ?? performance.now()) : null;
  const offStore = session.store.subscribe(observe);
  const offRuntime = runtimeStore.subscribe(onRuntime);
  return () => {
    offStore();
    offRuntime();
    if (commitTimer !== null) {
      // The change is committed now: the readings shown next time are of it.
      restart();
    }
    if (store.getState().matching) stopMatch(null);
  };
}

/** Tests: forget everything watched and measured. */
export function resetLoudnessWatch(): void {
  if (commitTimer !== null) window.clearTimeout(commitTimer);
  commitTimer = null;
  seen = null;
  freshMs = 0;
  runningSince = null;
  applying = false;
  store.setState(() => ({ measuring: false, matching: null, result: null, lastMatch: null }));
}

/* ------------------------------------------------------------------ */
/* What the readings say                                               */
/* ------------------------------------------------------------------ */

export interface Basis {
  which: 'Integrated' | 'Short-term';
  v: number;
}

/** The reading to compare with the target: integrated when it is of what is heard now, else short-term. */
export function readingBasis(r: LoudnessReading, measuring = store.getState().measuring): Basis | null {
  if (!measuring && Number.isFinite(r.integrated)) return { which: 'Integrated', v: r.integrated };
  if (Number.isFinite(r.shortTerm)) return { which: 'Short-term', v: r.shortTerm };
  return null;
}

/** "Integrated: 2.4 dB louder than the Streaming target, −14 LUFS." */
export function distanceText(b: Basis, targetLufs: number, targetName: string): string {
  const diff = b.v - targetLufs;
  return Math.abs(diff) < ON_TARGET_DB
    ? `${b.which}: on the ${targetName} target, ${minusLufs(targetLufs)} (within ${ON_TARGET_DB} dB).`
    : `${b.which}: ${Math.abs(diff).toFixed(1)} dB ${diff < 0 ? 'quieter' : 'louder'} than the ${targetName} target, ${minusLufs(targetLufs)}.`;
}

/** Advice after a match that hit the end of the Loudness range (null when it did not). */
function limitAdvice(r: LoudnessMatch): string | null {
  if (r.limit === 'max') return 'That is as far as Loudness goes. To get louder still, raise the parts or the master volume.';
  if (r.limit === 'min') return 'Loudness is now at 0 dB. To get quieter still, lower the master volume.';
  return null;
}

/* ------------------------------------------------------------------ */
/* Match                                                               */
/* ------------------------------------------------------------------ */

export function stopMatch(message: string | null): void {
  patch({ matching: null, ...(message !== null ? { result: message } : {}) });
}

/** Forget what the last match said (another target was chosen, the readings were reset). */
export function clearMatchResult(): void {
  if (store.getState().matching) stopMatch(null);
  patch({ result: null });
}

/**
 * Press of Match target. With a reading of what is heard now it corrects at
 * once (and, while the music plays, goes on checking); while the readings are
 * still of an earlier setting it waits for a fresh one.
 */
export function startMatch(r: LoudnessReading): void {
  const s = store.getState();
  if (s.matching) return;
  const playing = isRunning(runtimeStore.getState());
  patch({ result: null, lastMatch: null });
  if (s.measuring) {
    if (!playing) {
      patch({ result: 'Play your song to measure the new setting, then match.' });
      return;
    }
    patch({ matching: { applied: 0 } });
    return;
  }
  const b = readingBasis(r, false);
  if (!b) {
    patch({ result: 'Play your song for a few seconds to measure it first.' });
    return;
  }
  if (playing) patch({ matching: { applied: 0 } });
  pass(b, playing);
}

/** Apply one correction from `b`. */
function pass(b: Basis, playing: boolean): void {
  const t = loudnessTarget();
  const m = store.getState().matching;
  const applied = m?.applied ?? 0;
  const diff = b.v - t.lufs;
  if (applied > 0 && Math.abs(diff) <= MATCH_TOLERANCE_DB) {
    finish(`On the ${t.name} target: ${b.which.toLowerCase()} ${formatLoudness(b.v)} after ${applied === 1 ? 'one pass' : `${applied} passes`}.`);
    return;
  }
  if (applied >= MATCH_PASSES) {
    finish(`${Math.abs(diff).toFixed(1)} dB ${diff < 0 ? 'quieter' : 'louder'} than the ${t.name} target after ${MATCH_PASSES} passes: the limiter holds the peaks. Match again to go on.`);
    return;
  }
  applying = true;
  let r: LoudnessMatch;
  try {
    r = matchLoudnessTarget(session.store, t.lufs, b.v);
  } finally {
    applying = false;
  }
  if (r.refused) {
    // The only refusal left once the panel allows a match: a performance take locks mastering.
    finish(null);
    notify(MASTERING_LOCKED_MESSAGE, 'warn');
    return;
  }
  if (!r.changed) {
    finish(
      r.message ??
        (r.limit === 'min'
          ? `Louder than the ${t.name} target already, with Loudness at 0 dB. Lower the master volume to get quieter.`
          : r.limit === 'max'
            ? `Quieter than the ${t.name} target, with Loudness already at its most (${formatDb(r.after)}). Raise the parts or the master volume to get louder.`
            : `Already on the ${t.name} target.`),
    );
    return;
  }
  const first = store.getState().lastMatch;
  patch({ lastMatch: { before: first?.before ?? r.before, after: r.after } });
  const advice = limitAdvice(r);
  const going = playing && !advice;
  notify(
    `Loudness drive ${formatDb(r.before)} → ${formatDb(r.after)} to aim for ${minusLufs(t.lufs)} (the ${b.which.toLowerCase()} reading was ${formatLoudness(b.v)}).${going ? ' Checking again in a few seconds.' : advice ? '' : ' Play on, then match again to fine-tune.'}`,
    'info',
    'undo',
  );
  if (going) patch({ matching: { applied: applied + 1 } });
  else finish(advice);
}

function finish(message: string | null): void {
  patch({ matching: null, result: message });
}

/**
 * A few times a second, with the latest readings: the readings become fresh,
 * and Match makes its next pass once a fresh reading is in.
 */
export function loudnessTick(now: number, r: LoudnessReading): void {
  settle(now);
  const s = store.getState();
  if (!s.matching || s.measuring) return;
  if (!isRunning(runtimeStore.getState())) {
    stopMatch('Matching stopped: the music stopped.');
    return;
  }
  // The first pass may use the integrated reading; later passes the fresh 3-second one.
  const b = s.matching.applied === 0 ? readingBasis(r, false) : Number.isFinite(r.shortTerm) ? { which: 'Short-term' as const, v: r.shortTerm } : null;
  if (b) pass(b, true);
}
