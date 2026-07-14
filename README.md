<div align="center">

# DocSync

Real-time documents for text, code, and visual collaboration.

[![CI](https://github.com/kaushik-3009/DocSync/actions/workflows/ci.yml/badge.svg)](https://github.com/kaushik-3009/DocSync/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/node.js-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=20232A)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite-5-646CFF?logo=vite&logoColor=white)](https://vitejs.dev/)
[![Yjs](https://img.shields.io/badge/CRDT-Yjs-F05A28)](https://docs.yjs.dev/)
[![pnpm](https://img.shields.io/badge/package%20manager-pnpm-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)

</div>

Collab Workspace is a collaborative editor for teams that need text, code, and visual thinking in one shared document. It is built on a Yjs CRDT and a replica-safe WebSocket service, so concurrent edits converge without a central “last write wins” shortcut.

The interface is the product; the synchronization, authorization, persistence, and failure handling are the project.

> **Project status:** active engineering project. The local stack and Render Blueprint are included; the benchmark figures below are measured local reference points, not hosted-service guarantees.

## Contents

- [What makes it interesting](#what-makes-it-interesting)
- [Architecture](#architecture)
- [Performance](#performance)
- [Run locally](#run-locally)
- [Deploy on Render](#deploy-on-render)
- [Testing and quality](#testing-and-quality)
- [Repository map](#repository-map)
- [Design decisions](#design-decisions)

## Why this project exists

Real-time collaboration is easy to demonstrate and difficult to make dependable. A useful implementation must remain coherent when edits arrive concurrently, a browser sleeps, a connection drops, a server restarts, or traffic moves between replicas. This project uses those failure modes as first-class design constraints rather than treating the WebSocket as a thin transport layer.

## What makes it interesting

- Shared block documents with live presence and remote cursors
- Collaborative CodeMirror 6 code blocks and tldraw canvas blocks
- JWT authentication and server-side owner/editor/viewer permissions
- Append-only operations, snapshots, version history, and restore
- Comments, @mentions, search, link previews, and PDF export jobs
- Rate limiting, structured logs, metrics, and OpenTelemetry tracing
- Graceful degradation when optional infrastructure is unavailable

The important behavior is not just “two browsers can type at once.” A disconnected client can reconnect and catch up from a version vector; a page can move between server replicas without sticky sessions; and a raw client update still passes through server-side authorization and validation.

## Architecture

```mermaid
flowchart LR
  U[Browser clients\nReact + Vite] -->|HTTPS / WSS| E[Edge / Render]
  E --> API[Node.js TypeScript API\nWebSocket gateway]
  API --> Y[Yjs documents\nroom registry]
  API --> DB[(Postgres\noperations, snapshots, roles)]
  API <--> R[(Redis\nfanout, rate limits, BullMQ)]
  API --> W[Background workers\nsearch, previews, PDF export]
  API --> O[OpenTelemetry\nmetrics + traces]
```

The synchronization path is deliberately small: clients exchange Yjs updates through the gateway; Postgres provides durable history; Redis propagates updates between replicas. Authorization is evaluated on the server before mutations are accepted.

### Data flow for an edit

```mermaid
sequenceDiagram
  participant A as Browser A
  participant G as WebSocket gateway
  participant P as Postgres
  participant R as Redis
  participant B as Browser B
  A->>G: Yjs update + awareness
  G->>G: authenticate, authorize, validate
  G->>P: append operation / snapshot
  G->>R: publish page update
  R-->>G: fan out to other replicas
  G-->>B: apply Yjs update
```

## Technology

| Layer | Choice |
| --- | --- |
| Client | React 18, Vite, CodeMirror 6, tldraw, Yjs |
| Server | Node.js, TypeScript, `ws`, Yjs, pino |
| Persistence | PostgreSQL, append-only operations and snapshots |
| Coordination | Redis, BullMQ, `rate-limiter-flexible` |
| Observability | Prometheus, Grafana, OpenTelemetry, Jaeger |
| Delivery | Render Blueprint or Docker Compose for local infrastructure |
| Verification | Vitest, pg-mem, ioredis-mock, k6 |

## Performance

Measured locally with k6 against the in-memory server. These are reference measurements, not a production SLA.

| Scenario | Result |
| --- | ---: |
| `/health`, 50 virtual users | ~956 requests/s; p95 3.89 ms; 0% failures |
| Rate-limit budget, 20 virtual users | 120 accepted, subsequent requests rejected; p95 2.47 ms |
| WebSocket connection test, 25 clients | 100% success; p95 12–37 ms depending on room sharing |

## Run locally

Requirements: Node.js 20+ and pnpm.

```bash
pnpm install
pnpm dev:server   # in-memory mode on :1234
pnpm dev:client   # http://localhost:5173
```

Open the client in two browser tabs with the same `?page=` value and edit the same document. This path intentionally has no external dependencies.

For Postgres, Redis, nginx, and observability:

```bash
cp .env.example .env
docker compose up --build -d
```

## Deploy on Render

The repository includes [`render.yaml`](render.yaml), which provisions a Node web service, a static React site, PostgreSQL, and Redis. No local Docker installation is required.

1. Push the repository to GitHub.
2. In Render, choose **New → Blueprint** and select the repository.
3. Review the services and create the blueprint.
4. After Render creates the services, open `collab-workspace-api` and set `ALLOWED_ORIGINS` to the final frontend URL, for example `https://collab-workspace-client.onrender.com`.
5. Open `collab-workspace-client` and set `VITE_WS_URL` to the API WebSocket URL, for example `wss://collab-workspace-api.onrender.com/ws`.
6. Trigger a new frontend deploy after setting `VITE_WS_URL`; Vite embeds this value at build time.

For a custom domain, attach `app.example.com` to the static site and `api.example.com` to the API service, then use:

```text
ALLOWED_ORIGINS=https://app.example.com
VITE_WS_URL=wss://api.example.com/ws
```

Keep `JWT_SECRET`, database credentials, and Redis credentials in Render-managed environment variables. Never commit `.env` or production secrets.

## Testing and quality

```bash
pnpm build
pnpm test
```

The suite covers persistence adapters, authentication, permissions, WebSocket behavior, rate limiting, and concurrent-edit convergence. The end-to-end sync tests use real WebSocket connections and the same `y-websocket` protocol used by the client. Load scripts live in [`loadtest/`](loadtest/).

## Repository map

```text
packages/shared   Shared document schema and wire types
packages/server   WebSocket gateway, auth/RBAC, persistence, jobs, telemetry
packages/client   React editor, presence UI, comments, history, export controls
loadtest/         k6 HTTP and WebSocket scenarios
docs/             Design notes and operational documentation
render.yaml       Render deployment blueprint
docker-compose.yml Local multi-service infrastructure
```

## Design decisions

- Yjs CRDTs provide deterministic convergence for concurrent edits without a central operation-transform loop.
- Postgres is the durability boundary; Redis is coordination and fanout, not the source of truth.
- Optional integrations are feature-gated so the core editor remains testable in memory.
- RBAC and input validation live on the server because a client-generated update is untrusted input.
- The deployment model is intentionally replica-safe: no sticky sessions are required for document synchronization.

## Security and operability

- JWT authentication is enforced by the server, with owner/editor/viewer roles checked before page mutations.
- WebSocket upgrades support origin validation, bounded payloads, and binary protocol validation.
- HTTP and WebSocket traffic are rate-limited; Redis makes the limiter shareable across replicas.
- Secrets are environment-managed and excluded from Git; `.env.example` contains placeholders only.
- Prometheus metrics, structured logs, and OpenTelemetry spans make room, persistence, and job behavior inspectable.

## Known boundaries

This is intentionally not marketed as a finished SaaS. Background jobs still share the server deployment, search currently favors a portable `ILIKE` implementation over a dedicated index, and the project needs browser-level soak testing before a high-volume production launch. Calling those boundaries out is part of the design documentation, not an omission.

## Roadmap

- Move background workers into independently scaled services.
- Replace `ILIKE` search with a dedicated Postgres full-text index.
- Add sandboxed, resource-limited code execution for code blocks.
- Add a production browser test matrix and long-running soak tests.

## Contributing

```bash
cp .env.example .env
pnpm install
pnpm build
pnpm test
```

Open an issue for design discussion or a pull request with tests for behavior changes.

## License

MIT. See [`LICENSE`](LICENSE).
