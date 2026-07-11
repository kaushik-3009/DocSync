# Collab Workspace

A real-time collaborative document editor. Multiple people type into the
same document, code block, or drawing canvas at once, and it just
converges, the same way Google Docs or Notion feels, built from scratch
to understand how that actually works under the hood.

I started this because "real-time collaboration" is one of those features
that sounds simple until you try to build it. Two people edit the same
sentence at the same instant. A laptop goes to sleep mid-edit and wakes up
ten seconds later. A server restarts while someone's typing. Any one of
those can silently corrupt a document if the underlying merge logic isn't
actually correct, not just usually correct. So instead of building a
CRUD app with a WebSocket bolted on, I built the sync engine first, proved
it converges under real concurrent connections, and only then built the
product on top of it: accounts, permissions, version history, comments,
search, PDF export, and an embedded code editor and drawing canvas that
sync the same way the text does.

It's a solo project built in about twenty phases, each one shipping
working, independently testable software rather than one long
uninterruptible build. What's below is the honest state of it: what
works, how it's tested, and what I'd still change.

## What it does

- **Real-time block editor.** Type into a document, see other people's
  cursors and edits appear live, no refresh, no merge conflicts.
- **Embedded collaborative code blocks** (CodeMirror 6) and a
  **collaborative drawing canvas** (tldraw), both syncing through the
  same CRDT as the text.
- **Accounts and access control.** Sign in, open a page, and you're
  automatically an editor on it, the same mental model as a shared
  document link, with a first-come owner role for administration.
- **Version history with restore**, computed by replaying the same
  append-only edit log used for normal page loads, not a bolted-on
  snapshot feature.
- **Comments and @mentions**, search, link previews, and PDF export.
- **Runs as a real distributed system**: two server replicas behind an
  nginx load balancer, sharing Postgres and Redis, with Prometheus,
  Grafana, and Jaeger wired up for actual observability, not just a
  single process pretending to scale.

## How it's built

The sync engine is a CRDT ([Yjs](https://github.com/yjs/yjs)), not
Operational Transformation. The difference matters: OT needs a central
server to sequence and transform every in-flight edit against every
other one, which is powerful but easy to get subtly wrong. A CRDT gives
every pair of concurrent edits a mathematically guaranteed merge outcome,
computed independently on each client, so the server's job shrinks down to
relaying updates and deciding who's allowed to send them, not arbitrating
what they mean.

```
   Browser A ──ws──┐                          ┌── Postgres (ops log, snapshots,
   Browser B ──ws──┼─▶ Server instance 1  ────┤                users, roles, audit)
                    │                          │
   Browser C ──ws──┐                          ├── Redis (cross-instance fanout,
   Browser D ──ws──┼─▶ Server instance 2  ────┤             rate limits, job queue)
                    │                          │
              nginx (round robin, no sticky sessions)
```

Everything past the WebSocket relay itself, Postgres, Redis, JWT auth,
background jobs, distributed tracing, is wired as an optional
collaborator. The server runs and passes its full test suite with none of
them present, a single in-memory process, and each one activates only
when its env var is set. That constraint made every phase verifiable on
its own, and it means the system degrades in a known way (pages stop
persisting, auth opens up) instead of crashing outright if a dependency
goes missing.

## Tech stack

**Server:** Node.js, TypeScript, `ws`, Yjs, Postgres, Redis, BullMQ,
`rate-limiter-flexible`, `jsonwebtoken`, `pino`, `prom-client`,
OpenTelemetry.
**Client:** React 18, Vite, Yjs, CodeMirror 6, tldraw.
**Infra:** Docker Compose (nginx, Postgres, Redis, Prometheus, Grafana,
Jaeger), GitHub Actions CI, k6 for load testing.

## Real numbers, not estimates

Measured with `k6` against a running instance (single in-memory server,
local machine):

| What | Result |
|---|---|
| HTTP throughput (`/health`, 50 VUs) | ~956 req/s, p95 3.89ms, 0% failures |
| Rate limiter under load (120 req/60s budget, 20 VUs) | exactly 120 succeeded, every request after that rejected in p95 2.47ms |
| WebSocket connect latency (25 concurrent connections) | p95 12.39ms to 36.79ms depending on room sharing, 100% success |

## Run it

```bash
pnpm install
pnpm dev:server        # in-memory only, no Postgres/Redis needed
pnpm dev:client         # http://localhost:5173
```

Open the client URL in two browser tabs with the same `?page=` query
param and edit blocks. Changes sync live, and each tab shows a presence
badge for itself and whoever else is on the page.

With persistence, cross-instance fanout, auth, and background jobs all
turned on:

```bash
docker compose up postgres redis -d
DATABASE_URL=postgres://collab:collab@localhost:5432/collab \
REDIS_URL=redis://localhost:6379 \
JWT_SECRET=dev-only-secret \
pnpm dev:server
```

Or the full distributed stack, two replicas, nginx, Prometheus, Grafana,
Jaeger:

```bash
docker compose up --build -d
# app:        http://localhost:8080
# prometheus: http://localhost:9090
# grafana:    http://localhost:3000
```

### Test

```bash
pnpm test
```

Runs against `pg-mem` and `ioredis-mock`, no live Docker needed, and
includes an end-to-end concurrent-edit convergence test using real
WebSocket connections and the real `y-websocket` client provider, not a
mocked sync protocol.

### Load test

```bash
pnpm --filter @collab/server dev
k6 run loadtest/http-health.js
k6 run loadtest/http-rate-limit.js
PAGE_MODE=many k6 run loadtest/ws-load.js
```

## Project layout

```
packages/shared   block schema + wire message types, used by both server and client
packages/server   WebSocket gateway, persistence, auth/RBAC, jobs, rate limiting, tracing
packages/client   React + Vite editor UI
loadtest/         k6 scripts for HTTP throughput, rate limiting, and WS connect latency
```

## What's next

- Move background workers out of the server process, they currently run
  in-process, fine at this scale but a shared-fate risk under real load.
- A real full-text search index (Postgres `tsvector`/GIN); the current
  implementation uses `ILIKE`, a portability trade-off made early on.
- Sandboxed code execution for the code block, an obvious next feature,
  intentionally scoped out for now because doing it safely means
  container-per-execution isolation with no network access and strict
  resource limits, not a quick `exec` call.

## License

MIT, see [LICENSE](LICENSE).
