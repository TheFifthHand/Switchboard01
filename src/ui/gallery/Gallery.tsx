/**
 * Component gallery: every kit component in its states, on a console-like
 * background, for visual review (the app shows it at ?gallery; the dev
 * server also serves /gallery.html).
 *
 * Nothing here makes sound — there is no audio engine on this page. The
 * meters are driven by an explicitly labelled "Demo signal" knob, never by a
 * fake animation.
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { DRUM_SLOTS } from '../../content/catalog';
import { scaleMask } from '../../music/scales';
import { BPM_SPEC, CHANNEL_PARAMS, DELAY_PARAMS, MASTER_VOLUME_SPEC, POLY_PARAMS, SWING_SPEC, BASS_PARAMS, FILTER_PARAMS, specById, type ParamSpec } from '../../project/params';
import {
  Button,
  Dialog,
  Icon,
  ICON_NAMES,
  IconButton,
  Knob,
  Led,
  Meter,
  MiniKeyboard,
  Notice,
  NumberField,
  Pad,
  Panel,
  SegmentedControl,
  Select,
  Switch,
  TipsProvider,
  ToastProvider,
  useToasts,
  noteName,
  type PadState,
} from '../components';
import { drumKeyHint, noteKeyLabels, useComputerKeyboard, useKeyCapLabels } from '../hooks/useComputerKeyboard';
import styles from './Gallery.module.css';

/* ------------------------------------------------------------------ */
/* Demo data (visual only)                                             */
/* ------------------------------------------------------------------ */

const spec = (specs: readonly ParamSpec[], id: string): ParamSpec => {
  const s = specById(specs, id);
  if (!s) throw new Error(`Gallery: missing spec ${id}`);
  return s;
};

const macro = (id: string, label: string, tip: string, detail: string): ParamSpec => ({ id, label, min: 0, max: 1, default: 0, unit: '%', curve: 'lin', tip, detail });

const MACROS: readonly ParamSpec[] = [
  macro('tone', 'Tone', 'Makes the selected part brighter or darker.', 'Sweeps the instrument filter cutoff, plus a high shelf on bright sounds.'),
  macro('space', 'Space', 'Adds a room around this sound.', 'Reverb send amount.'),
  macro('echo', 'Echo', 'Adds echoes in time with the beat.', 'Tempo-synced delay send.'),
  macro('motion', 'Motion', 'Makes the sound move and breathe in time.', 'Fades in the tempo-synced LFO on the filter cutoff.'),
  macro('drive', 'Drive', 'Warms the sound up, then makes it crunchy.', 'Pre-gain into a soft clipper, level-compensated.'),
  macro('pump', 'Pump', 'Makes the part duck and swell with the beat.', 'Tempo-synced ducking envelope. It follows the beat grid; it does not listen to other parts.'),
];

const DEMO_SIGNAL: ParamSpec = {
  id: 'demo',
  label: 'Demo signal',
  min: 0,
  max: 1.2,
  default: 0.5,
  unit: '',
  curve: 'lin',
  tip: 'Drives the meters on this page so their states can be reviewed. It is not audio.',
  detail: 'Linear peak value; above 0.99 lights the clip lamps.',
};

const TRACKS = ['Drums', 'Percussion', 'Bass', 'Chords', 'Lead', 'Pad', 'Texture', 'Sampler'] as const;
const SCENES = ['Intro', 'Groove', 'Lift', 'Break'] as const;

type Cell = { state: PadState; name: string };
const c = (state: PadState, name = ''): Cell => ({ state, name });
/** [track][row] */
const INITIAL_MATRIX: Cell[][] = [
  [c('ready', 'Soft Four'), c('playing', 'Steady'), c('ready', 'Push'), c('ready', 'Half Time')],
  [c('ready', 'Shaker'), c('playing', 'Clave Run'), c('empty'), c('ready', 'Toms')],
  [c('ready', 'Root Pulse'), c('playing', 'Walker'), c('queued', 'Octaves'), c('ready', 'Hold')],
  [c('ready', 'Wash'), c('playing', 'Stabs'), c('ready', 'Lift Stabs'), c('empty')],
  [c('empty'), c('recording', 'Hook'), c('ready', 'Hook High'), c('ready', 'Echo Line')],
  [c('ready', 'Air'), c('ready', 'Air Wide'), c('ready', 'Swell'), c('empty')],
  [c('ready', 'Drift'), c('stopping', 'Grain'), c('empty'), c('empty')],
  [c('empty'), c('empty'), c('ready', 'Glass Hit'), c('empty')],
];

const PAD_MODES = [
  { value: 'loops', label: 'Loops' },
  { value: 'drums', label: 'Drums' },
  { value: 'notes', label: 'Notes' },
  { value: 'steps', label: 'Steps' },
] as const;
type PadMode = (typeof PAD_MODES)[number]['value'];

const VIEWS = [
  { value: 'play', label: 'Play', tip: 'Pads, sound controls and keyboard.' },
  { value: 'shape', label: 'Shape', tip: 'Macros, effects and cables.' },
  { value: 'arrange', label: 'Arrange', tip: 'Put scenes in order to make a song.' },
] as const;
type View = (typeof VIEWS)[number]['value'];

const KEY_MODES = [
  { value: 'notes', label: 'Notes' },
  { value: 'drums', label: 'Drums' },
  { value: 'off', label: 'Off' },
] as const;
type KeyMode = (typeof KEY_MODES)[number]['value'];

/** Step velocities of a demo pattern (0 = off). */
const STEPS = [1, 0, 0.55, 0, 0.85, 0, 0.4, 0.7, 1, 0, 0.55, 0, 0.85, 0.3, 0, 0.6];

const KIT_OPTIONS = [
  { value: 'round-machine', label: 'Round Machine', group: 'Drum kits' },
  { value: 'tight-circuit', label: 'Tight Circuit', group: 'Drum kits' },
  { value: 'dust-tape', label: 'Dust Tape', group: 'Drum kits' },
  { value: 'bright-steel', label: 'Bright Steel', group: 'Drum kits' },
  { value: 'hand-percussion', label: 'Hand Percussion', group: 'Percussion' },
];

const SCALE_OPTIONS = [
  { value: 'minor', label: 'Minor' },
  { value: 'major', label: 'Major' },
  { value: 'dorian', label: 'Dorian' },
  { value: 'minorPentatonic', label: 'Minor pentatonic' },
  { value: 'chromatic', label: 'Chromatic (no assist)' },
];

const TRACK_GAIN = [1, 0.62, 0.8, 0.55, 0.44, 0.36, 0.25, 0.12];

/* ------------------------------------------------------------------ */

export function Gallery() {
  const [tips, setTips] = useState(true);
  return (
    <TipsProvider enabled={tips} onEnabledChange={setTips}>
      <ToastProvider>
        <GalleryPage tips={tips} setTips={setTips} />
      </ToastProvider>
    </TipsProvider>
  );
}

function GalleryPage({ tips, setTips }: { tips: boolean; setTips(v: boolean): void }) {
  const toasts = useToasts();

  // Transport-style state (visual only).
  const [playing, setPlaying] = useState(true);
  const [recording, setRecording] = useState(false);
  const [metronome, setMetronome] = useState(false);
  const [countIn, setCountIn] = useState(true);
  const [muted, setMuted] = useState(false);
  const [bpm, setBpm] = useState(124);
  const [swing, setSwing] = useState(0.18);
  const [master, setMaster] = useState(-3);

  const [view, setView] = useState<View>('play');
  const [padMode, setPadMode] = useState<PadMode>('loops');
  const [matrix, setMatrix] = useState(INITIAL_MATRIX);
  const [macros, setMacros] = useState([0.62, 0.35, 0.2, 0, 0.15, 0.4]);
  const [knobs, setKnobs] = useState<Record<string, number>>({
    cutoff: 2400,
    resonance: 0.22,
    sendA: 0.35,
    sendB: 0.2,
    filterCut: 1800,
    wave: 0,
    pan: -0.2,
    octave: 0,
    division: 2,
    attack: 0.005,
    decay: 0.5,
    sustain: 0.6,
    release: 0.35,
    detune: 7,
    level: -4,
  });
  const setKnob = (id: string) => (v: number) => setKnobs((k) => ({ ...k, [id]: v }));

  // Demo signal for the meters (explicitly not audio).
  const [demo, setDemo] = useState(0.5);
  const demoRef = useRef(demo);
  useLayoutEffect(() => {
    demoRef.current = demo;
  }, [demo]);
  const readDemo = useCallback(() => demoRef.current, []);
  const trackReaders = useRef(TRACK_GAIN.map((g) => () => demoRef.current * g)).current;

  // Keyboard.
  const [baseNote, setBaseNote] = useState(48);
  const [keyMode, setKeyMode] = useState<KeyMode>('notes');
  const [held, setHeld] = useState<ReadonlySet<number>>(new Set());
  const [heldPads, setHeldPads] = useState<ReadonlySet<number>>(new Set());
  const keyCaps = useKeyCapLabels();
  const noteOn = (m: number) => setHeld((s) => new Set(s).add(m));
  const noteOff = (m: number) =>
    setHeld((s) => {
      const n = new Set(s);
      n.delete(m);
      return n;
    });
  const padOn = (i: number) => setHeldPads((s) => new Set(s).add(i));
  const padOff = (i: number) =>
    setHeldPads((s) => {
      const n = new Set(s);
      n.delete(i);
      return n;
    });

  useComputerKeyboard({
    enabled: keyMode !== 'off',
    layout: keyMode === 'drums' ? 'drums' : 'notes',
    onNoteOn: (i) => (keyMode === 'drums' ? padOn(i) : noteOn(baseNote + i)),
    onNoteOff: (i) => (keyMode === 'drums' ? padOff(i) : noteOff(baseNote + i)),
    onOctave: (d) => setBaseNote((b) => Math.min(84, Math.max(24, b + d * 12))),
  });

  // Controls panel state.
  const [assist, setAssist] = useState(true);
  const [latch, setLatch] = useState(false);
  const [locked, setLocked] = useState(true);
  const [kit, setKit] = useState('round-machine');
  const [scale, setScale] = useState('minor');
  const [bars, setBars] = useState(2);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [tail, setTail] = useState(2);
  const [rate, setRate] = useState('48000');
  const [steps, setSteps] = useState(STEPS);

  const pressClip = (t: number, r: number) =>
    setMatrix((m) =>
      m.map((col, ti) =>
        ti !== t
          ? col
          : col.map((cell, ri) => {
              if (ri !== r) return cell.state === 'queued' ? { ...cell, state: 'ready' } : cell;
              if (cell.state === 'empty') return cell;
              const next: Record<PadState, PadState> = { empty: 'empty', ready: 'queued', queued: 'playing', playing: 'stopping', stopping: 'ready', recording: 'playing' };
              return { ...cell, state: next[cell.state] };
            }),
      ),
    );

  const mask = scale === 'chromatic' ? undefined : scaleMask(0, scale as 'minor');

  return (
    <div className={styles.page}>
      <div className={styles.console}>
        {/* ---------- Title ---------- */}
        <header className={styles.titlebar}>
          <div className={styles.brand}>
            <span className={styles.wordmark}>SWITCHBOARD</span>
            <span className={styles.slash}>/ 01</span>
            <span className={styles.subtitle}>Component gallery</span>
          </div>
          <p className={styles.note}>
            <Icon name="info" size={14} /> Visual review page. Nothing here makes sound; meters follow the <strong>Demo signal</strong> knob.
          </p>
          <Switch label="Tips" checked={tips} onChange={setTips} tone="teal" tip="Explains what each control does to the sound." detail="Remembered setting. Tips appear on hover and keyboard focus." />
        </header>

        {/* ---------- Transport strip ---------- */}
        <section className={styles.transport} aria-label="Transport">
          <div className={styles.group}>
            <Button variant="transport" size="lg" icon={playing ? 'stop' : 'play'} pressed={playing} onClick={() => setPlaying((p) => !p)} tip="Starts and stops the music." detail="Space">
              {playing ? 'Stop' : 'Play'}
            </Button>
            <Button variant="transport" size="lg" icon="recordPerformance" tone="coral" pressed={recording} onClick={() => setRecording((r) => !r)} tip="Records everything you play and launch so you can replay and export it.">
              {recording ? 'Recording' : 'Record Performance'}
            </Button>
          </div>
          <span className={styles.divider} />
          <NumberField label="Tempo" layout="inline" value={bpm} min={BPM_SPEC.min} max={BPM_SPEC.max} step={1} fineStep={0.1} unit="BPM" onChange={(v) => setBpm(v)} tip={BPM_SPEC.tip} detail="Drag, type, or use the arrow keys. Shift for fine steps." />
          <Knob spec={SWING_SPEC} value={swing} onChange={(v) => setSwing(v)} size="sm" />
          <Switch label="Metronome" checked={metronome} onChange={setMetronome} size="sm" tip="Plays a click on every beat." />
          <span className={styles.divider} />
          <Led on tone="neutral" label="Saved" />
          <span className={styles.grow} />
          <div className={styles.masterBlock}>
            <Meter read={readDemo} label="Master level (demo signal)" thickness={6} length={96} />
            <Knob spec={MASTER_VOLUME_SPEC} value={master} onChange={(v) => setMaster(v)} size="sm" />
          </div>
          <IconButton icon="undo" label="Undo" tip="Takes back your last change." detail="Ctrl+Z" />
          <IconButton icon="redo" label="Redo" detail="Ctrl+Shift+Z" />
          <Button variant="danger" icon="mute" pressed={muted} onClick={() => setMuted((m) => !m)} tip="Silences everything at once, including echoes and reverb tails.">
            {muted ? 'Muted' : 'Mute All'}
          </Button>
        </section>

        {/* ---------- Play surface ---------- */}
        <div className={styles.row}>
          <Panel
            title="Pads"
            className={styles.padsPanel}
            actions={
              <>
                <SegmentedControl label="Pad mode" options={PAD_MODES} value={padMode} onChange={setPadMode} size="sm" />
              </>
            }
          >
            <div className={styles.matrixHead}>
              {TRACKS.map((t, i) => (
                <div key={t} className={styles.trackName} data-selected={i === 2 || undefined}>
                  {t}
                </div>
              ))}
              <div className={styles.sceneHead}>Scenes</div>
            </div>
            <div className={styles.matrix}>
              {SCENES.map((scene, r) => (
                <div key={scene} className={styles.matrixRow}>
                  {TRACKS.map((t, ti) => {
                    const cell = matrix[ti][r];
                    return (
                      <Pad
                        key={t}
                        state={cell.state}
                        label={cell.state === 'empty' ? 'Empty' : cell.name}
                        sublabel={cell.state === 'empty' ? undefined : `${(ti + r) % 2 ? 2 : 1} bar${(ti + r) % 2 ? 's' : ''}`}
                        selected={ti === 2 && r === 1}
                        onPress={() => pressClip(ti, r)}
                        ariaLabel={cell.state === 'empty' ? `${t}, ${scene}, empty slot` : undefined}
                      />
                    );
                  })}
                  <Button size="sm" icon="play" className={styles.sceneButton} tip={`Launches the ${scene} row on every part at the next bar.`}>
                    {scene}
                  </Button>
                </div>
              ))}
            </div>
            <div className={styles.matrixFoot}>
              {TRACKS.map((t) => (
                <IconButton key={t} icon="stop" label={`Stop ${t}`} size="sm" variant="secondary" className={styles.stopButton} tip="Stops this part at the next bar." />
              ))}
              <Button size="sm" variant="secondary" icon="stop" className={styles.sceneButton} tip="Stops every part at the next bar.">
                All
              </Button>
            </div>
          </Panel>

          <Panel title="Sound" subtitle="Bass · Walker" className={styles.soundPanel} actions={<SegmentedControl kind="tabs" label="View" options={VIEWS} value={view} onChange={setView} size="sm" />}>
            <div className={styles.macros}>
              {MACROS.map((m, i) => (
                <Knob
                  key={m.id}
                  spec={m}
                  size="lg"
                  value={macros[i]}
                  onChange={(v) => setMacros((all) => all.map((x, j) => (j === i ? v : x)))}
                />
              ))}
            </div>
            <div className={styles.subhead}>Underlying controls</div>
            <div className={styles.knobRow}>
              <Knob spec={spec(BASS_PARAMS, 'cutoff')} value={knobs.cutoff} onChange={setKnob('cutoff')} controlledBy="Tone" />
              <Knob spec={spec(BASS_PARAMS, 'resonance')} value={knobs.resonance} onChange={setKnob('resonance')} />
              <Knob spec={spec(CHANNEL_PARAMS, 'sendA')} value={knobs.sendA} onChange={setKnob('sendA')} controlledBy="Space" />
              <Knob spec={spec(FILTER_PARAMS, 'cutoff')} label="Filter" value={knobs.filterCut} onChange={setKnob('filterCut')} modulated />
              <Knob spec={spec(BASS_PARAMS, 'wave')} value={knobs.wave} onChange={setKnob('wave')} />
              <Knob spec={spec(CHANNEL_PARAMS, 'pan')} value={knobs.pan} onChange={setKnob('pan')} />
            </div>
            <div className={styles.knobRow}>
              <Knob spec={spec(POLY_PARAMS, 'attack')} size="sm" value={knobs.attack} onChange={setKnob('attack')} />
              <Knob spec={spec(POLY_PARAMS, 'decay')} size="sm" value={knobs.decay} onChange={setKnob('decay')} />
              <Knob spec={spec(POLY_PARAMS, 'sustain')} size="sm" value={knobs.sustain} onChange={setKnob('sustain')} />
              <Knob spec={spec(POLY_PARAMS, 'release')} size="sm" value={knobs.release} onChange={setKnob('release')} />
              <Knob spec={spec(BASS_PARAMS, 'octave')} size="sm" value={knobs.octave} onChange={setKnob('octave')} />
              <Knob spec={spec(DELAY_PARAMS, 'division')} size="sm" value={knobs.division} onChange={setKnob('division')} accent="teal" />
              <Knob spec={spec(POLY_PARAMS, 'detune')} size="sm" value={knobs.detune} onChange={setKnob('detune')} disabled />
            </div>
          </Panel>
        </div>

        {/* ---------- Keyboard + drum pads ---------- */}
        <div className={styles.row}>
          <Panel
            title="Keyboard"
            subtitle={<span className={styles.mono}>{`${noteName(baseNote)}–${noteName(baseNote + 24)}`}</span>}
            className={styles.keysPanel}
            actions={
              <>
                <IconButton icon="octaveDown" label="Octave down" size="sm" variant="secondary" detail="Z" onClick={() => setBaseNote((b) => Math.max(24, b - 12))} />
                <IconButton icon="octaveUp" label="Octave up" size="sm" variant="secondary" detail="X" onClick={() => setBaseNote((b) => Math.min(84, b + 12))} />
                <SegmentedControl label="Computer keys" options={KEY_MODES} value={keyMode} onChange={setKeyMode} size="sm" />
              </>
            }
          >
            <MiniKeyboard
              baseNote={baseNote}
              onNoteOn={noteOn}
              onNoteOff={noteOff}
              activeNotes={held}
              scaleMask={mask}
              rootPc={0}
              height={160}
              keyLabels={keyMode === 'notes' ? noteKeyLabels(baseNote, keyCaps) : undefined}
            />
            <div className={styles.keyNote}>
              <Led on={assist} tone="teal" label={assist ? 'Musical Assist on: dots mark notes in C minor' : 'Musical Assist off: every key plays as is'} />
              <span className={styles.hint}>Silent here: this page has no sound engine. Lower on a key plays louder.</span>
            </div>
          </Panel>

          <Panel title="Drums" subtitle="Round Machine" className={styles.drumPanel}>
            <div className={styles.drumGrid}>
              {[12, 13, 14, 15, 8, 9, 10, 11, 4, 5, 6, 7, 0, 1, 2, 3].map((i) => (
                <Pad
                  key={i}
                  state={heldPads.has(i) ? 'playing' : 'ready'}
                  caption={null}
                  label={DRUM_SLOTS[i].name}
                  keyHint={keyMode === 'drums' ? drumKeyHint(i, keyCaps) : undefined}
                  selected={i === 2}
                  onPress={() => padOn(i)}
                  onRelease={() => padOff(i)}
                />
              ))}
            </div>
          </Panel>
        </div>

        {/* ---------- Steps ---------- */}
        <Panel title="Steps" subtitle="Snare · bar 1 of 2" className={styles.stepsPanel}>
          <div className={styles.steps}>
            {[0, 1, 2, 3].map((beat) => (
              <div key={beat} className={styles.beat}>
                {steps.slice(beat * 4, beat * 4 + 4).map((v, j) => {
                  const i = beat * 4 + j;
                  return (
                    <Pad
                      key={i}
                      size="md"
                      state={v > 0 ? 'playing' : 'ready'}
                      caption={null}
                      label={String(i + 1)}
                      sublabel={v > 0 ? `${Math.round(v * 100)}%` : undefined}
                      intensity={v}
                      selected={i === 4}
                      ariaLabel={`Step ${i + 1}, ${v > 0 ? `on, velocity ${Math.round(v * 100)}%` : 'off'}`}
                      onPress={() => setSteps((s) => s.map((x, k) => (k === i ? (x > 0 ? 0 : 0.8) : x)))}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </Panel>

        {/* ---------- Controls ---------- */}
        <div className={styles.row}>
          <Panel title="Buttons" className={styles.flexPanel}>
            <div className={styles.stack}>
              <div className={styles.line}>
                <Button variant="primary" size="lg" icon="play">
                  Jump In
                </Button>
                <Button variant="secondary" icon="duplicate">
                  Duplicate
                </Button>
                <Button variant="ghost">Cancel</Button>
                <Button variant="danger" icon="trash">
                  Delete
                </Button>
              </div>
              <div className={styles.line}>
                <Button size="sm">Small</Button>
                <Button size="md">Medium</Button>
                <Button size="lg">Large</Button>
                <Button disabled icon="download">
                  Disabled
                </Button>
              </div>
              <div className={styles.line}>
                <Button pressed={assist} tone="teal" onClick={() => setAssist((a) => !a)}>
                  Assist {assist ? 'on' : 'off'}
                </Button>
                <Button pressed={latch} onClick={() => setLatch((l) => !l)}>
                  Latch
                </Button>
                <Button variant="transport" icon="metronome" pressed={metronome} onClick={() => setMetronome((m) => !m)}>
                  Click
                </Button>
                <Button variant="ghost" pressed={locked} tone="teal" icon={locked ? 'lock' : 'unlock'} onClick={() => setLocked((l) => !l)}>
                  {locked ? 'Locked' : 'Unlocked'}
                </Button>
              </div>
              <div className={styles.line}>
                <IconButton icon="dice" label="Variation" variant="secondary" tip="Makes a new take on this pattern. Undo brings the old one back." />
                <IconButton icon="copy" label="Copy clip" variant="secondary" />
                <IconButton icon="paste" label="Paste clip" variant="secondary" />
                <IconButton icon="cable" label="Cables" variant="secondary" pressed tone="teal" />
                <IconButton icon="settings" label="Settings" />
                <IconButton icon="trash" label="Clear" variant="danger" />
                <IconButton icon="sparkle" label="Guide" />
              </div>
            </div>
          </Panel>

          <Panel title="Switches & fields" className={styles.flexPanel}>
            <div className={styles.stack}>
              <div className={styles.line}>
                <Switch label="Musical Assist" checked={assist} onChange={setAssist} tone="teal" tip="Keeps the notes you play in the project's key." />
                <Switch label="Count-in" checked={countIn} onChange={setCountIn} tip="One bar of clicks before recording starts." />
                <Switch label="Locked" checked={false} onChange={() => {}} disabled />
              </div>
              <div className={styles.line}>
                <Select label="Drum kit" value={kit} onChange={setKit} options={KIT_OPTIONS} width={180} tip="The set of drum sounds this part plays." />
                <Select label="Scale" value={scale} onChange={setScale} options={SCALE_OPTIONS} width={170} />
                <NumberField label="Clip length" value={bars} min={1} max={4} step={1} fineStep={1} unit="bars" chars={2} onChange={(v) => setBars(v)} />
              </div>
              <div className={styles.line}>
                <Led on tone="amber" label="Playing" />
                <Led on tone="teal" label="Selected" />
                <Led on tone="coral" label="Rec" />
                <Led on blink tone="amber" label="Saving…" />
                <Led on={false} label="Off" />
              </div>
            </div>
          </Panel>

          <Panel title="Meters" subtitle={<span className={styles.demoTag}>Demo signal — not audio</span>} className={styles.meterPanel}>
            <div className={styles.meterBody}>
              <Knob spec={DEMO_SIGNAL} value={demo} onChange={(v) => setDemo(v)} size="md" accent="teal" />
              <div className={styles.meterStack}>
                <Meter read={readDemo} label="Demo master meter" thickness={8} />
                <Meter read={readDemo} label="Demo meter, compact" thickness={5} segments={12} showClip={false} length={96} />
                <div className={styles.vmeters}>
                  {trackReaders.map((r, i) => (
                    <Meter key={i} read={r} label={`Demo track meter ${i + 1}`} orientation="vertical" thickness={5} segments={12} length={64} />
                  ))}
                </div>
              </div>
            </div>
          </Panel>
        </div>

        {/* ---------- Feedback ---------- */}
        <div className={styles.row}>
          <Panel title="Notices & dialogs" className={styles.flexPanel}>
            <div className={styles.stack}>
              <Notice tone="warning" title="This part has no path to the output" action={{ label: 'Restore connection', onAction: () => toasts.show({ message: 'Connection restored.', tone: 'success' }) }}>
                Lead is not connected to the master, so you won't hear it.
              </Notice>
              <Notice tone="error" title="Couldn't save to this browser" action={{ label: 'Retry', onAction: () => {} }} onDismiss={() => {}}>
                Storage is full. Export a project bundle to keep a copy.
              </Notice>
              <Notice tone="info">Browser storage is working storage. Export a bundle as your portable backup.</Notice>
              <div className={styles.line}>
                <Button icon="dice" onClick={() => toasts.show({ message: 'Variation applied to Bass.', action: { label: 'Undo', onAction: () => {} } })}>
                  Show undo toast
                </Button>
                <Button onClick={() => toasts.show({ id: 'save-error', tone: 'error', title: 'Autosave failed', message: 'Your changes are still here. Export a bundle to keep them safe.', action: { label: 'Export', onAction: () => {} } })}>
                  Show error toast
                </Button>
                <Button variant="primary" icon="download" onClick={() => setDialogOpen(true)}>
                  Export audio…
                </Button>
              </div>
            </div>
          </Panel>

          <Panel title="Icons" className={styles.iconPanel}>
            <div className={styles.icons}>
              {ICON_NAMES.map((n) => (
                <div key={n} className={styles.iconCell}>
                  <Icon name={n} size={18} />
                  <span>{n}</span>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      </div>

      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title="Export audio"
        description="Renders the arrangement with the same sounds and effects you hear, then saves a WAV file."
        actions={
          <>
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" icon="download" onClick={() => setDialogOpen(false)}>
              Export WAV
            </Button>
          </>
        }
      >
        <div className={styles.line}>
          <Select
            label="Sample rate"
            value={rate}
            onChange={setRate}
            options={[
              { value: '44100', label: '44.1 kHz' },
              { value: '48000', label: '48 kHz' },
            ]}
          />
          <NumberField label="Tail" value={tail} min={0} max={10} step={0.5} fineStep={0.1} unit="s" chars={3} onChange={(v) => setTail(v)} />
        </div>
      </Dialog>
    </div>
  );
}
