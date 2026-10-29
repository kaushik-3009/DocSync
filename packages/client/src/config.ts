/** WebSocket gateway base URL, e.g. `wss://api.example.com/ws`. */
export const WS_URL: string = import.meta.env.VITE_WS_URL ?? "ws://localhost:1234/ws";

/** The HTTP API shares the gateway's host and port. */
export const HTTP_BASE: string = WS_URL.replace(/^ws/, "http").replace(/\/ws\/?$/, "");

/** Must match the server's `WS_PROTOCOL`; the access token travels as a
 *  second offered subprotocol so it never appears in a URL. */
export const WS_PROTOCOL = "docsync.v1";

export function wsProtocols(token: string | null): string[] {
  return token ? [WS_PROTOCOL, `docsync.auth.${token}`] : [WS_PROTOCOL];
}
