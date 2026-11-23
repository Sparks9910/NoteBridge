import { existsSync } from 'node:fs';
import { chromium, defineConfig } from '@playwright/test';

const hasBundledChromium = existsSync(chromium.executablePath());

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  globalTimeout: 180_000,
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    viewport: { width: 1280, height: 860 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    headless: true,
    launchOptions: {
      args: ['--autoplay-policy=no-user-gesture-required'],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: hasBundledChromium ? {} : { channel: 'chrome' },
    },
  ],
  webServer: [
    {
      command:
        'node ./node_modules/vite/bin/vite.js --port 5173 --strictPort --host 127.0.0.1',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        ...process.env,
        VITE_APP_ENV: 'development',
        VITE_ENABLE_DEMO_MODE: 'false',
      },
    },
    {
      command:
        'node ./node_modules/vite/bin/vite.js --port 5174 --strictPort --host 127.0.0.1',
      url: 'http://127.0.0.1:5174',
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        ...process.env,
        VITE_APP_ENV: 'development',
        VITE_ENABLE_DEMO_MODE: 'true',
      },
    },
  ],
});
