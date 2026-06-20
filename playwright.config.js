// @ts-check
const { defineConfig, devices } = require("@playwright/test");

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000";

module.exports = defineConfig({
  testDir:     "./tests/e2e",
  timeout:     30000,
  retries:     process.env.CI ? 2 : 0,
  workers:     process.env.CI ? 2 : 4,
  reporter:    [["html", { open: "never" }], ["list"]],
  fullyParallel: false,           // sequential to avoid localStorage conflicts

  use: {
    baseURL:           BASE_URL,
    viewport:          { width: 390, height: 844 },
    actionTimeout:     8000,
    navigationTimeout: 15000,
    screenshot:        "only-on-failure",
    video:             "retain-on-failure",
    trace:             "retain-on-failure",
    ignoreHTTPSErrors: true,
    storageState:      undefined,
  },

  projects: [
    {
      name:  "mobile-chrome",
      use:   { ...devices["Pixel 5"] },
    },
    {
      name:  "desktop-chrome",
      use:   { viewport: { width: 1280, height: 800 } },
    },
    {
      name:  "mobile-safari",
      use:   { ...devices["iPhone 13"] },
    },
  ],

  /* Start local server automatically if not already running */
  webServer: {
    command:   "npx http-server . -p 3000 --cors -c-1 -s",
    url:       "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout:   10000,
  },
});
