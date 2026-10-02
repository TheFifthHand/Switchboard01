/**
 * The app's single Session and store hooks for React components.
 */
import { createProject } from '../project/factory';
import type { Project } from '../project/types';
import { useStore } from '../state/store';
import { uiStore, type UiState } from '../state/uiStore';
import { IDLE_AUTOSAVE_STATE, type AutosaveState } from '../persistence/autosave';
import type { HistoryInfo } from '../state/projectStore';
import { createStore } from '../state/store';
import { Session } from './session';

export const session = new Session(createProject({ name: 'Untitled' }));

export function useProject<S>(selector: (p: Project) => S, equality?: (a: S, b: S) => boolean): S {
  return useStore(session.store, selector, equality);
}

export function useUi<S>(selector: (s: UiState) => S, equality?: (a: S, b: S) => boolean): S {
  return useStore(uiStore, selector, equality);
}

export function useHistory(): HistoryInfo {
  return useStore(session.store.info, (s) => s);
}

const idleSave = createStore<AutosaveState>({ ...IDLE_AUTOSAVE_STATE });

export function useAutosave(): AutosaveState {
  return useStore(session.autosaver?.status ?? idleSave, (s) => s);
}

declare global {
  interface Window {
    __switchboard?: unknown;
  }
}
