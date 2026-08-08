import { describe, expect, it } from "vitest";
import { loadRuntimeConfig, RuntimeConfigError } from "../src/runtime-config.js";

const secureEnvironment = {
  DATABASE_URL: "postgres://collab:password@localhost:5432/collab",
  REDIS_URL: "redis://:password@localhost:6379",
  JWT_SECRET: "a-long-random-secret",
  ALLOWED_ORIGINS: "https://app.collab.test,http://localhost:5173",
};

describe("loadRuntimeConfig", () => {
  it("requires every security dependency during normal startup", () => {
    expect(() => loadRuntimeConfig({})).toThrow(RuntimeConfigError);
    expect(() => loadRuntimeConfig({ ...secureEnvironment, REDIS_URL: undefined })).toThrow(/REDIS_URL/);
    expect(() => loadRuntimeConfig({ ...secureEnvironment, ALLOWED_ORIGINS: undefined })).toThrow(/ALLOWED_ORIGINS/);
  });

  it("rejects placeholder and wildcard configuration", () => {
    expect(() => loadRuntimeConfig({ ...secureEnvironment, JWT_SECRET: "replace-with-a-secret" })).toThrow(/placeholder/);
    expect(() => loadRuntimeConfig({ ...secureEnvironment, ALLOWED_ORIGINS: "*" })).toThrow(/explicit/);
  });

  it("permits unauthenticated local mode only through the explicit development bypass", () => {
    const config = loadRuntimeConfig({
      NODE_ENV: "development",
      ALLOW_INSECURE_LOCAL_AUTH_BYPASS: "true",
      JWT_SECRET: "replace-with-a-secret",
    });
    expect(config.insecureLocalAuthBypass).toBe(true);
    expect(config.allowedOrigins).toEqual(["http://localhost:5173"]);
    expect(config.databaseUrl).toBeUndefined();

    expect(() =>
      loadRuntimeConfig({
        ALLOW_INSECURE_LOCAL_AUTH_BYPASS: "true",
      })
    ).toThrow(/NODE_ENV=development/);
  });
});
