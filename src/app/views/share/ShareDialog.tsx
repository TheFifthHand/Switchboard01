/**
 * Share (EASY_SPEC §8): the one way out of the song in Simple.
 *
 *   ( ● A music file to send )  ( ○ The project, to keep working )
 *
 * A music file: the whole song (its length in m:ss), a Sound (the mastering
 * presets), [✓] As loud as streaming songs, a name, "More choices" (a smaller
 * .ogg file where the browser can make one, each instrument as its own file,
 * just the notes as a .mid, one section of the song) and Save to my computer.
 * The Sound and the loudness change only the file: it is rendered from a copy
 * of the project (share/fileMaker), so the song, its mastering and the undo
 * history stay exactly as they were. The result says what was saved in plain
 * words ("Saved “My beat.wav” — as loud as streaming songs").
 *
 * An empty song (no loops in it) offers no music file: "Your song is empty —
 * add a loop first"; nor does a song of loops with nothing in them yet ("add
 * sounds to your loop first"). A save marks the song shared, so the tip line
 * goes on to what to do next.
 *
 * The project: saves the portable project file (.omnisong.zip, the same file
 * as My projects › Export this project) named after the project, and says
 * where to find it.
 *
 * While a file is made the progress shows in the Save button's place, beside
 * Cancel; only Cancel stops it (a click outside or Esc does nothing then).
 * The last result is raised as a toast when the dialog closes.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Button, Dialog, Icon, Select, Switch, useToasts, type ToastApi } from '../../../ui/components';
import { MASTERING_PRESETS } from '../../../content/mastering';
import { songBars } from '../../../project/arrangement';
import type { RenderSource } from '../../../render/offline';
import type { NoteSource } from '../../../render/midi';
import { encodeOggOpus, opusSupported, opusSupportKnown, OPUS_RATE } from '../../../render/opus';
import { encodeWav } from '../../../render/wav';
import { session, useProject } from '../../instance';
import { songHasSound } from '../arrange/songHome';
import { noteShared } from '../arrange/tipMemory';
import { notify } from '../../runtime';
import { downloadBlob } from '../../download';
import { loudnessTarget } from '../mix/mixPrefs';
import {
  FILE_EXT,
  FILE_MIME,
  abortIfAsked,
  clockText,
  makeMidi,
  nameLosesCharacters,
  progressTracker,
  renderLoud,
  renderStemsZip,
  safeName,
  stereo,
  AS_IT_IS,
  currentSound,
  shareProject,
  type Busy,
  type FileFormat,
  type LoudFile,
  type LoudPhase,
} from './fileMaker';
import styles from './ShareDialog.module.css';

export type ShareChoice = 'music' | 'project';

/** A music file: WAV at CD quality plays everywhere. */
export const SHARE_WAV_RATE = 44100;
export const SHARE_WAV_DEPTH = 16;

export const SHARE_FORMAT: Record<FileFormat, { label: string; says: string }> = {
  wav: { label: 'Best quality (.wav)', says: 'Works everywhere: phones, computers, music apps and streaming services.' },
  opus: { label: 'Smaller file (.ogg)', says: 'About a tenth of the size, for sending to friends. Plays in web browsers and most music players.' },
  stems: { label: 'Each instrument as its own file (.zip)', says: 'One file for each instrument, each on its own, for another music app. The Sound and loudness choices do not apply.' },
  midi: { label: 'Just the notes, for another music app (.mid)', says: 'No sound: another music app plays the notes with its own instruments.' },
};

/** What each Sound does, in a beginner's words (the mastering presets' own sentences are for the Mix view). */
export const SOUND_SAYS: Record<string, string> = {
  clean: 'No change: your song exactly as you made it.',
  gentle: 'A light polish: a little smoother, brighter and louder.',
  warm: 'Rounder and cosier: fuller lows and softer highs.',
  punchy: 'Drums and bass hit harder and tighter.',
  bright: 'More sparkle and air on top, crisp and open.',
  wide: 'Sounds spread wider from left to right, with the bass kept in the middle.',
  loud: 'Dense and pushed hard, like a club track.',
  lofi: 'Old-radio sound: narrow, thin and a little crunchy.',
};

const PHASE: Record<LoudPhase, string> = { plain: 'Saving', measure: 'Listening to your song', louder: 'Making it louder', quieter: 'Making it quieter' };

/** The app's toasts; null where no ToastProvider is mounted (the dialog rendered on its own). */
function useToastsIfAny(): ToastApi | null {
  try {
    return useToasts();
  } catch {
    return null;
  }
}

interface Result {
  tone: 'ok' | 'error';
  text: string;
}

// Ask the browser early, so the dialog knows on its first render whether it can offer the smaller file.
void opusSupported();

export function ShareDialog(props: { onClose(): void; initialChoice?: ShareChoice }) {
  const { onClose } = props;
  const toasts = useToastsIfAny();
  const uid = useId();
  const projectName = useProject((p) => p.name);
  const sections = useProject((p) => p.arrangement.sections);
  const bars = useProject(songBars);
  // Loops with nothing in them yet (Make a beat before a square is clicked): a file of silence is no song to send.
  const silent = useProject((p) => songBars(p) > 0 && !songHasSound(p));
  const tail = useProject((p) => p.arrangement.tailSeconds);
  const sound0 = useProject(currentSound);
  // Lengths follow the tempo.
  const bpm = useProject((p) => p.bpm);

  const [choice, setChoice] = useState<ShareChoice>(props.initialChoice ?? 'music');
  const [sound, setSound] = useState<string>(sound0);
  const [loud, setLoud] = useState(true);
  const [format, setFormat] = useState<FileFormat>('wav');
  const [section, setSection] = useState<string>('song');
  const [more, setMore] = useState(false);
  const [filename, setFilename] = useState('');
  const [busy, setBusy] = useState<Busy | null>(null);
  const [message, setMessage] = useState<Result | null>(null);
  const [opusOk, setOpusOk] = useState(() => opusSupportKnown() ?? false);
  const abortRef = useRef<AbortController | null>(null);
  /** The last result, to raise as a toast once the dialog closes. */
  const pending = useRef<Result | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    void opusSupported().then((ok) => live && setOpusOk(ok));
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (message) resultRef.current?.scrollIntoView({ block: 'nearest' });
  }, [message]);

  const empty = bars === 0 || silent;
  const target = loudnessTarget();
  const loudLabel = target.id === 'streaming' ? 'As loud as streaming songs' : `As loud as the ${target.name} level`;
  const loudShort = loudLabel.replace(/^As/, 'as');
  const chosenSection = sections.find((s) => s.id === section);
  // A section removed meanwhile: the whole song.
  const sectionKey = chosenSection ? section : 'song';
  const source: RenderSource & NoteSource = chosenSection ? { kind: 'songRange', fromBar: chosenSection.start, toBar: chosenSection.start + chosenSection.bars } : { kind: 'song' };

  const lengthOf = (s: RenderSource) => {
    try {
      return clockText(session.renderPlan(s, 0).musicSeconds);
    } catch {
      return '';
    }
  };
  const sectionOptions = useMemo(
    () => [
      { value: 'song', label: `The whole song (${lengthOf({ kind: 'song' })})` },
      ...[...sections]
        .sort((a, b) => a.start - b.start)
        .map((s) => {
          const len = lengthOf({ kind: 'songRange', fromBar: s.start, toBar: s.start + s.bars });
          // Two sections with one name ("Lift" twice): say where each starts.
          const twin = sections.some((o) => o !== s && o.name === s.name);
          return { value: s.id, label: twin ? `${s.name}, from ${lengthOf({ kind: 'songRange', fromBar: 0, toBar: s.start })} (${len})` : `${s.name} (${len})` };
        }),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sections, bars, bpm],
  );

  const formats: FileFormat[] = opusOk ? ['wav', 'opus', 'stems', 'midi'] : ['wav', 'stems', 'midi'];
  const fmt = formats.includes(format) ? format : 'wav';
  const audioMix = fmt === 'wav' || fmt === 'opus';
  const baseName = chosenSection ? `${safeName(projectName)} - ${safeName(chosenSection.name)}` : safeName(projectName);
  const defaultFile = fmt === 'stems' ? `${baseName} (instruments)` : baseName;
  const typedName = filename.trim();
  const fileName = `${safeName(typedName || defaultFile)}.${FILE_EXT[fmt]}`;
  const nameHint = typedName && nameLosesCharacters(filename) ? `Saved as “${fileName}”: a file name cannot hold \\ / : * ? " < > |.` : null;
  const whatText = `${chosenSection ? chosenSection.name : 'The whole song'} · ${lengthOf(source)}`;

  const soundChips = [
    ...(sound0 === AS_IT_IS ? [{ id: AS_IT_IS, name: 'As you hear it', description: 'The sound your song has in Omni Song now.' }] : []),
    ...MASTERING_PRESETS.map((m) => ({ id: m.id, name: m.name, description: SOUND_SAYS[m.id] ?? m.description })),
  ];
  const chosenChip = soundChips.find((c) => c.id === sound) ?? soundChips[0];

  /** A choice changed: the last result no longer describes what Save would make. */
  const changed =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setMessage(null);
      pending.current = null;
    };

  const raise = (r: Result) => {
    if (toasts) toasts.show({ id: 'share', tone: r.tone === 'error' ? 'error' : 'info', message: r.text, duration: r.tone === 'error' ? 8000 : 6000 });
    else notify(r.text, r.tone === 'error' ? 'warn' : 'info');
  };
  const close = () => {
    if (abortRef.current) return;
    const r = pending.current;
    pending.current = null;
    onClose();
    if (r) raise(r);
  };
  const finish = (r: Result) => {
    setMessage(r);
    pending.current = r;
  };

  /** How the file ended up, in plain words (" — as loud as streaming songs, with the Warm sound"). */
  const describe = (made: LoudFile | null): string => {
    const bits: string[] = [];
    if (made) {
      if (made.reached) bits.push(loudShort);
      else if (made.stop === 'quiet') bits.push('at the level it plays (too quiet to make louder: are its instruments muted?)');
      else if (made.reading > target.lufs) bits.push(`a little louder than ${loudShort.replace(/^as loud as /, '')}`);
      else bits.push(`louder, but not quite ${loudShort}`);
    }
    if (chosenChip.id !== sound0 && chosenChip.id !== AS_IT_IS) bits.push(`with the ${chosenChip.name} sound`);
    return bits.length ? ` — ${bits.join(', ')}` : '';
  };

  const saveMusic = async (signal: AbortSignal): Promise<string> => {
    const name = fileName;
    const project = session.store.getState();
    if (fmt === 'midi') {
      const { bytes, tracks } = makeMidi(project, source);
      downloadBlob(new Blob([bytes as BlobPart], { type: FILE_MIME.midi }), name);
      return `Saved “${name}” — the notes of ${tracks} instrument${tracks === 1 ? '' : 's'}, for another music app. Find it in your Downloads.`;
    }
    if (fmt === 'stems') {
      const { zip, names } = await renderStemsZip({
        project,
        source,
        depth: SHARE_WAV_DEPTH,
        signal,
        render: (p, i, n, part) =>
          session.renderAudio({ source, sampleRate: SHARE_WAV_RATE, tailSeconds: tail, mastering: false, signal, onProgress: progressTracker(setBusy, `Instrument ${i + 1} of ${n} (${part})`), project: p }),
      });
      abortIfAsked(signal);
      downloadBlob(new Blob([zip as BlobPart], { type: FILE_MIME.stems }), name);
      return `Saved “${name}” — one file for each of ${names.length} instrument${names.length === 1 ? '' : 's'} (${names.join(', ')}). Find it in your Downloads.`;
    }
    const sampleRate = fmt === 'opus' ? OPUS_RATE : SHARE_WAV_RATE;
    const made = await renderLoud({
      base: shareProject(project, chosenChip.id, loud),
      loud,
      targetLufs: target.lufs,
      signal,
      render: (p, o) => session.renderAudio({ source, sampleRate, tailSeconds: tail, signal, onProgress: progressTracker(setBusy, PHASE[o.phase], o.passesAfter), project: p }),
    });
    abortIfAsked(signal);
    let blob: Blob;
    if (fmt === 'opus') {
      const bytes = await encodeOggOpus(stereo(made.buffer), { title: projectName, signal, onProgress: progressTracker(setBusy, 'Making the smaller file') });
      blob = new Blob([bytes as BlobPart], { type: FILE_MIME.opus });
    } else blob = new Blob([encodeWav(stereo(made.buffer), made.buffer.sampleRate, SHARE_WAV_DEPTH)], { type: FILE_MIME.wav });
    abortIfAsked(signal);
    downloadBlob(blob, name);
    return `Saved “${name}”${describe(loud ? made : null)}. Find it in your Downloads.`;
  };

  const saveProject = async (): Promise<string> => {
    const { blob, filename: name } = await session.exportProjectFile();
    downloadBlob(blob, name);
    return `Saved “${name}” — your whole project, with its sounds and recordings. Find it in your Downloads. To keep working on it later, or on another computer: My projects › Import project file…`;
  };

  const start = async () => {
    const controller = new AbortController();
    abortRef.current = controller;
    pending.current = null;
    setMessage(null);
    setBusy({ phase: 'Saving', fraction: 0, left: null });
    try {
      const text = choice === 'project' ? await saveProject() : await saveMusic(controller.signal);
      if (choice === 'music') session.exportSaved();
      // The tip line goes on to what to do next.
      noteShared(session.store.getState().id);
      finish({ tone: 'ok', text });
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') finish({ tone: 'error', text: 'Cancelled. Nothing was saved.' });
      else finish({ tone: 'error', text: `Could not save the file: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(null);
      abortRef.current = null;
    }
  };

  // Escape closes the dialog from a focused list box too (a native select may keep the key to itself).
  const onFormKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || busy || !(e.target instanceof HTMLSelectElement)) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };

  const pct = choice === 'project' ? 100 : Math.round((busy?.fraction ?? 0) * 100);
  const busyText = !busy ? '' : choice === 'project' ? 'Saving…' : `${busy.phase}… ${pct}%${busy.left ? ` · ${busy.left}` : ''}`;
  const canSave = choice === 'project' || !empty;

  return (
    <Dialog
      open
      dismissible={!busy}
      onClose={close}
      title="Share your song"
      size="lg"
      actions={
        busy ? (
          <>
            {choice === 'music' && (
              <Button variant="secondary" onClick={() => abortRef.current?.abort()}>
                Cancel
              </Button>
            )}
            <div
              className={styles.progress}
              role="progressbar"
              aria-label="Saving"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              aria-valuetext={busyText}
              data-testid="share-progress"
            >
              <span className={styles.progressFill} style={{ width: `${pct}%` }} aria-hidden="true" />
              <span className={styles.progressText}>{busyText}</span>
            </div>
          </>
        ) : canSave ? (
          <Button variant="primary" icon="download" onClick={() => void start()}>
            Save to my computer
          </Button>
        ) : null
      }
    >
      <div className={styles.form} onKeyDown={onFormKey}>
        <div className={styles.choices} role="radiogroup" aria-label="What to share">
          {(
            [
              ['music', 'wave', 'A music file to send', 'To play anywhere, post or send to a friend.'],
              ['project', 'save', 'The project, to keep working', 'Everything in it, to open again in Omni Song.'],
            ] as const
          ).map(([value, icon, title, says]) => (
            <label key={value} className={styles.choice} data-checked={choice === value || undefined}>
              <input type="radio" name={`${uid}-choice`} value={value} checked={choice === value} onChange={() => changed(setChoice)(value)} disabled={!!busy} />
              <span className={styles.choiceTitle}>
                <Icon name={icon} size={16} />
                {title}
              </span>
              <span className={styles.choiceSays}>{says}</span>
            </label>
          ))}
        </div>

        {choice === 'project' && (
          <p className={styles.text} data-testid="share-project-says">
            Saves “{projectName}” as one file (.omnisong.zip): the song, its instruments, sounds and recordings. Open it again later, or on another computer, to keep working.
          </p>
        )}

        {choice === 'music' && empty && (
          <p className={styles.empty} data-testid="share-empty">
            <Icon name="info" size={16} />
            {silent ? 'Your song makes no sound yet — add sounds to your loop first.' : 'Your song is empty — add a loop first.'}
          </p>
        )}

        {choice === 'music' && !empty && (
          <>
            <p className={styles.what} data-testid="share-what">
              {whatText}
            </p>

            {audioMix && (
              <fieldset className={styles.group} disabled={!!busy}>
                <legend className={styles.label}>Sound</legend>
                <div className={styles.chips}>
                  {soundChips.map((c) => (
                    <label key={c.id} className={styles.chip} data-checked={chosenChip.id === c.id || undefined}>
                      <input type="radio" name={`${uid}-sound`} value={c.id} checked={chosenChip.id === c.id} onChange={() => changed(setSound)(c.id)} />
                      {chosenChip.id === c.id && <Icon name="check" size={12} />}
                      {c.name}
                    </label>
                  ))}
                </div>
                <p className={styles.hint} data-testid="share-sound-says">
                  {chosenChip.description}
                  {chosenChip.id === sound0 && chosenChip.id !== AS_IT_IS ? ' This is how your song sounds now.' : ''}
                </p>
              </fieldset>
            )}

            {audioMix && (
              <div className={styles.group}>
                <Switch label={loudLabel} checked={loud} onChange={changed(setLoud)} disabled={!!busy} tip="Makes the file as loud as songs on streaming services, without distortion. Only the file changes." />
                <p className={styles.hint} data-testid="share-file-only">
                  The Sound and loudness change only the file. Your song stays as it is.
                </p>
              </div>
            )}

            <div className={styles.fileField}>
              <label className={styles.file}>
                <span>Name</span>
                <input
                  type="text"
                  value={filename}
                  placeholder={defaultFile}
                  onChange={(e) => {
                    setFilename(e.target.value);
                    setMessage(null);
                    pending.current = null;
                  }}
                  disabled={!!busy}
                  maxLength={80}
                  aria-describedby={nameHint ? `${uid}-name-hint` : undefined}
                />
                <span className={styles.ext} data-testid="share-ext">
                  .{FILE_EXT[fmt]}
                </span>
              </label>
              {nameHint && (
                <p id={`${uid}-name-hint`} className={styles.hint}>
                  {nameHint}
                </p>
              )}
            </div>

            <button type="button" className={styles.moreToggle} aria-expanded={more} aria-controls={`${uid}-more`} onClick={() => setMore((m) => !m)}>
              <Icon name={more ? 'chevronDown' : 'chevronRight'} size={14} />
              More choices
            </button>
            {more && (
              <div id={`${uid}-more`} className={styles.more}>
                <fieldset className={styles.group} disabled={!!busy}>
                  <legend className={styles.label}>Kind of file</legend>
                  {formats.map((f) => (
                    <label key={f} className={styles.radio}>
                      <input type="radio" name={`${uid}-format`} value={f} checked={fmt === f} onChange={() => changed(setFormat)(f)} />
                      {SHARE_FORMAT[f].label}
                    </label>
                  ))}
                  <p className={styles.hint} data-testid="share-format-says">
                    {SHARE_FORMAT[fmt].says}
                  </p>
                </fieldset>
                {sectionOptions.length > 1 && <Select label="How much of the song" value={sectionKey} options={sectionOptions} onChange={changed(setSection)} disabled={!!busy} />}
              </div>
            )}
          </>
        )}

        {message && (
          <div ref={resultRef} className={message.tone === 'ok' ? styles.ok : styles.error} role="status" data-testid="share-result">
            <Icon name={message.tone === 'ok' ? 'check' : 'warning'} size={16} />
            <span>{message.text}</span>
          </div>
        )}
      </div>
    </Dialog>
  );
}
