import type Redis from "ioredis";
import { randomBytes } from "node:crypto";
import { context } from "@opentelemetry/api";
import { childLogger } from "../logger.js";
import { currentTraceparent, contextFromTraceparent } from "../tracing/propagation.js";

const log = childLogger({ module: "redis-broadcaster" });

const MSG_UPDATE = 0;
const MSG_AWARENESS = 1;

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
    handlers: { onUpdate: (update: Uint8Array) => void; onAwareness: (encoded: Uint8Array) => void }
  ): Promise<void>;
  unsubscribeRoom(pageId: string): void;
}

function channelFor(pageId: string): string {
  return `collab:room:${pageId}`;
}

/**
 * Cross-instance fanout for a single logical "room" (pageId), backed by
 * Redis pub/sub. Every server instance publishes its own instanceId inside
 * each message so it can ignore its own echo (Redis delivers a published
 * message to every subscriber of a channel, including the publisher's own
 * subscribe connection). Room.ts never sees Redis directly — it only knows
 * the RoomBroadcaster interface, so Phase 4 doesn't have to touch anything
 * in Room's sync/awareness logic, only how updates enter/leave the process.
 */
export class RedisRoomBroadcaster implements RoomBroadcaster {
  private readonly instanceId = randomBytes(8);
  private readonly handlersByPage = new Map<
    string,
    { onUpdate: (update: Uint8Array) => void; onAwareness: (encoded: Uint8Array) => void }
  >();

  constructor(
    private readonly pub: Redis,
    private readonly sub: Redis
  ) {
    this.sub.on("messageBuffer", (channelBuf: Buffer, messageBuf: Buffer) => {
      const channel = channelBuf.toString();
      const pageId = this.pageIdForChannel(channel);
      if (!pageId) return;
      const handlers = this.handlersByPage.get(pageId);
      if (!handlers) return;

      const senderId = messageBuf.subarray(0, 8);
      if (senderId.equals(this.instanceId)) return; // our own publish, echoed back by Redis

      const type = messageBuf.readUInt8(8);
      const hasTraceparent = messageBuf.readUInt8(9) === 1;
      const traceparent = hasTraceparent
        ? messageBuf.subarray(10, 10 + TRACEPARENT_BYTES).toString("ascii")
        : undefined;
      const payload = new Uint8Array(messageBuf.subarray(hasTraceparent ? 10 + TRACEPARENT_BYTES : 10));

      // Continues the originating instance's trace on this instance — this is
      // what lets a single edit's trace span both processes behind the
      // Phase 4 load balancer, not just the one that received the WS message.
      context.with(contextFromTraceparent(traceparent), () => {
        if (type === MSG_UPDATE) {
          handlers.onUpdate(payload);
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

  private publish(pageId: string, type: number, payload: Uint8Array): void {
    const traceparent = currentTraceparent();
    const header = traceparent
      ? Buffer.concat([Buffer.from([1]), Buffer.from(traceparent, "ascii")])
      : Buffer.from([0]);
    const frame = Buffer.concat([this.instanceId, Buffer.from([type]), header, Buffer.from(payload)]);
    this.pub.publish(channelFor(pageId), frame).catch((err) => {
      log.error({ event: "publish_failed", pageId, err }, "failed to publish to redis");
    });
  }

  publishUpdate(pageId: string, update: Uint8Array): void {
    this.publish(pageId, MSG_UPDATE, update);
  }

  publishAwareness(pageId: string, encoded: Uint8Array): void {
    this.publish(pageId, MSG_AWARENESS, encoded);
  }

  async subscribeRoom(
    pageId: string,
    handlers: { onUpdate: (update: Uint8Array) => void; onAwareness: (encoded: Uint8Array) => void }
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
}
