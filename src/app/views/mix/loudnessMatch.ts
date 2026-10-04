/**
 * Loudness readings that belong to what is heard now, and Match target.
 *
 * Fresh readings (MIX-01). The integrated loudness averages everything since
 * the measurement last restarted, so after a change to what the output sounds
 * like (mastering on or off, a preset, a mastering knob, the master volume, or
 * the end of an A/B comparison) it still holds the old setting. From the
 * moment the app loads (not only while Mix is open, so a change made in
 * another view counts too) this module watches those settings: a change marks
 * the readings as "measuring the new setting"; once the change is committed
 * (no further change for COMMIT_QUIET_MS: the end of a drag or a key burst)
 * the measurement restarts (session.resetLoudness). Until FRESH_MS of music
 * has played since then, the status line and Match use the short-term
 * loudness, and Match waits until that 3-second window holds only the new
 * setting, so it never acts on a reading of the old one. Part faders do not
 * mark the readings: they change one part, and the readings follow within the
 * short-term window.
 *
 * Match target (MIX-17). Match moves the mastering Loudness drive by the
 * difference between the target and the reading. The limiter swallows part of
 * a push, so while the music plays Match checks again after each fresh
 * 3-second reading and corrects again, scaling each correction by how far the
 * last one actually moved the reading (a secant step, clamped), until it is
 * within MATCH_TOLERANCE_DB or MATCH_PASSES passes have been made ("Matching…
 * 2/3"). One pass moves the drive at most MATCH_STEP_DB. Match only acts on
 * readings of the music it is matching: it stops (with a message) on any
 * project change it did not make itself (a part fader, Solo, Mute, a setting),
 * Mute All, stopping playback, another target, the A/B or leaving the view,
 * and it skips readings quieter than MATCH_FLOOR_LUFS or more than
 * MATCH_JUMP_DB away from the last one. All passes of one press share one
 * gesture: one undo step, one toast.
 *
 * Display and timing only: nothing here times audio.
 */
import { MASTERING_LOCKED_MESSAGE, matchLoudnessTarget, type LoudnessMatch } from '../../../state/commands';
import { createStore, useStore } from '../../../state/store';
import { MASTERING_PARAMS, readParam } from '../../../project/params';
import type { Project } from '../../../project/types';
import { meterWake, newGestureId } from '../../../ui/components';
import { session } from '../../instance';
import { notify, runtimeStore, type RuntimeState } from '../../runtime';
import { formatDb, formatLoudness } from './mixMeters';
import { loudnessTarget } from './mixPrefs';

/** Music needed after a restart before a reading holds only the new setting (the short-term window). */
export const FRESH_MS = 3000;
/** A change counts as committed once nothing else changed for this long (the end of a drag or key burst). */
export const COMMIT_QUIET_MS = 300;
/** Match stops once the reading is this close to the target (dB); a first reading this close changes nothing. */
export const MATCH_TOLERANCE_DB = 0.5;
/** Match corrects at most this many times. */
export const MATCH_PASSES = 3;
/** One pass moves Loudness drive at most this far (dB). */
export const MATCH_STEP_DB = 6;
/** Readings quieter than this are not music to match (LUFS): silence, everything muted. */
export const MATCH_FLOOR_LUFS = -40;
/** A reading this far (dB) from the last one is not what a pass did: something else changed the output. */
export const MATCH_JUMP_DB = 12;
/** Match stops after waiting this long (ms of music) for a reading it can use. */
export const MATCH_WAIT_MS = 8000;
/** How much a pass may be scaled by what the last one did (reading dB per drive dB). */
const SLOPE_MIN = 0.25;
const SLOPE_MAX = 1.2;
/** Within this many dB the status line says "on the target". */
export const ON_TARGET_DB = 1;

export const STOPPED_CHANGE = 'Matching stopped: something else in the project changed. Match again when it sounds right.';
export const STOPPED_MUTE_ALL = 'Matching stopped: Mute All is on. Turn it off, then match again.';
export const STOPPED_PLAYBACK = 'Matching stopped: the music stopped.';
export const STOPPED_COMPARE = 'Matching stopped for the A/B comparison. Match again after it.';
export const STOPPED_QUIET = 'Matching stopped: the music went quiet. Play your song with the parts up, then match again.';
export const STOPPED_LEFT = 'Matching stopped when you left Mix.';
export const STOPPED_UNSTEADY = 'Matching stopped: the song itself got louder or quieter after the last pass. Match again in a steady part.';

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
  if (kind !== 'match' && store.getState().matching) stopMatch(kind === 'manual' ? STOPPED_CHANGE : null);
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
/** What was last seen (watched from load, so changes made in any view count). */
let seen: Snapshot | null = null;
/** The last project seen: any other project state is a change. */
let seenProject: Project | null = null;

function observe(p: Project): void {
  if (p === seenProject) return;
  seenProject = p;
  const next = snap(p);
  const prev = seen;
  seen = next;
  // Any change Match did not make itself (a part fader, Solo, Mute, an edit anywhere) ends a match.
  if (!applying && store.getState().matching) stopMatch(prev && prev.id !== next.id ? null : STOPPED_CHANGE);
  if (!prev || sameSound(prev, next)) return;
  if (prev.id !== next.id) {
    // Another project: its own measurement starts with its playback.
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
    if (store.getState().matching) stopMatch(STOPPED_PLAYBACK);
  }
  wasPaused = s.paused;
  if (s.muteAll && store.getState().matching) stopMatch(STOPPED_MUTE_ALL);
}

let watching = false;

/** Start watching the project and playback (once, when the app loads). */
function startLoudnessWatch(): void {
  if (watching) return;
  watching = true;
  syncWatch();
  session.store.subscribe(observe);
  runtimeStore.subscribe(onRuntime);
}

/** Take the project and playback as they are now as the starting point. */
function syncWatch(): void {
  const p = session.store.getState();
  seenProject = p;
  seen = snap(p);
  const s = runtimeStore.getState();
  wasPaused = s.paused;
  runningSince = isRunning(s) ? (runningSince ?? performance.now()) : null;
}

if (typeof window !== 'undefined') startLoudnessWatch();

/**
 * While the Mastering panel is shown (returns the function to call when it
 * goes): Match only runs while its readings are on screen.
 */
export function watchLoudness(): () => void {
  startLoudnessWatch();
  return () => {
    if (store.getState().matching) stopMatch(STOPPED_LEFT);
  };
}

/** Tests: forget everything measured and start watching from the project and playback as they are now. */
export function resetLoudnessWatch(): void {
  if (commitTimer !== null) window.clearTimeout(commitTimer);
  commitTimer = null;
  freshMs = 0;
  runningSince = null;
  applying = false;
  run = null;
  focusRequested = false;
  store.setState(() => ({ measuring: false, matching: null, result: null, lastMatch: null }));
  startLoudnessWatch();
  syncWatch();
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
  if (r.limit === 'max') return 'That is as far as Loudness drive goes. To get louder still, raise the parts or the master volume.';
  if (r.limit === 'min') return 'Loudness drive is now at 0 dB. To get quieter still, lower the master volume.';
  return null;
}

/* ------------------------------------------------------------------ */
/* Match                                                               */
/* ------------------------------------------------------------------ */

/**
 * One press of Match: its undo gesture, the reading the last pass acted on and the drive it was
 * taken at, what a dB of drive did to the reading, and the wait for a usable reading.
 */
interface Run {
  gesture: string;
  last: { v: number; drive: number } | null;
  slope: number;
  waitedMs: number;
  /** A toast tied to this press's undo step was shown. */
  told: boolean;
}

let run: Run | null = null;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const passesText = (n: number) => (n === 1 ? 'one pass' : `${n} passes`);

export function stopMatch(message: string | null): void {
  run = null;
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
  const rt = runtimeStore.getState();
  const playing = isRunning(rt);
  patch({ result: null, lastMatch: null });
  if (rt.muteAll) {
    patch({ result: 'Mute All is on: turn it off so Match can hear your song.' });
    return;
  }
  if (s.measuring) {
    if (!playing) {
      patch({ result: 'Play your song to measure the new setting, then match.' });
      return;
    }
    run = { gesture: newGestureId('match'), last: null, slope: 1, waitedMs: 0, told: false };
    patch({ matching: { applied: 0 } });
    return;
  }
  const b = readingBasis(r, false);
  if (!b) {
    patch({ result: 'Play your song for a few seconds to measure it first.' });
    return;
  }
  run = { gesture: newGestureId('match'), last: null, slope: 1, waitedMs: 0, told: false };
  if (playing) patch({ matching: { applied: 0 } });
  pass(b, playing);
}

/** Apply one correction from `b`. */
function pass(b: Basis, playing: boolean): void {
  const cur = run;
  if (!cur) return;
  const t = loudnessTarget();
  const applied = store.getState().matching?.applied ?? 0;
  const diff = b.v - t.lufs;
  if (b.v < MATCH_FLOOR_LUFS) {
    finish(applied === 0 ? `Too quiet to match (${formatLoudness(b.v)}). Play your song with the parts up, then match.` : STOPPED_QUIET);
    return;
  }
  if (Math.abs(diff) <= MATCH_TOLERANCE_DB) {
    finish(
      applied === 0
        ? `Already on the ${t.name} target: ${b.which.toLowerCase()} ${formatLoudness(b.v)} (within ${MATCH_TOLERANCE_DB} dB).`
        : `On the ${t.name} target: ${b.which.toLowerCase()} ${formatLoudness(b.v)} after ${passesText(applied)}.`,
    );
    return;
  }
  if (applied >= MATCH_PASSES) {
    finish(`${Math.abs(diff).toFixed(1)} dB ${diff < 0 ? 'quieter' : 'louder'} than the ${t.name} target after ${MATCH_PASSES} passes: the limiter holds the peaks. Match again to go on.`);
    return;
  }
  const drive = readParam(MASTERING_PARAMS, session.store.getState().mastering.params, 'loudness');
  if (cur.last && Math.abs(drive - cur.last.drive) >= 0.05) {
    // What the last pass did to the reading, per dB of drive (the limiter takes part of a push).
    const observed = (b.v - cur.last.v) / (drive - cur.last.drive);
    if (observed <= 0 && Math.abs(drive - cur.last.drive) >= 1) {
      // The reading went the other way: the song itself got louder or quieter (a breakdown, a drop).
      finish(STOPPED_UNSTEADY);
      return;
    }
    cur.slope = clamp(observed, SLOPE_MIN, SLOPE_MAX);
  }
  const correction = clamp(-diff / cur.slope, -MATCH_STEP_DB, MATCH_STEP_DB);
  applying = true;
  let r: LoudnessMatch;
  try {
    // The command moves the drive by (target − measured): hand it the measurement that asks for `correction`.
    r = matchLoudnessTarget(session.store, t.lufs, t.lufs - correction, cur.gesture);
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
          ? `Louder than the ${t.name} target already, with Loudness drive at 0 dB. Lower the master volume to get quieter.`
          : r.limit === 'max'
            ? `Quieter than the ${t.name} target, with Loudness drive already at its most (${formatDb(r.after)}). Raise the parts or the master volume to get louder.`
            : `Already on the ${t.name} target.`),
    );
    return;
  }
  // This reading was taken at the drive before this pass: the next reading, at r.after, shows what the pass did.
  cur.last = { v: b.v, drive: r.before };
  cur.waitedMs = 0;
  const first = store.getState().lastMatch;
  const before = first?.before ?? r.before;
  patch({ lastMatch: { before, after: r.after } });
  const advice = limitAdvice(r);
  const going = playing && !advice;
  if (going) {
    patch({ matching: { applied: applied + 1 } });
    if (!cur.told) {
      cur.told = true;
      notify(
        `Matching the ${t.name} target: Loudness drive ${formatDb(before)} → ${formatDb(r.after)} (the ${b.which.toLowerCase()} reading was ${formatLoudness(b.v)}). Checking again in a few seconds.`,
        'info',
        'undo',
      );
    }
    return;
  }
  notify(
    `Loudness drive ${formatDb(before)} → ${formatDb(r.after)} to aim for ${minusLufs(t.lufs)} (the ${b.which.toLowerCase()} reading was ${formatLoudness(b.v)}).${advice ? '' : playing ? '' : ' Play on, then match again to fine-tune.'}`,
    'info',
    'undo',
  );
  cur.told = true;
  finish(advice, false);
}

/** Match is done: say why under the button, and sum up in the toast (one per press, tied to its undo step). */
function finish(message: string | null, toast = true): void {
  const cur = run;
  const m = store.getState().lastMatch;
  run = null;
  patch({ matching: null, result: message });
  if (toast && cur?.told && m && message) {
    // Only while this press's step is the newest: the toast's Undo takes all its passes back.
    notify(`Loudness drive ${formatDb(m.before)} → ${formatDb(m.after)}. ${message}`, 'info', 'undo');
  }
}

/**
 * A few times a second, with the latest readings: the readings become fresh,
 * and Match makes its next pass once a fresh reading of the music is in.
 * `dtMs`: time since the last call (counts towards the wait for a usable reading).
 */
export function loudnessTick(now: number, r: LoudnessReading, dtMs = 0): void {
  settle(now);
  const s = store.getState();
  if (!s.matching || s.measuring) return;
  const rt = runtimeStore.getState();
  if (!isRunning(rt)) {
    stopMatch(STOPPED_PLAYBACK);
    return;
  }
  if (rt.muteAll) {
    stopMatch(STOPPED_MUTE_ALL);
    return;
  }
  const cur = run;
  if (!cur) {
    stopMatch(null);
    return;
  }
  // The first pass may use the integrated reading; later passes the fresh 3-second one.
  const b = s.matching.applied === 0 ? readingBasis(r, false) : Number.isFinite(r.shortTerm) ? { which: 'Short-term' as const, v: r.shortTerm } : null;
  // Not a reading of the music being matched: silence, or a jump no pass could make.
  const usable = b !== null && b.v >= MATCH_FLOOR_LUFS && (!cur.last || Math.abs(b.v - cur.last.v) <= MATCH_JUMP_DB);
  if (!usable) {
    cur.waitedMs += Math.max(0, dtMs);
    if (cur.waitedMs >= MATCH_WAIT_MS) finish(STOPPED_QUIET);
    return;
  }
  pass(b, true);
}

/* ------------------------------------------------------------------ */
/* "Match target in Mix" from elsewhere                                */
/* ------------------------------------------------------------------ */

let focusRequested = false;
const focusListeners = new Set<() => void>();

/** Ask the Mastering panel to bring Match target into view and focus it (now if it is shown, else when it next shows). */
export function requestMatchFocus(): void {
  focusRequested = true;
  for (const l of focusListeners) l();
}

/** The panel listens while shown. */
export function onMatchFocusRequest(listener: () => void): () => void {
  focusListeners.add(listener);
  return () => focusListeners.delete(listener);
}

/** The panel takes the request (true once per request). */
export function takeMatchFocusRequest(): boolean {
  const r = focusRequested;
  focusRequested = false;
  return r;
}
