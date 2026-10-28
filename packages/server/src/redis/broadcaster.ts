import type Redis from "ioredis";
import { randomBytes } from "node:crypto";
import { context } from "@opentelemetry/api";
import { childLogger } from "../logger.js";
import { currentTraceparent, contextFromTraceparent } from "../tracing/propagation.js";
import type { CommittedFanoutUpdate, CommittedUpdatePublisher } from "../persistence/fanout-outbox.js";

const log = childLogger({ module: "redis-broadcaster" });

const MSG_UPDATE = 0;
const MSG_AWARENESS = 1;
/** Versioned committed-update envelope. Older gateways ignore this unknown
 * type rather than mis-parsing a sequence prefix as Yjs bytes. Rollouts must
 * therefore drain old gateways before relying on gap repair. */
const MSG_COMMITTED_UPDATE = 2;

/** W3C traceparent headers are always exactly this many ASCII bytes
 *  ("00-<32 hex trace id>-<16 hex span id>-<2 hex flags>"). Reserving a fixed
 *  slot means the frame format doesn't need a variable-length prefix beyond
 *  the one byte saying whether a traceparent is present at all. */
const TRACEPARENT_BYTES = 55;

export interface RoomBroadcaster {
  publishUpdate(pageId: string, update: Uint8Array): void;
  publishAwareness(pageId: string, encoded: Uint8Array): void;
  subscribeRoom(
    pageId: string,
    handlers: { onUpdate: (update: Uint8Array, seq?: number) => void; onAwareness: (encoded: Uint8Array) => void }
  ): Promise<void>;
  unsubscribeRoom(pageId: string): void;
  /** Invoked after the Redis subscription connection becomes ready again. */
  setReconnectHandler?(handler: () => void): void;
}

function channelFor(pageId: string): string {
  return `collab:room:${pageId}`;
}

/**
 * Cross-instance fanout for a single logical "room" (pageId), backed by
 * Redis pub/sub. Every server instance publishes its own instanceId inside
 * each message. Direct legacy update/awareness frames suppress their own
 * Redis echo; committed outbox frames remain deliverable to the publisher
 * because any process may claim a shared Postgres outbox row. Room.ts never
 * sees Redis directly — it only knows the RoomBroadcaster interface, so the
 * transport can change without touching sync/awareness logic.
 */
export class RedisRoomBroadcaster implements RoomBroadcaster, CommittedUpdatePublisher {
  private readonly instanceId = randomBytes(8);
  private readonly handlersByPage = new Map<
    string,
    { onUpdate: (update: Uint8Array, seq?: number) => void; onAwareness: (encoded: Uint8Array) => void }
  >();
  private reconnectHandler: (() => void) | null = null;
  private hasReachedReady = false;

  constructor(
    private readonly pub: Redis,
    private readonly sub: Redis
  ) {
    this.sub.on("ready", () => {
      if (this.hasReachedReady) {
        log.warn({ event: "redis_subscription_ready_after_reconnect" }, "Redis subscription reconnected; reconciling active rooms");
        this.reconnectHandler?.();
      }
      this.hasReachedReady = true;
    });
    this.sub.on("messageBuffer", (channelBuf: Buffer, messageBuf: Buffer) => {
      const channel = channelBuf.toString();
      const pageId = this.pageIdForChannel(channel);
      if (!pageId) return;
      const handlers = this.handlersByPage.get(pageId);
      if (!handlers) return;

      const type = messageBuf.readUInt8(8);
      const senderId = messageBuf.subarray(0, 8);
      // Legacy update/awareness frames are published directly by the Room and
      // are already applied locally, so suppress their Redis echo. Committed
      // outbox frames are different: any gateway may claim a shared Postgres
      // row and publish it. Suppressing by publisher instance would therefore
      // drop a row from the claiming gateway's local peers when that gateway
      // did not originate the edit. Room's durable sequence cursor makes a
      // committed self-echo idempotent, so deliver it for reconciliation.
      if (senderId.equals(this.instanceId) && type !== MSG_COMMITTED_UPDATE) return;
      const hasTraceparent = messageBuf.readUInt8(9) === 1;
      const traceparent = hasTraceparent ? messageBuf.subarray(10, 10 + TRACEPARENT_BYTES).toString("ascii") : undefined;
      const payloadOffset = hasTraceparent ? 10 + TRACEPARENT_BYTES : 10;
      const payload = new Uint8Array(messageBuf.subarray(payloadOffset));

      // Continues the originating instance's trace on this instance — this is
      // what lets a single edit's trace span both processes behind the
      // Phase 4 load balancer, not just the one that received the WS message.
      context.with(contextFromTraceparent(traceparent), () => {
        if (type === MSG_UPDATE) {
          handlers.onUpdate(payload);
        } else if (type === MSG_COMMITTED_UPDATE) {
          if (payload.length < 8) {
            log.warn({ event: "committed_update_frame_too_short", pageId }, "dropped malformed committed Redis update");
            return;
          }
          const seq = Number(Buffer.from(payload.subarray(0, 8)).readBigUInt64BE());
          handlers.onUpdate(payload.subarray(8), seq);
        } else if (type === MSG_AWARENESS) {
          handlers.onAwareness(payload);
        }
      });
    });
  }

  private pageIdForChannel(channel: string): string | null {
    const prefix = "collab:room:";
    return channel.startsWith(prefix) ? channel.slice(prefix.length) : null;
  }

  private frame(type: number, payload: Uint8Array, traceparent = currentTraceparent()): Buffer {
    const header = traceparent ? Buffer.concat([Buffer.from([1]), Buffer.from(traceparent, "ascii")]) : Buffer.from([0]);
    return Buffer.concat([this.instanceId, Buffer.from([type]), header, Buffer.from(payload)]);
  }

  private publish(pageId: string, type: number, payload: Uint8Array): void {
    this.pub.publish(channelFor(pageId), this.frame(type, payload)).catch((err) => {
      log.error({ event: "publish_failed", pageId, err }, "failed to publish to redis");
    });
  }

  publishUpdate(pageId: string, update: Uint8Array): void {
    this.publish(pageId, MSG_UPDATE, update);
  }

  /** Awaited only by FanoutOutbox. It is intentionally separate from the
   * awareness/local compatibility API so a durable update cannot be marked
   * delivered until Redis acknowledges the publish command. */
  async publishCommittedUpdate(update: CommittedFanoutUpdate): Promise<void> {
    const seq = Buffer.allocUnsafe(8);
    seq.writeBigUInt64BE(BigInt(update.seq));
    await this.pub.publish(
      channelFor(update.pageId),
      this.frame(MSG_COMMITTED_UPDATE, Buffer.concat([seq, Buffer.from(update.update)]), update.traceparent ?? undefined)
    );
  }

  publishAwareness(pageId: string, encoded: Uint8Array): void {
    this.publish(pageId, MSG_AWARENESS, encoded);
  }

  async subscribeRoom(
    pageId: string,
    handlers: { onUpdate: (update: Uint8Array, seq?: number) => void; onAwareness: (encoded: Uint8Array) => void }
  ): Promise<void> {
    this.handlersByPage.set(pageId, handlers);
    await this.sub.subscribe(channelFor(pageId));
  }

  unsubscribeRoom(pageId: string): void {
    this.handlersByPage.delete(pageId);
    this.sub.unsubscribe(channelFor(pageId)).catch((err) => {
      log.error({ event: "unsubscribe_failed", pageId, err }, "failed to unsubscribe from redis channel");
    });
  }

  setReconnectHandler(handler: () => void): void {
    this.reconnectHandler = handler;
  }
}
