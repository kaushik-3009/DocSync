import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests drive the real client against a real gateway (Postgres +
 * Redis required; CI provides them as service containers). Both servers are
 * started here so `pnpm test:e2e` is self-contained.
 */
const API_PORT = Number(process.env.E2E_API_PORT ?? 1250);
const CLIENT_PORT = Number(process.env.E2E_CLIENT_PORT ?? 5180);
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/docsync_e2e";
const REDIS_URL = process.env.E2E_REDIS_URL ?? "redis://localhost:6379/14";

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${CLIENT_PORT}`,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    // Sandboxes with a preinstalled browser can point at it.
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  webServer: [
    {
      command: "node --enable-source-maps packages/server/dist/index.js",
      url: `http://localhost:${API_PORT}/ready`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        PORT: String(API_PORT),
        DATABASE_URL,
        REDIS_URL,
        JWT_SECRET: "e2e-only-secret-0123456789abcdefghij",
        ALLOWED_ORIGINS: `http://localhost:${CLIENT_PORT}`,
        HTTP_RATE_LIMIT_POINTS: "10000",
        WS_CONNECT_RATE_LIMIT_POINTS: "10000",
        REGISTER_RATE_LIMIT_POINTS: "10000",
        LOGIN_RATE_LIMIT_POINTS: "10000",
        // Lets webhooks reach the test's local receiver; refused in production.
        WEBHOOKS_ALLOW_LOCAL: "true",
        WEBHOOK_DEBOUNCE_MS: "300",
        LOG_LEVEL: "warn",
      },
    },
    {
      command: `pnpm --filter @collab/client exec vite --port ${CLIENT_PORT} --strictPort`,
      url: `http://localhost:${CLIENT_PORT}`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { VITE_WS_URL: `ws://localhost:${API_PORT}/ws` },
    },
  ],
});

export const E2E_API_URL = `http://localhost:${API_PORT}`;
