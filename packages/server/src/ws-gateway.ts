import { randomUUID } from "node:crypto";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Pool } from "pg";
import type { RateLimiterAbstract } from "rate-limiter-flexible";
import { WebSocketServer, type WebSocket } from "ws";
import { pageIdFromPath } from "@collab/shared";
import { RoomRegistry } from "./room-registry.js";
import { childLogger } from "./logger.js";
import { tryConsume } from "./rate-limit/limiters.js";
import { tokenFromWsProtocols, verifyToken, WS_PROTOCOL } from "./auth/jwt.js";
import { resolveRoleForConnection } from "./auth/rbac.js";
import { recordAudit } from "./auth/audit.js";
import { wsConnectionsActive, wsConnectionsTotal, roomsActive, wsMessagesTotal, rateLimitRejectionsTotal } from "./metrics/registry.js";

const log = childLogger({ module: "ws-gateway" });

/** When set, connections must present a valid JWT (as a `docsync.auth.<jwt>`
 *  WebSocket subprotocol, never in the URL) and are resolved to an RBAC role
 *  before joining a Room. Omitted only under the local auth bypass. */
export interface WsAuthConfig {
  jwtSecret: string;
  pool: Pool;
}

/** When set, connection attempts and per-connection message rates are capped. */
export interface WsRateLimitConfig {
  connect: RateLimiterAbstract;
  message: RateLimiterAbstract;
}

export interface WsSecurityConfig {
  /** Browser origins permitted to establish a socket. Empty means disabled for local/dev use. */
  allowedOrigins?: string[];
  maxPayloadBytes?: number;
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
 * (`/ws/<pageId>`). Origin checks, rate limits and auth all happen here,
 * before a connection is handed to a Room.
 */
export function attachWsGateway(
  httpServer: HttpServer,
  registry: RoomRegistry,
  auth?: WsAuthConfig,
  rateLimit?: WsRateLimitConfig,
  trustProxy = false,
  security: WsSecurityConfig = {}
): WebSocketServer {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: security.maxPayloadBytes ?? 1_048_576,
    // Browsers fail the handshake unless the server selects one of the
    // offered subprotocols; the auth "protocol" is never echoed back.
    handleProtocols: (protocols) => (protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false),
  });

  httpServer.on("upgrade", (request, socket, head) => {
    const rawUrl = request.url ?? "";
    const { pathname } = new URL(rawUrl, "http://internal");
    // A separate authenticated WebSocket gateway owns this path. Ignore it
    // here so two upgrade listeners can safely share the HTTP server.
    if (pathname === "/notifications") return;
    const pageId = pageIdFromPath(pathname);

    const origin = request.headers.origin;
    if (security.allowedOrigins?.length && (!origin || !security.allowedOrigins.includes(origin))) {
      log.warn({ event: "rejected_upgrade", origin, reason: "origin_not_allowed" }, "rejecting websocket origin");
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    if (!pageId) {
      log.warn({ event: "rejected_upgrade", url: rawUrl }, "no pageId in path, rejecting connection");
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    // Auth runs after the handshake completes so rejections carry real close
    // codes (4401/4403/4429). A raw pre-handshake 401 looks like a network
    // blip to y-websocket, which then retries forever and burns the IP-keyed
    // connect budget for every other tab.
    const proceedAfterConnectLimit = () => {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request, pageId, tokenFromWsProtocols(request.headers["sec-websocket-protocol"]));
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
          // Complete the handshake so the client gets a code it can act on.
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
    wsConnectionsTotal.inc();
    const connectionId = randomUUID();
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
    let bufferedBytes = 0;
    const maxBufferedBytes = security.maxPayloadBytes ?? 1_048_576;

    const handle = (bytes: Uint8Array) => {
      wsMessagesTotal.inc();
      if (!room) {
        bufferedBytes += bytes.byteLength;
        if (bufferedBytes > maxBufferedBytes) {
          log.warn({ event: "connection_buffer_exceeded", pageId, connectionId, bufferedBytes }, "closing connection with excessive pre-room data");
          ws.close(1009, "message buffer too large");
          return;
        }
        buffered.push(bytes);
        return;
      }
      try {
        room.handleMessage(ws, bytes);
      } catch (err) {
        log.error({ event: "message_handling_error", pageId, connectionId, err }, "failed to handle message");
      }
    };

    ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary) => {
      if (!isBinary || Array.isArray(data)) {
        ws.close(1003, "binary protocol required");
        return;
      }
      const bytes = new Uint8Array(data);
      if (!rateLimit) return handle(bytes);

      tryConsume(rateLimit.message, messageLimitKey).then(({ allowed, infraError }) => {
        if (infraError) {
          log.error({ event: "rate_limiter_store_error", scope: "ws_message", err: infraError }, "rate limiter store unavailable — failing open");
        }
        if (!allowed) {
          rateLimitRejectionsTotal.inc({ scope: "ws_message" });
          log.warn({ event: "connection_rate_limited", pageId, connectionId }, "closing connection for exceeding message rate limit");
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
      log.error({ event: "socket_error", pageId, connectionId, err }, "socket error");
    });

    (async () => {
      let role: import("@collab/shared").Role | null = null;
      let userId: string | null = null;
      if (auth) {
        const payload = token ? verifyToken(token, auth.jwtSecret) : null;
        if (!payload) {
          log.warn({ event: "rejected_upgrade", pageId, connectionId, reason: "invalid_or_missing_token" }, "rejecting connection");
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
      if (closed) {
        registry.releaseRoom(pageId);
        return;
      }
      room = resolvedRoom;
      room.addConnection(ws, role, userId);
      roomsActive.set(registry.activeRoomCount);
      if (auth && userId) recordAudit(auth.pool, { userId, pageId, event: "ws_connected", metadata: { role, connectionId } });
      for (const bytes of buffered) {
        room.handleMessage(ws, bytes);
      }
    })().catch((err) => {
      log.error({ event: "room_load_failed", pageId, connectionId, err }, "failed to load room");
      ws.close(1011, "failed to load room");
    });
  });

  return wss;
}
