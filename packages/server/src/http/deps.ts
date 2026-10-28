import type { Pool } from "pg";
import type { RateLimiterAbstract } from "rate-limiter-flexible";
import type { RuntimeConfig } from "../runtime-config.js";
import type { PageStore } from "../persistence/page-store.js";
import type { RoomRegistry } from "../room-registry.js";
import type { JobQueues } from "../jobs/queues.js";
import type { MentionsStore } from "../comments/mentions-store.js";
import type { ExportStorage } from "../exports/storage.js";
import type { AuthorshipStore } from "../authorship/store.js";

/**
 * Everything the HTTP app needs, injected so tests can build the app against
 * pg-mem (or a real database) without a process-level bootstrap. Optional
 * collaborators are null when their backing service isn't configured; routes
 * that need one answer 503.
 */
export interface AppDeps {
  config: RuntimeConfig;
  gatewayId: string;
  pool: Pool | null;
  pageStore: PageStore | null;
  registry: RoomRegistry;
  jobQueues: JobQueues | null;
  mentionsStore: MentionsStore | null;
  exportStorage: ExportStorage | null;
  authorship: AuthorshipStore | null;
  /** Null only under the explicit development-only auth bypass. */
  jwtSecret: string | null;
  limiters: {
    http: RateLimiterAbstract;
    login: RateLimiterAbstract;
    register: RateLimiterAbstract;
  };
  /** Readiness probe for the Redis fanout connection; null when Redis is off. */
  pingRedis: (() => Promise<boolean>) | null;
  /** Pushes an "invitations changed" signal to a user's open notification sockets. */
  notifyUser: (userId: string) => Promise<void>;
  maxBodyBytes: number;
}
