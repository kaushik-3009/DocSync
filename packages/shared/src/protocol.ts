/**
 * Wire-level message type tags. These match the y-websocket / y-protocols
 * convention (messageSync = 0, messageAwareness = 1) so the hand-rolled
 * server and the off-the-shelf `y-websocket` client provider speak the same
 * protocol without a translation layer. Room/page identity itself is carried
 * out-of-band in the WebSocket URL path (`/ws/<pageId>`), not in this enum.
 */
export const MessageType = {
  Sync: 0,
  Awareness: 1,
  /** Benchmark/evidence-only metadata sent immediately before one Sync update.
   * Standard y-websocket clients never send this optional frame. */
  MutationMetadata: 2,
} as const;

export type MessageTypeValue = (typeof MessageType)[keyof typeof MessageType];

export interface ClientMutationMetadata {
  mutationId: string;
  createdAtMs: number;
}

/** Extracts the pageId from a gateway URL path like "/ws/<pageId>". */
export function pageIdFromPath(path: string): string | null {
  const match = path.match(/^\/ws\/([A-Za-z0-9_-]+)$/);
  return match ? match[1] : null;
}
