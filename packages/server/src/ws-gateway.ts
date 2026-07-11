import { randomUUID } from "node:crypto";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Pool } from "pg";
import type { RateLimiterAbstract } from "rate-limiter-flexible";
import { WebSocketServer, type WebSocket } from "ws";
import { pageIdFromPath } from "@collab/shared";
import { RoomRegistry } from "./room-registry.js";
import { childLogger } from "./logger.js";
import { tryConsume } from "./rate-limit/limiters.js";
import { verifyToken } from "./auth/jwt.js";
import { resolveRoleForConnection } from "./auth/rbac.js";
import { recordAudit } from "./auth/audit.js";
import { wsConnectionsActive, roomsActive, wsMessagesTotal, rateLimitRejectionsTotal } from "./metrics/registry.js";

const log = childLogger({ module: "ws-gateway" });

/** When set, connections must present a valid JWT (as `?token=` on the ws URL) and are
 *  resolved to an RBAC role before joining a Room. Omitted entirely (undefined), every
 *  connection is unrestricted — exactly Phases 1-4 behavior, same "optional collaborator,
 *  zero cost until enabled" pattern as PageStore and RoomBroadcaster. */
export interface WsAuthConfig {
  jwtSecret: string;
  pool: Pool;
}

/** When set, connection attempts and per-connection message rates are capped. Omitted
 *  entirely, there's no limiting at the WebSocket layer — same optional-collaborator
 *  pattern as everything else added since Phase 2. */
export interface WsRateLimitConfig {
  connect: RateLimiterAbstract;
  message: RateLimiterAbstract;
}

/** Only trust `X-Forwarded-For` when told the server actually sits behind a
 *  proxy that sets it (nginx, per this project's docker-compose.yml) —
 *  otherwise any direct caller can put an arbitrary value in that header and
 *  get a fresh fake IP per request, bypassing the connect-rate limiter
 *  entirely. */
function clientIp(request: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = request.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.length > 0) return forwarded.split(",")[0].trim();
  }
  return request.socket.remoteAddress ?? "unknown";
}

/**
 * Attaches the WebSocket upgrade handler to an existing HTTP server and
 * routes each connection to a Room by the pageId in its URL path
 * (`/ws/<pageId>`). Keeping room resolution here (not in Room/RoomRegistry)
 * is what let auth (Phase 5) land as a check in this handler before a
 * connection is ever handed to a Room, without touching Room/RoomRegistry's
 * own logic — and is exactly why Phase 7's rate limiting lands the same way.
 */
export function attachWsGateway(
  httpServer: HttpServer,
  registry: RoomRegistry,
  auth?: WsAuthConfig,
  rateLimit?: WsRateLimitConfig,
  trustProxy = false
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request, socket, head) => {
    const rawUrl = request.url ?? "";
    const { pathname, searchParams } = new URL(rawUrl, "http://internal");
    const pageId = pageIdFromPath(pathname);

    if (!pageId) {
      log.warn({ event: "rejected_upgrade", url: rawUrl }, "no pageId in path, rejecting connection");
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    // Token verification used to happen here, pre-handshake, rejecting with a
    // raw `socket.write("HTTP/1.1 401...")` + `socket.destroy()`. That never
    // completes the WebSocket handshake, so the browser's WebSocket object
    // has no close code to distinguish it by — y-websocket's reconnect logic
    // sees the same generic abnormal-closure it would see for a network blip
    // or (see below) a rate-limit rejection, and retries forever on a fixed
    // ~2.5s backoff cap. A tab left open with a stale/expired token then
    // hammers this endpoint indefinitely — and since `rl:ws-connect` is
    // keyed by IP, not by page, that alone can exhaust the connect budget
    // for every other page/tab on the same machine. Moving the check into
    // the post-handshake "connection" handler below lets it close with a
    // real application code (4401, matching the existing 4403 for
    // role-denied) that the client *can* act on to stop retrying — see
    // useYDoc.ts's "connection-close" handler.
    const proceedAfterConnectLimit = () => {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request, pageId, searchParams.get("token"));
      });
    };

    if (rateLimit) {
      tryConsume(rateLimit.connect, clientIp(request, trustProxy)).then(({ allowed, infraError }) => {
        if (infraError) {
          log.error({ event: "rate_limiter_store_error", scope: "ws_connect", err: infraError }, "rate limiter store unavailable — failing open");
        }
        if (!allowed) {
          rateLimitRejectionsTotal.inc({ scope: "ws_connect" });
          log.warn({ event: "rejected_upgrade", pageId, reason: "connect_rate_limited" }, "rejecting connection");
          // Same reasoning as the auth-rejection comment above: a raw
          // pre-handshake socket.write + destroy leaves the client with no
          // real close code, so it retries immediately and indefinitely —
          // which, being IP-keyed, just keeps consuming the same budget it
          // tripped and can never recover. Complete the handshake, then
          // close with a real code the client can act on (matching 4429
          // used for the per-connection message rate limit below).
          wss.handleUpgrade(request, socket, head, (ws) => {
            ws.close(4429, "connect rate limit exceeded");
          });
          return;
        }
        proceedAfterConnectLimit();
      });
    } else {
      proceedAfterConnectLimit();
    }
  });

  wss.on("connection", (ws: WebSocket, _request: IncomingMessage, pageId: string, token: string | null) => {
    wsConnectionsActive.inc();
    const messageLimitKey = randomUUID();

    // Room resolution is async (it may replay a page's history from
    // Postgres, and now may also resolve an RBAC role from Postgres), but
    // the socket can start receiving frames immediately. Buffer anything
    // that arrives before the room is ready and replay it in order once
    // addConnection has run — otherwise those frames would be silently
    // dropped (ws only emits "message" while a listener exists, it doesn't
    // queue).
    let room: import("./room.js").Room | null = null;
    let closed = false;
    const buffered: Uint8Array[] = [];

    const handle = (bytes: Uint8Array) => {
      wsMessagesTotal.inc();
      if (!room) {
        buffered.push(bytes);
        return;
      }
      try {
        room.handleMessage(ws, bytes);
      } catch (err) {
        log.error({ event: "message_handling_error", pageId, err }, "failed to handle message");
      }
    };

    ws.on("message", (data: Buffer) => {
      const bytes = new Uint8Array(data);
      if (!rateLimit) return handle(bytes);

      tryConsume(rateLimit.message, messageLimitKey).then(({ allowed, infraError }) => {
        if (infraError) {
          log.error({ event: "rate_limiter_store_error", scope: "ws_message", err: infraError }, "rate limiter store unavailable — failing open");
        }
        if (!allowed) {
          rateLimitRejectionsTotal.inc({ scope: "ws_message" });
          log.warn({ event: "connection_rate_limited", pageId }, "closing connection for exceeding message rate limit");
          ws.close(4429, "message rate limit exceeded");
          return;
        }
        handle(bytes);
      });
    });

    ws.on("close", () => {
      closed = true;
      wsConnectionsActive.dec();
      if (room) {
        room.removeConnection(ws);
        registry.releaseRoom(pageId);
        roomsActive.set(registry.activeRoomCount);
      }
    });

    ws.on("error", (err) => {
      log.error({ event: "socket_error", pageId, err }, "socket error");
    });

    (async () => {
      let role: import("@collab/shared").Role | null = null;
      let userId: string | null = null;
      if (auth) {
        const payload = token ? verifyToken(token, auth.jwtSecret) : null;
        if (!payload) {
          log.warn({ event: "rejected_upgrade", pageId, reason: "invalid_or_missing_token" }, "rejecting connection");
          ws.close(4401, "invalid or missing token");
          return;
        }
        userId = payload.sub;

        role = await resolveRoleForConnection(auth.pool, pageId, userId);
        if (!role) {
          recordAudit(auth.pool, { userId, pageId, event: "ws_access_denied" });
          ws.close(4403, "no access to this page");
          return;
        }
      }

      const resolvedRoom = await registry.getOrCreateRoom(pageId);
      if (closed) return; // client disconnected while the room/role was resolving
      room = resolvedRoom;
      room.addConnection(ws, role);
      roomsActive.set(registry.activeRoomCount);
      if (auth && userId) recordAudit(auth.pool, { userId, pageId, event: "ws_connected", metadata: { role } });
      for (const bytes of buffered) {
        room.handleMessage(ws, bytes);
      }
    })().catch((err) => {
      log.error({ event: "room_load_failed", pageId, err }, "failed to load room");
      ws.close(1011, "failed to load room");
    });
  });

  return wss;
}
