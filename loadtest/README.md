# Collaborative benchmark harness

The old `http-health.js` and `ws-load.js` scripts are diagnostics only. They
must not be used for collaboration throughput or propagation claims.

The replacement harness uses real binary Yjs sync/update frames through nginx
to two Node gateway replicas, Postgres, and Redis. It creates one authenticated
benchmark user, opens 25, 50, or 100 WebSocket clients to a shared page, makes
concurrent Y.Map writes, waits for every connected document to converge, and
writes raw per-peer propagation observations.

## Local evidence run

1. Copy `.env.benchmark.example` to `.env.benchmark` and replace all
   placeholders with random local values.
2. Start a stage: `scripts/benchmark/up.sh 25`. Save the emitted run id.
3. Run the Yjs workload with the same id:
   `BENCHMARK_RUN_ID=<run-id> scripts/benchmark/run.sh 25`.
4. Collect gateway readiness, metrics, logs, and Docker stats:
   `scripts/benchmark/collect.sh <run-id>`.
5. Destroy the isolated local stack only after collection:
   `scripts/benchmark/down.sh`.

All evidence is written under `artifacts/benchmarks/<run-id>/`, which is
intentionally ignored by Git. A run is invalid when
`collection-summary.json` reports `twoReplicaParticipation: false`.

## Current boundary

`client-results.json` provides client-generated update rate, observed
client-to-peer propagation p50/p95/p99, transport errors, and an all-client
convergence assertion. `collect.sh` captures each gateway's durable update
counter and raw resource snapshots. It does **not yet** create a final capacity
report, calculate durable throughput across a timed sustained interval, or
exercise reconnect/failover; those remain open Phase B/C work.
