import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './ui/theme.css';

function Placeholder() {
  return <main style={{ padding: 24 }}>SWITCHBOARD / 01 — building…</main>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Placeholder />
  </StrictMode>,
);
