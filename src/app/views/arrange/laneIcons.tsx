/**
 * Small glyphs the song lane needs that the shared icon set does not have
 * (same 16-unit grid and round 1.5 px strokes in currentColor as Icon).
 */
import type { ReactElement } from 'react';

export type LaneIconName = 'scissors' | 'layers' | 'join' | 'more';

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
};

export function LaneIcon({ name, size = 14 }: { name: LaneIconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {GLYPHS[name]}
    </svg>
  );
}
