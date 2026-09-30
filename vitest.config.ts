import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { existsSync } from 'node:fs';

// Cloud container: reuse the preinstalled Chromium. Locally Playwright finds its own.
const cloudChromium = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const executablePath = process.env.SB_CHROMIUM ?? (existsSync(cloudChromium) ? cloudChromium : undefined);

export default defineConfig({
  test: {
    testTimeout: 30000,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['tests/unit/setup.ts'],
        },
      },
      {
        test: {
          name: 'browser',
          include: ['tests/browser/**/*.test.ts'],
          testTimeout: 60000,
          browser: {
            enabled: true,
            headless: true,
            provider: playwright({
              launchOptions: {
                executablePath,
                args: ['--autoplay-policy=no-user-gesture-required'],
              },
            }),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});
