export type RuntimeEnvironment = Record<string, string | undefined>;

export interface RuntimeConfig {
  port: number;
  trustProxy: boolean;
  databaseUrl: string | undefined;
  redisUrl: string | undefined;
  jwtSecret: string | undefined;
  allowedOrigins: string[];
  insecureLocalAuthBypass: boolean;
  resendApiKey: string | undefined;
  emailFrom: string | undefined;
  appBaseUrl: string;
  geminiApiKey: string | undefined;
  geminiModel: string;
}

export class RuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConfigError";
  }
}

const PLACEHOLDER_PATTERN = /(?:replace|change[-_ ]?me|your[-_ ]?|example|placeholder|<[^>]+>)/i;

function requiredValue(environment: RuntimeEnvironment, name: string): string | undefined {
  const value = environment[name]?.trim();
  if (!value) return undefined;
  if (PLACEHOLDER_PATTERN.test(value)) {
    throw new RuntimeConfigError(`${name} must be set to a real value, not a placeholder`);
  }
  return value;
}

function optionalValue(environment: RuntimeEnvironment, name: string): string | undefined {
  return environment[name]?.trim() || undefined;
}

function parseAllowedOrigins(value: string | undefined): string[] {
  if (!value) return [];

  const origins = value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  for (const origin of origins) {
    if (origin === "*" || PLACEHOLDER_PATTERN.test(origin)) {
      throw new RuntimeConfigError("ALLOWED_ORIGINS must contain explicit, non-placeholder origins");
    }
    try {
      const parsed = new URL(origin);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("unsupported protocol");
      }
      if (parsed.origin !== origin) {
        throw new Error("origin must not include a path");
      }
    } catch {
      throw new RuntimeConfigError(`ALLOWED_ORIGINS contains an invalid origin: ${origin}`);
    }
  }

  return origins;
}

/**
 * Validates the server's trust boundaries before it opens sockets or accepts
 * requests. The only way to start without authenticated persistence is an
 * explicitly named, development-only local bypass.
 */
export function loadRuntimeConfig(environment: RuntimeEnvironment): RuntimeConfig {
  const insecureLocalAuthBypass = environment.ALLOW_INSECURE_LOCAL_AUTH_BYPASS === "true";
  const nodeEnv = environment.NODE_ENV;

  if (insecureLocalAuthBypass && nodeEnv !== "development") {
    throw new RuntimeConfigError(
      "ALLOW_INSECURE_LOCAL_AUTH_BYPASS=true is allowed only when NODE_ENV=development"
    );
  }

  const value = insecureLocalAuthBypass ? optionalValue : requiredValue;
  const databaseUrl = value(environment, "DATABASE_URL");
  const redisUrl = value(environment, "REDIS_URL");
  const jwtSecret = value(environment, "JWT_SECRET");
  const allowedOrigins = parseAllowedOrigins(environment.ALLOWED_ORIGINS);

  if (!insecureLocalAuthBypass) {
    const missing = [
      ["DATABASE_URL", databaseUrl],
      ["REDIS_URL", redisUrl],
      ["JWT_SECRET", jwtSecret],
      ["ALLOWED_ORIGINS", allowedOrigins.length > 0 ? "configured" : undefined],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);

    if (missing.length > 0) {
      throw new RuntimeConfigError(
        `missing required secure runtime configuration: ${missing.join(", ")}. ` +
          "For a local-only unauthenticated session, set NODE_ENV=development and ALLOW_INSECURE_LOCAL_AUTH_BYPASS=true explicitly."
      );
    }
  }

  return {
    port: Number(environment.PORT ?? 1234),
    trustProxy: environment.TRUST_PROXY === "1",
    databaseUrl,
    redisUrl,
    jwtSecret,
    // Browsers still need CORS/WS origin checks in the explicitly insecure
    // local mode; this default does not apply to normal startup.
    allowedOrigins: allowedOrigins.length > 0 ? allowedOrigins : ["http://localhost:5173"],
    insecureLocalAuthBypass,
    resendApiKey: optionalValue(environment, "RESEND_API_KEY"),
    emailFrom: optionalValue(environment, "EMAIL_FROM"),
    appBaseUrl: optionalValue(environment, "APP_BASE_URL") ?? "http://localhost:5173",
    geminiApiKey: optionalValue(environment, "GEMINI_API_KEY"),
    geminiModel: optionalValue(environment, "GEMINI_MODEL") ?? "gemini-3.5-flash-lite",
  };
}
