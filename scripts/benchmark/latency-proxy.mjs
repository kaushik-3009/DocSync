#!/usr/bin/env node
// Order-preserving TCP proxy that adds a fixed one-way delay in each
// direction. Local Postgres answers in ~50µs, which hides exactly the
// round-trip cost that dominates on RDS; putting this proxy in front of it
// gives benchmarks a realistic network RTT without a cloud account.
//
// usage: node latency-proxy.mjs <listenPort> <targetHost:targetPort> <rttMs>
import net from "node:net";

const [listenPort, target, rttArg] = process.argv.slice(2);
if (!listenPort || !target || rttArg === undefined) {
  console.error("usage: latency-proxy.mjs <listenPort> <targetHost:targetPort> <rttMs>");
  process.exit(64);
}
const [targetHost, targetPort] = target.split(":");
const oneWayMs = Number(rttArg) / 2;

function delayedPipe(from, to) {
  // Each chunk is released at max(arrival + delay, previous release) so a
  // later chunk can never overtake an earlier one.
  let lastRelease = 0;
  from.on("data", (chunk) => {
    const releaseAt = Math.max(Date.now() + oneWayMs, lastRelease);
    lastRelease = releaseAt;
    setTimeout(() => to.writable && to.write(chunk), releaseAt - Date.now());
  });
  from.on("end", () => setTimeout(() => to.end(), Math.max(0, lastRelease - Date.now())));
  from.on("error", () => to.destroy());
}

net
  .createServer((client) => {
    const upstream = net.connect(Number(targetPort), targetHost);
    delayedPipe(client, upstream);
    delayedPipe(upstream, client);
  })
  .listen(Number(listenPort), () => console.log(`latency proxy :${listenPort} -> ${target} (${rttArg}ms RTT)`));
