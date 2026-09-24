import { defineConfig, devices } from "@playwright/test";

/**
 * One Playwright config for the demo:
 *   shop        — the shop's own tests: everything that works, works.
 *   answer-key  — one test per planted bug, marked test.fail(): they pass
 *                 while the bug is there, and turn red if it disappears.
 *   colleague   — a colleague's weak tests, kept for Proofwright's review and
 *                 prove tools. Never part of `npm test`.
 *   generated   — the seed test Playwright's planner and generator start from,
 *                 and the tests the generator writes. They meet the planted
 *                 bugs, so they're never part of `npm test` either.
 */
// 4610 sits outside the ranges dev servers grab (Vite takes 5173–5199).
const PORT = Number(process.env.SHOP_PORT ?? 4610);
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? "dot" : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "shop", testDir: "demo/tests", use: { ...devices["Desktop Chrome"] } },
    { name: "answer-key", testDir: "demo/answer-key", use: { ...devices["Desktop Chrome"] } },
    { name: "colleague", testDir: "demo/colleague", use: { ...devices["Desktop Chrome"] } },
    { name: "generated", testDir: "demo/generated", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "node demo/shop/server.mjs",
    url: `${baseURL}/api/health`,
    env: { PORT: String(PORT) },
    // Never reuse whatever is already listening: a test run against the wrong
    // app would pass or fail for reasons that have nothing to do with the shop.
    reuseExistingServer: false,
    stdout: "ignore",
    stderr: "pipe",
  },
});
