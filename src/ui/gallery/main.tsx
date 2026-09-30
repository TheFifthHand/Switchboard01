/**
 * Stand-alone entry for the component gallery (dev server: /gallery.html).
 * The document scrolls normally here so full-page screenshots capture it all.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../theme.css';
import { Gallery } from './Gallery';

for (const el of [document.documentElement, document.body, document.getElementById('root')]) {
  if (!el) continue;
  el.style.height = 'auto';
  el.style.overflow = 'visible';
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Gallery />
  </StrictMode>,
);
