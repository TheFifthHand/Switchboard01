export { Hints, type HintsProps } from './Hints';
export {
  HINTS_STORAGE_KEY,
  HINT_IDS,
  hintsStore,
  hintsRunning,
  startHints,
  showHintsAgain,
  hideHints,
  finishHints,
  markHintDone,
  createHintsStore,
  readHints,
  type HintId,
  type HintsState,
  type HintsStore,
} from './hintsState';
export { HINT_STEPS, HINTS_FINISHED_TEXT, currentHint, bassPart, drumsPart, type HintContext, type HintStep } from './steps';
export { watchHints, type HintSources } from './tracker';
export { findSpot, spotCost, type Box, type Obstacle, type Spot } from './placement';
