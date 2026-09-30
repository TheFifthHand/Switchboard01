/**
 * SWITCHBOARD / 01 component kit. See src/ui/gallery/Gallery.tsx (?gallery)
 * for every component in every state.
 */
export { Icon, ICON_NAMES, type IconName, type IconProps } from './Icon';
export {
  Knob,
  stepParam,
  KNOB_DRAG_TRAVEL_PX,
  KNOB_FINE_FACTOR,
  KNOB_KEY_STEP,
  KNOB_KEY_FINE_STEP,
  KNOB_PAGE_STEP,
  KNOB_BURST_IDLE_MS,
  type KnobProps,
  type KnobChangeInfo,
  type KnobSize,
} from './Knob';
export { Pad, velocityFromPosition, PAD_KEY_VELOCITY, PAD_STATE_TEXT, type PadProps, type PadState, type PadPressEvent } from './Pad';
export { Button, IconButton, type ButtonProps, type IconButtonProps, type ButtonVariant, type ButtonSize, type Tone } from './Button';
export { Switch, Toggle, type SwitchProps, type ToggleProps } from './Toggle';
export { SegmentedControl, type SegmentedControlProps, type SegmentOption } from './SegmentedControl';
export { Select, type SelectProps, type SelectOption } from './Select';
export { NumberField, type NumberFieldProps, type NumberFieldChangeInfo } from './NumberField';
export { Led, type LedProps } from './Led';
export { Meter, METER_CLIP_LEVEL, type MeterProps } from './Meter';
export { Panel, type PanelProps } from './Panel';
export { Dialog, type DialogProps } from './Dialog';
export { Notice, Toast, ToastProvider, useToasts, type NoticeProps, type NoticeTone, type NoticeAction, type ToastOptions, type ToastApi, type ToastProps, type ToastProviderProps } from './Toast';
export { Tooltip, TipsProvider, useTips, TOOLTIP_DELAY_MS, type TooltipProps, type TipsProviderProps, type TipsContextValue } from './Tooltip';
export { MiniKeyboard, noteName, BLACK_KEY_HEIGHT, type MiniKeyboardProps } from './MiniKeyboard';
export { newGestureId, parseParamInput, paramEditText, parsePlainNumber } from './valueInput';

export {
  useComputerKeyboard,
  useKeyCapLabels,
  drumKeyHint,
  noteKeyLabels,
  isTypingTarget,
  NOTE_KEYS,
  DRUM_KEYS,
  OCTAVE_KEYS,
  KEY_VELOCITY,
  KEY_ACCENT_VELOCITY,
  type ComputerKeyboardLayout,
  type ComputerKeyboardOptions,
  type ComputerKeyboardControls,
  type KeyMapping,
} from '../hooks/useComputerKeyboard';
export { useRafLoop, type RafCallback } from '../hooks/useRafLoop';
export { useElementSize, type ElementSize } from '../hooks/useElementSize';
