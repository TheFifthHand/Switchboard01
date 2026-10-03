/**
 * Edits of a part's recording as new versions (Normalize, Reverse, Crop,
 * Fade in, Fade out, Gain).
 *
 * The audio the part plays is read (the live sample bank, the stored file,
 * or the built-in generator), edited off the audio thread's way in plain
 * arrays (sampleEdit.ts), encoded as a WAV, stored in this browser like an
 * import (same limits and storage messages), and put on the part in one undo
 * step. The previous version stays in the project while anything else uses
 * it; Undo brings it back on the part either way.
 */
import { generateBuiltinSample } from '../../../audio/instruments/builtinSamples';
import { audioBufferFromChannels } from '../../../audio/instruments/sampleBank';
import { builtinSampleInfo } from '../../../content/catalog';
import { encodeMadeAudio } from '../../../persistence/audioImport';
import * as db from '../../../persistence/db';
import type { Id } from '../../../project/types';
import * as cmd from '../../../state/commands';
import { createStore } from '../../../state/store';
import { session as appSession } from '../../instance';
import type { Session } from '../../session';
import { isBuiltinId } from './sampleOverview';
import { EDIT_LABEL, applySampleEdit, editSummary, versionName, type SampleEdit } from './sampleEdit';
import { readSamplerValues } from './samplerValues';

export interface SampleAudio {
  channels: Float32Array[];
  sampleRate: number;
}

/** The audio of a recording as the part plays it, or null when this browser does not hold it. */
export async function loadSampleAudio(sampleId: Id, s: Session = appSession): Promise<SampleAudio | null> {
  const live = s.bank?.get(sampleId);
  if (live) return { channels: Array.from({ length: live.numberOfChannels }, (_, c) => live.getChannelData(c)), sampleRate: live.sampleRate };
  if (isBuiltinId(sampleId)) {
    const gen = generateBuiltinSample(sampleId, s.ctx?.sampleRate ?? 48000);
    return gen && gen.channels.length ? { channels: gen.channels, sampleRate: gen.sampleRate } : null;
  }
  const rec = await db.getSample(sampleId).catch(() => null);
  if (!rec) return null;
  const rate = s.ctx?.sampleRate ?? (rec.meta.sampleRate > 0 ? rec.meta.sampleRate : 48000);
  try {
    const buffer = await new OfflineAudioContext(1, 1, rate).decodeAudioData(await rec.blob.arrayBuffer());
    return { channels: Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c)), sampleRate: buffer.sampleRate };
  } catch {
    return null;
  }
}

/** Per part: an edit being made (only one at a time), and the last result. */
export type EditStatus = { phase: 'idle' } | { phase: 'working'; kind: SampleEdit['kind'] } | { phase: 'done'; ok: boolean; message: string };

export const editStore = createStore<Record<Id, EditStatus>>({});

// Results belong to the project they happened in: opening another project clears them.
appSession.store.subscribe((p, prev) => {
  if (p.id !== prev.id && Object.keys(editStore.getState()).length > 0) editStore.setState({});
});

const setStatus = (trackId: Id, st: EditStatus) => editStore.setState((s) => ({ ...s, [trackId]: st }));

/** Forget a shown result. */
export function clearEditStatus(trackId: Id): void {
  if (editStore.getState()[trackId]?.phase === 'done') setStatus(trackId, { phase: 'idle' });
}

const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Make a new version of the part's recording with `edit` applied to its
 * trimmed region, and play it on the part (one undo step). With `slot`, the
 * recording that clip plays itself (Clip.sample) and its own region are
 * edited instead, and only that clip moves to the new version. The project
 * is unchanged when anything fails; the result says what happened.
 */
export async function editRecording(trackId: Id, edit: SampleEdit, s: Session = appSession, opts: { slot?: number } = {}): Promise<{ ok: boolean; message: string }> {
  if (editStore.getState()[trackId]?.phase === 'working') return { ok: false, message: 'An edit is still being made. Wait for it to finish.' };
  const finish = (ok: boolean, message: string) => {
    setStatus(trackId, { phase: 'done', ok, message });
    return { ok, message };
  };
  try {
    return await makeVersion(trackId, edit, s, finish, opts.slot);
  } catch (e) {
    // Whatever went wrong, the edit ends with a message and the keys work again.
    return finish(false, `The edit could not be made: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function makeVersion(
  trackId: Id,
  edit: SampleEdit,
  s: Session,
  finish: (ok: boolean, message: string) => { ok: boolean; message: string },
  slot?: number,
): Promise<{ ok: boolean; message: string }> {
  const lock = s.store.getLock();
  if (lock) return finish(false, lock);
  const p = s.store.getState();
  const projectId = p.id;
  const track = p.tracks.find((t) => t.id === trackId);
  const inst = track?.instrument;
  const own = slot !== undefined ? track?.clips[slot]?.sample : undefined;
  if (slot !== undefined && (!own || inst?.kind !== 'sampler')) return finish(false, 'This clip has no recording of its own to edit.');
  if (!own && (inst?.kind !== 'sampler' || !inst.sampleId)) return finish(false, 'This part has no recording to edit.');
  const sampleId = own ? own.id : (inst as { sampleId: Id }).sampleId;
  // What plays: the clip's own region, or the part's effective Start and End (a macro may move them).
  const region = own ? { start: own.start, end: own.end } : readSamplerValues(p, trackId, ['start', 'end']);
  setStatus(trackId, { phase: 'working', kind: edit.kind });
  await yieldToUi();
  const audio = await loadSampleAudio(sampleId, s);
  if (!audio) return finish(false, 'This recording’s audio is not in this browser, so it cannot be edited.');
  const res = applySampleEdit(audio.channels, audio.sampleRate, region.start, region.end, edit);
  if (!res.ok) return finish(false, res.message);
  await yieldToUi();
  const baseName = isBuiltinId(sampleId) ? (builtinSampleInfo(sampleId)?.name ?? 'Recording') : (p.samples.find((x) => x.id === sampleId)?.name ?? 'Recording');
  // res.channels is already clipped to full scale: the bank plays exactly what the WAV keeps.
  const made = encodeMadeAudio(versionName(baseName, s.store.getState().samples.map((x) => x.name)), res.channels, audio.sampleRate);
  if (!made.ok) return finish(false, made.message);
  const stored = await s.storeSample(made.meta, made.blob, s.ctx ? audioBufferFromChannels(res.channels, audio.sampleRate) : null);
  if (!stored.ok) return finish(false, stored.message);
  const r =
    s.store.getState().id !== projectId
      ? { changed: false, refused: undefined, message: 'Another project opened, so the edit was not applied.' }
      : cmd.addSampleVersion(s.store, trackId, sampleId, made.meta, { label: EDIT_LABEL[edit.kind], region: res.region ?? undefined, slot: own ? slot : undefined });
  if (!r.changed) {
    // Nothing refers to the stored file: it goes again.
    s.bank?.remove(made.meta.id);
    void db.deleteSample(made.meta.id).catch(() => undefined);
    return finish(false, r.refused ?? r.message ?? 'The edit could not be applied.');
  }
  return finish(true, `${editSummary(edit, res)} Now playing “${made.meta.name}”. Undo goes back.`);
}
