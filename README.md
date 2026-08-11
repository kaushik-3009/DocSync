<div align="center">

# DocSync

DocSync is a production-minded collaborative workspace for notes, source code,
and visual canvases. It combines the immediacy of a shared editor with the
durability, access control, recovery paths, and operational evidence expected
from a distributed service.

[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)
[![Node.js 24](https://img.shields.io/badge/node.js-24-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=20232A)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite-5-646CFF?logo=vite&logoColor=white)](https://vitejs.dev/)
[![Yjs](https://img.shields.io/badge/CRDT-Yjs-F05A28)](https://docs.yjs.dev/)

</div>

<p align="center">
  <img src="./artifacts/screenshots/docsync-editor.png" alt="DocSync Editor Page" width="800">
</p>

<p align="center">
  <img src="./artifacts/screenshots/browser-split-owner-viewer.png" alt="Owner and viewer sessions open side by side" width="1200">
</p>

---

## Highlights

- **Edit together in real time.** Multiple users work in the same block tree
  with live presence, cursors, comments, mentions, code blocks, and visual
  canvases.
- **Keep every accepted edit durable.** Updates enter an append-only history,
  snapshots accelerate replay, and restore creates a new auditable operation.
- **Share safely.** Documents are private by default with explicit owner,
  editor, and viewer roles, invitation acceptance, online notifications, and
  server-enforced mutation checks.
- **Use AI without surrendering control.** Ask questions about the current
  page or describe a change in natural language. Proposed edits appear as a
  readable diff and require explicit approval before they can alter the page.
- **Run it like a distributed service.** Two gateway replicas share Postgres
  and Redis state without sticky sessions, while workers handle search,
  previews, and PDF export independently.
- **Measure the system that users actually exercise.** The benchmark harness
  sends authenticated binary collaborative edits through the full two-replica
  topology, with convergence, latency, resource, and fault outcomes saved as
  evidence.

## Architecture

The synchronization path is intentionally explicit: clients exchange binary
Yjs updates through a WebSocket gateway, Postgres owns durable history, and
Redis propagates committed updates between gateway replicas. Authorization is
checked at the server mutation boundary before an update can change state,
fan out, or enqueue downstream work.

<p align="center">
  <img src="./artifacts/screenshots/sys-arch.png" alt="System Architecture" width="800">
</p>


The same design runs in two environments. Locally, Nginx sits in front of two gateway containers, Postgres, and Redis, all managed by Docker Compose. On AWS, an Application Load Balancer sits in front of two ECS/Fargate gateway tasks backed by RDS PostgreSQL (Single-AZ) and ElastiCache Redis, with images pulled from ECR, secrets from Secrets Manager, and logs and metrics sent to CloudWatch. Both environments run the identical gateway code and the same Postgres-then-Redis write order.

### Data flow for an edit

~~~mermaid
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
~~~

An accepted edit is authenticated and authorized at the WebSocket boundary, appended to Postgres, applied to the local Yjs document, and only then published through Redis to the other gateway. Durable history is always written before fanout, which keeps replay and recovery consistent.

## Evidence from the system

The AWS profile used two gateways, one worker, one Single-AZ database, and one
Redis node in us-east-2. It was a short-lived deployment used to collect
benchmark and failover evidence, and it has since been destroyed. No AWS
environment is currently running for this repository.

- Two gateway instances share document state without sticky sessions.
- Accepted edits are written to Postgres before local apply, peer broadcast,
  Redis fanout, or downstream jobs; snapshots and replay support recovery.
- Authenticated 25/50/100-client collaboration tests run through the real
  WebSocket path rather than `/health` or handshake-only probes.
- The bounded AWS 100-client run achieved 100/100 convergence with 5.645 s p95
  and 5.979 s p99 propagation latency.
- 113 previously verified server tests cover authentication, RBAC, persistence,
  fanout, recovery, invitations, and convergence; focused assistant tests cover
  typed plans, provider failures, fresh document state, and stale-plan handling.
- Browser-verified two-user flows cover private workspaces, invitation
  acceptance, live presence, viewer write rejection, history, PDF export, and
  reviewable assistant edits.

## Technology

| Area | Technologies |
| --- | --- |
| Frontend | React 18, Vite, CodeMirror 6, tldraw, Yjs, y-codemirror.next |
| Backend | Node.js 24, TypeScript, ws, Yjs, y-protocols, lib0 |
| Data and jobs | PostgreSQL, Redis, ioredis, BullMQ, PDFKit |
| Security | JWT, Node scrypt, origin allowlists, RBAC, parameterized SQL, Redis-backed rate limits |
| Observability | Prometheus, Grafana, OpenTelemetry OTLP HTTP, Jaeger, Pino structured logging |
| Local delivery | Docker Compose, Nginx, dedicated gateway and worker services |
| Cloud delivery | AWS ALB, ECS/Fargate, ECR, RDS PostgreSQL, ElastiCache Redis, Secrets Manager, CloudWatch, IAM |
| Verification | Vitest, pg-mem, ioredis-mock, Node/Yjs benchmark clients, k6, Docker fault injection, GitHub Actions |

## Local development

**Requirements:** Node.js 24 and pnpm.

For the complete local topology (Postgres, Redis, Nginx, two gateways, worker, Prometheus, Grafana, and Jaeger):

~~~bash
cp .env.example .env
docker compose up --build -d
~~~

For a disposable client/server demo without external services:

~~~bash
pnpm install
NODE_ENV=development ALLOW_INSECURE_LOCAL_AUTH_BYPASS=true pnpm dev:server
pnpm dev:client
~~~

Open [http://localhost:5173](http://localhost:5173) in two tabs and use the same `?page=` value to edit one document together. The bypass is only for local development. Normal startup requires configured Postgres, Redis, JWT, and allowed-origin settings.

## Deployment

### Render preview

`render.yaml` defines a low-cost preview with a Node API, static React client, PostgreSQL, and Redis. After creating the Blueprint, set the API's allowed origin to the client URL and the client's WebSocket URL to the API URL. Keep JWT, database, and Redis credentials in Render-managed environment variables.

### AWS staging

The repository includes Terraform for a repeatable, cost-bounded AWS topology
using an ALB, two ECS/Fargate gateways, RDS PostgreSQL, ElastiCache Redis, ECR,
Secrets Manager, CloudWatch, and a BullMQ worker. A short-lived staging
environment was measured in us-east-2 for benchmark and failover evidence, then
deprovisioned; it is not an always-on production service.

The AWS gateway and worker run the same container code as the local stack, so
collaboration, RBAC, history, exports, and the AI edit workflow use the same
implementation. AI-provider and Resend injection is opt-in: set
the AI/email integration flags and populate the matching keys in the runtime
Secrets Manager JSON before starting tasks. The defaults wire only the core
database, Redis, and JWT secrets for a safe bootstrap.

## Validation

~~~bash
pnpm build
pnpm test
~~~

The test suite covers persistence adapters, authentication, permissions, WebSocket behavior, rate limiting, concurrent edits, Redis recovery, invitations, assistant failure handling, and worker accounting. The benchmark clients exercise authenticated binary Yjs updates through the two-gateway topology at 25, 50, and 100 concurrent clients. The local browser evidence includes independent owner and viewer sessions; the generated side-by-side capture is available in `artifacts/screenshots/browser-split-owner-viewer.png`.

## Project layout

~~~text
packages/shared     Shared document schema and WebSocket message types
packages/server      WebSocket gateway, auth/RBAC, persistence, jobs, and telemetry
packages/client      React editor, presence, comments, history, and export controls
loadtest/            k6 HTTP and WebSocket scenarios
infra/aws/           Terraform AWS staging topology
prometheus/          Prometheus scrape and alert rules
scripts/             Benchmark, integration, backup, chaos, and deployment tooling
render.yaml          Render deployment blueprint
docker-compose.yml   Local multi-service development topology
~~~


## License

MIT. See [LICENSE](LICENSE).
</content>
