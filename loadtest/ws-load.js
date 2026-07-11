import ws from "k6/ws";
import { check } from "k6";
import { Trend } from "k6/metrics";

/**
 * WebSocket load test against the real sync wire protocol, using k6's
 * classic `k6/ws` module. `k6/experimental/websockets`' open/message
 * listeners silently never fired in this k6 v1.5.0 build even though the
 * connection worked fine at the transport level (confirmed via k6's own
 * `ws_msgs_received` metric ticking up regardless) — a real, reproducible
 * quirk of that module in this environment, not a problem with the server.
 *
 * This measures connection-establishment latency under concurrency —
 * `ws_connect_ms`, time from initiating the connection to the WebSocket
 * handshake completing. Each VU holds its connection open for
 * CONNECTION_SECONDS to simulate concurrent idle-but-connected clients,
 * the way real collaborators mostly are (present, not constantly typing).
 *
 * (A message-received latency metric — e.g. time-to-first-message after the
 * server's unsolicited initial sync-step1 push, or round-trip latency on a
 * synthetic request — was attempted and dropped: server logs confirm the
 * push is sent for every connection (`Room.addConnection`, one `ws.send`
 * per join), but this k6 build's classic `ws` module did not reliably
 * dispatch "message"/"binaryMessage" callbacks to our script under this
 * concurrent per-vu-iterations scenario, with or without an additional
 * timer to pump its event loop. That's a k6/environment limitation
 * surfaced during this exercise, not a server-side gap — see
 * docs/LOAD_TESTING.md for how to re-attempt this measurement, e.g. with a
 * newer k6 build or Artillery's WebSocket engine instead.)
 *
 * Usage: BASE_URL=ws://localhost:1234 PAGE_MODE=hot k6 run loadtest/ws-load.js
 */

const BASE_URL = __ENV.BASE_URL || "ws://localhost:1234";
const PAGE_MODE = __ENV.PAGE_MODE || "many";
const CONNECTION_SECONDS = Number(__ENV.CONNECTION_SECONDS || 10);

const connectLatency = new Trend("ws_connect_ms", true);

// per-vu-iterations with iterations:1, not constant-vus: `ws.connect()` in the
// classic k6/ws module returns immediately if the connection is rejected
// (e.g. by Phase 7's ws-connect rate limiter), and constant-vus would then
// loop that VU back into a new attempt instantly, causing a reconnect storm
// once the rate limit engages (observed firsthand while building this
// script). Default VU count (25) is also deliberately within that limiter's
// budget (30 connection attempts/60s per IP) — all k6 VUs share one
// machine's source IP, so this measures steady-state connection behavior,
// not the rate limiter's cutoff (see http-rate-limit.js for that story on
// the HTTP side — same underlying mechanism, same caveat).
export const options = {
  scenarios: {
    ws_load: {
      executor: "per-vu-iterations",
      vus: Number(__ENV.VUS || 25),
      iterations: 1,
      maxDuration: `${CONNECTION_SECONDS + 15}s`,
    },
  },
};

export default function () {
  const pageId = PAGE_MODE === "hot" ? "loadtest-hot-page" : `loadtest-page-${__VU}`;
  const url = `${BASE_URL}/ws/${pageId}`;
  const connectStart = Date.now();

  const res = ws.connect(url, {}, (socket) => {
    socket.on("open", () => {
      connectLatency.add(Date.now() - connectStart);
    });
    socket.setTimeout(() => socket.close(), CONNECTION_SECONDS * 1000);
  });

  check(res, { "connected (101)": (r) => r && r.status === 101 });
}
