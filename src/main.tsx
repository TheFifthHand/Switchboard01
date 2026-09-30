import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './ui/theme.css';
import { App } from './app/App';
import { session } from './app/instance';
import { installTestHooks } from './app/testHooks';
import { registerServiceWorker } from './app/pwa';

async function start() {
  const root = createRoot(document.getElementById('root')!);
  if (new URLSearchParams(location.search).has('gallery')) {
    const { Gallery } = await import('./ui/gallery/Gallery');
    root.render(
      <StrictMode>
        <Gallery />
      </StrictMode>,
    );
    return;
  }
  const boot = await session.boot();
  installTestHooks();
  root.render(
    <StrictMode>
      <App boot={boot} />
    </StrictMode>,
  );
  registerServiceWorker();
}

void start();
