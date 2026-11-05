import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

// The cloud container ships Chromium 141 at /opt/pw-browsers (Playwright 1.56.1).
// Locally, run `npx playwright install chromium` once.
const port = Number(process.env.E2E_PORT ?? 4173);
// Build directory to serve (default dist/). Lets a clean build from another checkout be tested.
const distDir = process.env.E2E_DIST ?? 'dist';
// A container whose preinstalled Chromium is not the pinned Playwright's own build links it here.
const cloudChromium = existsSync('/opt/pw-browsers/chromium-1194') ? undefined : ['/opt/pw-browsers/chromium'].find((p) => existsSync(p));
const executablePath = process.env.SB_CHROMIUM ?? cloudChromium;

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 2,
  reporter: [['list'], ['json', { outputFile: 'test-results/e2e-results.json' }]],
  use: {
    baseURL: `http://127.0.0.1:${port}/`,
    viewport: { width: 1366, height: 768 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      executablePath,
      args: ['--use-fake-ui-for-media-stream', '--autoplay-policy=user-gesture-required'],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 768 } } }],
  webServer: {
    command: `node launcher/serve.mjs ${distDir} --port ${port} --strict-port --no-open`,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
