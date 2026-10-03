/**
 * How much a Compressor or Gate is turning its part down right now: a bar
 * that grows from the right, and the number ("−3.2 dB", "Resting" / "Open").
 *
 * Read from the engine's shared meter frame (MeterFrame.moduleReductionDb,
 * one engine read per frame for every meter on screen) inside the shared,
 * sleeping meter loop: it costs nothing while nothing plays, and it writes
 * only a transform and, when it changes, the number (no React render per
 * frame). A real reading only: with no audio engine it says "—".
 */
import { useEffect, useRef } from 'react';
import { Tooltip } from '../../../ui/components';
import { addMeterTask } from '../../../ui/components/meterScheduler';
import type { Id } from '../../../project/types';
import { session } from '../../instance';
import styles from './GrMeter.module.css';

const MINUS = '−';
/**
 * How fast the bar falls back (dB per second); it rises at once. A compressor's reduction falls
 * at a readable pace; a gate opens in a few milliseconds and its reduction is tens of dB, so its
 * bar follows within about 150 ms (it must not read −40 dB while the engine says it is open).
 */
const RELEASE_DB_PER_S: Record<'compressor' | 'gate', number> = { compressor: 30, gate: 400 };

export interface GrMeterProps {
  moduleId: Id;
  kind: 'compressor' | 'gate';
  /** Effect name for the accessible label ("Compressor 2"). */
  name: string;
  className?: string;
}

/** Full-scale reduction of the bar, dB. */
const SCALE: Record<GrMeterProps['kind'], number> = { compressor: 24, gate: 60 };

export function GrMeter({ moduleId, kind, name, className }: GrMeterProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const idRef = useRef(moduleId);
  idRef.current = moduleId;

  useEffect(() => {
    let shown = 0;
    let known = false;
    let lastText = '';
    let lastNow = '';
    const read = (): number | null => {
      const frame = session.readMetersShared();
      if (!frame) return null;
      const v = frame.moduleReductionDb?.[idRef.current];
      return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : 0;
    };
    const write = () => {
      const scale = SCALE[kind];
      if (barRef.current) barRef.current.style.transform = `scaleX(${Math.min(1, shown / scale).toFixed(3)})`;
      const resting = kind === 'gate' ? 'Open' : 'Resting';
      const text = !known ? '—' : shown < 0.1 ? resting : `${MINUS}${shown.toFixed(1)} dB`;
      if (textRef.current && text !== lastText) {
        lastText = text;
        textRef.current.textContent = text;
      }
      const now = String(Math.round(shown * 10) / 10);
      if (rootRef.current && now !== lastNow) {
        lastNow = now;
        rootRef.current.setAttribute('aria-valuenow', now);
        rootRef.current.setAttribute('aria-valuetext', !known ? 'Not measured' : shown < 0.1 ? (kind === 'gate' ? 'Open: not turning down' : 'Not compressing') : `Turning down ${shown.toFixed(1)} dB`);
      }
    };
    return addMeterTask({
      frame(_now, dt, doWrite) {
        const v = read();
        known = v !== null;
        const target = v ?? 0;
        shown = target >= shown ? target : Math.max(target, shown - RELEASE_DB_PER_S[kind] * dt);
        if (doWrite) write();
        return shown >= 0.05 || lastText !== (!known ? '—' : kind === 'gate' ? 'Open' : 'Resting');
      },
      probe() {
        const v = read();
        return v !== null && v >= 0.05;
      },
    });
  }, [kind]);

  const what = kind === 'gate' ? 'How far the gate is turning this part down right now: it closes when the sound falls below Threshold.' : 'How much the compressor is turning this part down right now. A few dB on the loudest moments sounds natural.';
  return (
    <Tooltip tip={what} detail={`Gain reduction, read from the audio engine (0 to ${SCALE[kind]} dB on this bar).`}>
      <div
        ref={rootRef}
        className={[styles.gr, className].filter(Boolean).join(' ')}
        data-kind={kind}
        role="meter"
        aria-label={`${name} gain reduction`}
        aria-valuemin={0}
        aria-valuemax={SCALE[kind]}
        aria-valuenow={0}
        aria-valuetext="Not measured"
      >
        <span className={styles.label} aria-hidden="true">
          {kind === 'gate' ? 'Closing' : 'Squeezing'}
        </span>
        <span className={styles.track} aria-hidden="true">
          <span ref={barRef} className={styles.bar} />
        </span>
        <span ref={textRef} className={`${styles.text} mono`} aria-hidden="true">
          —
        </span>
      </div>
    </Tooltip>
  );
}
