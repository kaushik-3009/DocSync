import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import type Redis from "ioredis";
import { WebSocketServer, type WebSocket } from "ws";
import { tokenFromWsProtocols, verifyToken, WS_PROTOCOL } from "../auth/jwt.js";
import { childLogger } from "../logger.js";

const CHANNEL = "collab:notifications";
const log = childLogger({ module: "notifications/gateway" });

export class NotificationGateway {
  private readonly sockets = new Map<string, Set<WebSocket>>();
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1024,
    handleProtocols: (protocols) => (protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false),
  });

  constructor(
    private readonly publisher: Redis,
    private readonly subscriber: Redis,
    private readonly jwtSecret: string,
    private readonly allowedOrigins: string[]
  ) {}

  async attach(httpServer: HttpServer): Promise<void> {
    await this.subscriber.subscribe(CHANNEL);
    this.subscriber.on("message", (channel, raw) => {
      if (channel !== CHANNEL) return;
      try {
        const signal = JSON.parse(raw) as { id: string; userId: string };
        for (const socket of this.sockets.get(signal.userId) ?? []) {
          if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: "notifications_changed", id: signal.id }));
        }
      } catch (error) {
        log.warn({ event: "notification_signal_invalid", error }, "ignored malformed notification signal");
      }
    });

    httpServer.on("upgrade", (request, socket, head) => {
      const { pathname } = new URL(request.url ?? "", "http://internal");
      if (pathname !== "/notifications") return;
      const origin = request.headers.origin;
      if (!origin || !this.allowedOrigins.includes(origin)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        const token = tokenFromWsProtocols(request.headers["sec-websocket-protocol"]);
        const payload = token ? verifyToken(token, this.jwtSecret) : null;
        if (!payload) {
          ws.close(4401, "invalid or missing token");
          return;
        }
        const userSockets = this.sockets.get(payload.sub) ?? new Set<WebSocket>();
        userSockets.add(ws);
        this.sockets.set(payload.sub, userSockets);
        ws.on("close", () => {
          userSockets.delete(ws);
          if (userSockets.size === 0) this.sockets.delete(payload.sub);
        });
      });
    });
  }

  async publish(userId: string): Promise<void> {
    await this.publisher.publish(CHANNEL, JSON.stringify({ id: randomUUID(), userId }));
  }

  async close(): Promise<void> {
    for (const sockets of this.sockets.values()) for (const socket of sockets) socket.close(1012, "server restart");
    await this.subscriber.unsubscribe(CHANNEL).catch(() => undefined);
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}
