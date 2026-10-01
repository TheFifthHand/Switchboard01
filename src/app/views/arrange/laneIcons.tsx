/**
 * Small glyphs the song lane needs that the shared icon set does not have
 * (same 16-unit grid and round 1.5 px strokes in currentColor as Icon).
 */
import type { ReactElement } from 'react';

export type LaneIconName = 'scissors' | 'layers' | 'join' | 'more' | 'loop' | 'buildUp' | 'stripDown' | 'breakdown';

const S = { vectorEffect: 'non-scaling-stroke' } as const;

const GLYPHS: Record<LaneIconName, ReactElement[]> = {
  scissors: [
    <circle key="a" cx={4.4} cy={11.6} r={2} {...S} />,
    <circle key="b" cx={11.6} cy={11.6} r={2} {...S} />,
    <path key="c" d="M5.8 10.2 L11.4 2.6" {...S} />,
    <path key="d" d="M10.2 10.2 L4.6 2.6" {...S} />,
  ],
  layers: [<path key="a" d="M8 2.6 L14 5.8 L8 9 L2 5.8 Z" {...S} />, <path key="b" d="M2 9 L8 12.2 L14 9" {...S} />],
  join: [<path key="a" d="M6.2 4.2 H3.4 V11.8 H6.2" {...S} />, <path key="b" d="M9.8 4.2 H12.6 V11.8 H9.8" {...S} />, <path key="c" d="M5.6 8 H10.4" {...S} />],
  more: [
    <circle key="a" cx={3.2} cy={8} r={1.4} fill="currentColor" stroke="none" />,
    <circle key="b" cx={8} cy={8} r={1.4} fill="currentColor" stroke="none" />,
    <circle key="c" cx={12.8} cy={8} r={1.4} fill="currentColor" stroke="none" />,
  ],
  // Two arrows chasing each other round: play again and again.
  loop: [
    <path key="a" d="M2.8 9.2 V7.4 A3 3 0 0 1 5.8 4.4 H12.2" {...S} />,
    <path key="b" d="M10.4 2.6 L12.2 4.4 L10.4 6.2" {...S} />,
    <path key="c" d="M13.2 6.8 V8.6 A3 3 0 0 1 10.2 11.6 H3.8" {...S} />,
    <path key="d" d="M5.6 9.8 L3.8 11.6 L5.6 13.4" {...S} />,
  ],
  // Bars rising left to right: parts come in one at a time.
  buildUp: [<path key="a" d="M2.6 13.2 V10.8" {...S} />, <path key="b" d="M6.2 13.2 V8.2" {...S} />, <path key="c" d="M9.8 13.2 V5.6" {...S} />, <path key="d" d="M13.4 13.2 V3" {...S} />],
  // Bars falling: parts drop out one at a time.
  stripDown: [<path key="a" d="M2.6 13.2 V3" {...S} />, <path key="b" d="M6.2 13.2 V5.6" {...S} />, <path key="c" d="M9.8 13.2 V8.2" {...S} />, <path key="d" d="M13.4 13.2 V10.8" {...S} />],
  // A drum (the beat) with a stroke through it: the beat drops out.
  breakdown: [
    <ellipse key="a" cx={8} cy={5.6} rx={4.8} ry={1.9} {...S} />,
    <path key="b" d="M3.2 5.6 V10.4 C3.2 11.5 5.3 12.3 8 12.3 C10.7 12.3 12.8 11.5 12.8 10.4 V5.6" {...S} />,
    <path key="c" d="M2.4 13.6 L13.6 2.4" {...S} />,
  ],
};

export function LaneIcon({ name, size = 14 }: { name: LaneIconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {GLYPHS[name]}
    </svg>
  );
}
