/**
 * Inline SVG icon set. Drawn on a 16-unit grid with 1.5 px round strokes in
 * currentColor, so an icon takes the colour of its text and stays crisp at
 * any size (strokes do not scale with the icon).
 */
import type { CSSProperties, ReactElement } from 'react';

export const ICON_NAMES = [
  'play',
  'stop',
  'record',
  'recordPerformance',
  'mute',
  'undo',
  'redo',
  'plus',
  'minus',
  'close',
  'cable',
  'wave',
  'dice',
  'lock',
  'unlock',
  'metronome',
  'download',
  'upload',
  'folder',
  'save',
  'check',
  'warning',
  'info',
  'chevronUp',
  'chevronDown',
  'chevronLeft',
  'chevronRight',
  'octaveUp',
  'octaveDown',
  'trash',
  'copy',
  'paste',
  'duplicate',
  'drag',
  'settings',
  'sparkle',
  'clock',
  'link',
  'pause',
  'speaker',
  'headphones',
  'sliders',
  'mic',
  'keys',
  'drum',
  'bell',
  'search',
  'spectrum',
  'stereo',
  'midi',
] as const;

export type IconName = (typeof ICON_NAMES)[number];

const S = { vectorEffect: 'non-scaling-stroke' } as const;

/** Outline stroke path. */
const P = (d: string, key?: string | number): ReactElement => <path key={key ?? d} d={d} {...S} />;
/** Filled shape that also carries the rounded stroke (softens corners). */
const F = (d: string, key?: string | number): ReactElement => <path key={key ?? d} d={d} fill="currentColor" {...S} />;
const Dot = (cx: number, cy: number, r = 0.9): ReactElement => <circle key={`${cx},${cy}`} cx={cx} cy={cy} r={r} fill="currentColor" stroke="none" />;

const GLYPHS: Record<IconName, ReactElement[]> = {
  play: [F('M5 3.2 L12.8 8 L5 12.8 Z')],
  stop: [F('M4.2 4.2 H11.8 V11.8 H4.2 Z')],
  record: [<circle key="r" cx={8} cy={8} r={4.3} fill="currentColor" {...S} />],
  recordPerformance: [<circle key="o" cx={8} cy={8} r={6.2} {...S} />, <circle key="i" cx={8} cy={8} r={3} fill="currentColor" {...S} />],
  mute: [P('M2.5 6.2 H4.8 L8.2 3.4 V12.6 L4.8 9.8 H2.5 Z'), P('M10.6 6.2 L14 9.6'), P('M14 6.2 L10.6 9.6')],
  undo: [P('M5.4 3.6 L2.6 6.4 L5.4 9.2'), P('M2.6 6.4 H10 A3.4 3.4 0 0 1 10 13.2 H6.8')],
  redo: [P('M10.6 3.6 L13.4 6.4 L10.6 9.2'), P('M13.4 6.4 H6 A3.4 3.4 0 0 0 6 13.2 H9.2')],
  plus: [P('M8 3 V13'), P('M3 8 H13')],
  minus: [P('M3 8 H13')],
  close: [P('M4 4 L12 12'), P('M12 4 L4 12')],
  cable: [
    <circle key="a" cx={3.4} cy={12.6} r={1.6} {...S} />,
    <circle key="b" cx={12.6} cy={3.4} r={1.6} {...S} />,
    P('M4.6 11.4 C8.6 11.4 7.4 4.6 11.4 4.6'),
  ],
  wave: [P('M1.6 8 C3.4 2.6 5.8 2.6 8 8 S12.6 13.4 14.4 8')],
  dice: [<rect key="b" x={2.5} y={2.5} width={11} height={11} rx={2.6} {...S} />, Dot(5.6, 5.6), Dot(8, 8), Dot(10.4, 10.4)],
  lock: [<rect key="b" x={3.5} y={7} width={9} height={6.5} rx={1.5} {...S} />, P('M5.5 7 V5.2 A2.5 2.5 0 0 1 10.5 5.2 V7'), Dot(8, 10.2, 0.8)],
  unlock: [<rect key="b" x={3.5} y={7} width={9} height={6.5} rx={1.5} {...S} />, P('M5.5 7 V5.2 A2.5 2.5 0 0 1 10.3 4.2'), Dot(8, 10.2, 0.8)],
  metronome: [P('M5 13.6 L6.7 2.6 H9.3 L11 13.6 Z'), P('M4.4 13.6 H11.6'), P('M8 10.6 L12.4 4.4')],
  download: [P('M8 2.5 V10.5'), P('M4.6 7.3 L8 10.7 L11.4 7.3'), P('M3 13.5 H13')],
  upload: [P('M8 11 V3'), P('M4.6 6.2 L8 2.8 L11.4 6.2'), P('M3 13.5 H13')],
  folder: [P('M2 4.6 A1.1 1.1 0 0 1 3.1 3.5 H6.2 L7.7 5 H12.9 A1.1 1.1 0 0 1 14 6.1 V12.4 A1.1 1.1 0 0 1 12.9 13.5 H3.1 A1.1 1.1 0 0 1 2 12.4 Z')],
  save: [
    P('M2.5 3.9 A1.4 1.4 0 0 1 3.9 2.5 H11 L13.5 5 V12.1 A1.4 1.4 0 0 1 12.1 13.5 H3.9 A1.4 1.4 0 0 1 2.5 12.1 Z'),
    P('M5.2 2.5 V5.6 H9.8 V2.5'),
    P('M5 13.5 V9.4 H11 V13.5'),
  ],
  check: [P('M3 8.4 L6.5 11.8 L13 4.4')],
  warning: [P('M8 2.4 L14.2 13.2 H1.8 Z'), P('M8 6.4 V9.2'), Dot(8, 11.1, 0.85)],
  info: [<circle key="c" cx={8} cy={8} r={6.1} {...S} />, P('M8 7.3 V11.3'), Dot(8, 5, 0.85)],
  chevronUp: [P('M4 10 L8 6 L12 10')],
  chevronDown: [P('M4 6 L8 10 L12 6')],
  chevronLeft: [P('M10 4 L6 8 L10 12')],
  chevronRight: [P('M6 4 L10 8 L6 12')],
  octaveUp: [P('M4 8.2 L8 4.2 L12 8.2'), P('M4 12.2 L8 8.2 L12 12.2')],
  octaveDown: [P('M4 3.8 L8 7.8 L12 3.8'), P('M4 7.8 L8 11.8 L12 7.8')],
  trash: [P('M2.8 4.4 H13.2'), P('M6 4.4 V2.8 H10 V4.4'), P('M4.3 4.4 L5 13.4 H11 L11.7 4.4'), P('M6.8 6.8 V11'), P('M9.2 6.8 V11')],
  copy: [
    <rect key="f" x={5.5} y={5.5} width={8} height={8} rx={1.5} {...S} />,
    P('M10.5 5.5 V3.6 A1.1 1.1 0 0 0 9.4 2.5 H3.6 A1.1 1.1 0 0 0 2.5 3.6 V9.4 A1.1 1.1 0 0 0 3.6 10.5 H5.5'),
  ],
  paste: [
    P('M5.4 3.2 H3.9 A1.1 1.1 0 0 0 2.8 4.3 V13 A1.1 1.1 0 0 0 3.9 14.1 H12.1 A1.1 1.1 0 0 0 13.2 13 V4.3 A1.1 1.1 0 0 0 12.1 3.2 H10.6'),
    <rect key="c" x={5.4} y={1.9} width={5.2} height={2.6} rx={0.9} {...S} />,
    P('M5.6 8.2 H10.4'),
    P('M5.6 10.8 H9'),
  ],
  duplicate: [
    P('M3.6 10.5 A1.1 1.1 0 0 1 2.5 9.4 V3.6 A1.1 1.1 0 0 1 3.6 2.5 H9.4 A1.1 1.1 0 0 1 10.5 3.6'),
    <rect key="f" x={5.5} y={5.5} width={8} height={8} rx={1.5} {...S} />,
    P('M9.5 7.6 V11.4'),
    P('M7.6 9.5 H11.4'),
  ],
  drag: [Dot(6, 4), Dot(10, 4), Dot(6, 8), Dot(10, 8), Dot(6, 12), Dot(10, 12)],
  settings: [
    P('M2.5 4.5 H4.4'),
    P('M7.6 4.5 H13.5'),
    <circle key="a" cx={6} cy={4.5} r={1.6} {...S} />,
    P('M2.5 8 H8.4'),
    P('M11.6 8 H13.5'),
    <circle key="b" cx={10} cy={8} r={1.6} {...S} />,
    P('M2.5 11.5 H5.4'),
    P('M8.6 11.5 H13.5'),
    <circle key="c" cx={7} cy={11.5} r={1.6} {...S} />,
  ],
  sparkle: [
    F('M7 2.6 C7.4 5.9 8.6 7.1 11.9 7.5 C8.6 7.9 7.4 9.1 7 12.4 C6.6 9.1 5.4 7.9 2.1 7.5 C5.4 7.1 6.6 5.9 7 2.6 Z'),
    F('M12.5 10.2 C12.7 11.5 13.1 11.9 14.4 12.1 C13.1 12.3 12.7 12.7 12.5 14 C12.3 12.7 11.9 12.3 10.6 12.1 C11.9 11.9 12.3 11.5 12.5 10.2 Z'),
  ],
  clock: [<circle key="c" cx={8} cy={8} r={6.1} {...S} />, P('M8 4.8 V8.3 L10.4 9.8')],
  link: [
    P('M6.8 9.2 L9.2 6.8'),
    P('M7.4 4.6 L8.6 3.4 A2.4 2.4 0 0 1 12.6 7.4 L11.4 8.6'),
    P('M8.6 11.4 L7.4 12.6 A2.4 2.4 0 0 1 3.4 8.6 L4.6 7.4'),
  ],
  pause: [F('M4.4 3.4 H6.8 V12.6 H4.4 Z'), F('M9.2 3.4 H11.6 V12.6 H9.2 Z')],
  speaker: [P('M2.5 6.2 H4.8 L8.2 3.4 V12.6 L4.8 9.8 H2.5 Z'), P('M10.4 5.8 A3 3 0 0 1 10.4 10.2'), P('M12.2 4 A5.6 5.6 0 0 1 12.2 12')],
  headphones: [P('M3 10 V8 A5 5 0 0 1 13 8 V10'), P('M3 9.4 H5 V13 H3 Z'), P('M11 9.4 H13 V13 H11 Z')],
  sliders: [P('M4 2.5 V13.5'), P('M8 2.5 V13.5'), P('M12 2.5 V13.5'), F('M2.6 9 H5.4 V11 H2.6 Z'), F('M6.6 4.6 H9.4 V6.6 H6.6 Z'), F('M10.6 7.4 H13.4 V9.4 H10.6 Z')],
  mic: [P('M6 3.6 A2 2 0 0 1 10 3.6 V8 A2 2 0 0 1 6 8 Z'), P('M3.8 7.6 A4.2 4.2 0 0 0 12.2 7.6'), P('M8 11.8 V14'), P('M5.8 14 H10.2')],
  keys: [P('M2 3.5 H14 V12.5 H2 Z'), P('M6 12.5 V8.5'), P('M10 12.5 V8.5'), F('M4.9 3.5 H7.1 V8.5 H4.9 Z'), F('M8.9 3.5 H11.1 V8.5 H8.9 Z')],
  drum: [P('M2.5 6 A5.5 2.2 0 0 0 13.5 6 A5.5 2.2 0 0 0 2.5 6 Z'), P('M2.5 6 V11 A5.5 2.2 0 0 0 13.5 11 V6'), P('M5.4 2 L7.4 5'), P('M10.6 2 L8.6 5')],
  bell: [P('M4 11.5 C4.6 10.6 4.6 9.6 4.6 7.4 A3.4 3.4 0 0 1 11.4 7.4 C11.4 9.6 11.4 10.6 12 11.5 Z'), P('M6.8 13.4 H9.2')],
  search: [<circle key="c" cx={7} cy={7} r={4.2} {...S} />, P('M10.2 10.2 L13.6 13.6')],
  spectrum: [P('M2.5 13.5 H13.5'), F('M3 9 H4.6 V13 H3 Z'), F('M5.8 5 H7.4 V13 H5.8 Z'), F('M8.6 7 H10.2 V13 H8.6 Z'), F('M11.4 10 H13 V13 H11.4 Z')],
  stereo: [<circle key="l" cx={6} cy={8} r={3.6} {...S} />, <circle key="r" cx={10} cy={8} r={3.6} {...S} />],
  midi: [<circle key="o" cx={8} cy={8} r={5.8} {...S} />, Dot(5, 8.2), Dot(11, 8.2), Dot(6, 5.6), Dot(10, 5.6), Dot(8, 4.6), P('M7 12 H9')],
};

export interface IconProps {
  name: IconName;
  /** Rendered size in CSS pixels (default 16). */
  size?: number;
  /** When given the icon is announced with this name; otherwise it is decorative. */
  title?: string;
  className?: string;
  style?: CSSProperties;
}

export function Icon({ name, size = 16, title, className, style }: IconProps) {
  const labelled = title !== undefined && title !== '';
  return (
    <svg
      className={className}
      style={{ flex: 'none', display: 'block', ...style }}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={labelled ? 'img' : undefined}
      aria-label={labelled ? title : undefined}
      aria-hidden={labelled ? undefined : true}
      focusable="false"
      data-icon={name}
    >
      {GLYPHS[name]}
    </svg>
  );
}
