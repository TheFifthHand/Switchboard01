/**
 * Offline caching (service worker) with visible readiness/update states.
 * Updates are never applied automatically: the user reloads when ready, so a
 * performance is never interrupted.
 */
/// <reference types="vite-plugin-pwa/client" />
import { registerSW } from 'virtual:pwa-register';
import { createStore, useStore } from '../state/store';

export type OfflineState = 'unsupported' | 'installing' | 'ready' | 'update-ready' | 'error';

export const offlineStore = createStore<{ state: OfflineState; apply: (() => void) | null }>({ state: 'unsupported', apply: null });

export function useOffline() {
  return useStore(offlineStore, (s) => s);
}

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  offlineStore.setState({ state: 'installing', apply: null });
  const update = registerSW({
    immediate: true,
    onOfflineReady() {
      offlineStore.setState({ state: 'ready', apply: null });
    },
    onNeedRefresh() {
      offlineStore.setState({ state: 'update-ready', apply: () => void update(true) });
    },
    onRegisteredSW(_url, reg) {
      // Already controlling the page from an earlier visit: offline is ready.
      if (reg?.active && navigator.serviceWorker.controller) offlineStore.setState((s) => (s.state === 'installing' ? { ...s, state: 'ready' } : s));
    },
    onRegisterError() {
      offlineStore.setState({ state: 'error', apply: null });
    },
  });
}
