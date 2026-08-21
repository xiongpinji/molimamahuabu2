import { defineConfig } from '@playwright/test'

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3013'
const port = new URL(baseURL).port || '3013'

export default defineConfig({
  testDir: './e2e',
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  reporter: process.env.CI ? 'dot' : 'list',
  use: {
    baseURL,
    colorScheme: 'dark',
    trace: 'retain-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port}`,
    url: `${baseURL}/`,
    reuseExistingServer: process.env.PLAYWRIGHT_REUSE_SERVER !== '0' && !process.env.CI,
    timeout: 120_000,
  },
})
