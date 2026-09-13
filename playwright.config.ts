import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.SCOUT_E2E_URL ?? "http://localhost:3400",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    reducedMotion: "reduce",
    channel: process.env.SCOUT_E2E_CHANNEL === "chrome" ? "chrome" : undefined,
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
      },
    },
    {
      name: "mobile",
      use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" },
    },
  ],
  webServer: process.env.SCOUT_E2E_URL
    ? undefined
    : {
        command: "pnpm --filter @scout/web dev --port 3400",
        url: "http://localhost:3400",
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: { SCOUT_SITE_URL: "http://localhost:3400" },
      },
});
