# AWS infrastructure

Terraform for running DocSync on AWS. Nothing here runs automatically: CI
only formats, validates and security-scans (checkov) this code. Plans and
applies are operator actions through `scripts/deploy/`.

```text
                 Route 53 (optional)          CloudFront ── S3 (client)
                        │
Internet ── WAF ── ALB :443 (ACM) ─┐   public subnets (2 AZ)
                    :80 → 301      │
───────────────────────────────────┼──────────────────────────────────────
                                   ▼   private subnets (2 AZ, no public IPs)
                     ECS Fargate gateways (autoscaled 2–N)
                     ECS Fargate BullMQ worker
                       │        │         │
                     RDS      ElastiCache  S3 files bucket
                   Postgres   Redis (TLS)  (exports/, uploads/)
                   (TLS)
     VPC endpoints: S3 (gateway), ECR, CloudWatch Logs, Secrets Manager
     Optional NAT gateway: only for third-party APIs (Gemini, Resend)
```

| Module | What it creates |
| --- | --- |
| `network` | VPC, public/private subnets across 2 AZs, VPC endpoints, flow logs, optional NAT |
| `edge` | ALB, HTTPS listener with TLS 1.2/1.3 policy, HTTP→HTTPS redirect, ACM certificate + DNS validation, WAF (AWS managed rules + per-IP rate limit) with logging |
| `data` | RDS Postgres 16 (encrypted, TLS enforced, Performance Insights, enhanced monitoring, optional Multi-AZ) and ElastiCache Redis (TLS + AUTH, optional replica and failover) |
| `storage` | Private files bucket (versioned, TLS-only, expiring exports) and the client site on S3 behind CloudFront with origin access control and security headers |
| `service` | ECS cluster, gateway and worker task definitions (read-only root FS, init process), rolling deploys with circuit-breaker rollback, CPU and request-count autoscaling |
| `monitoring` | SNS alarm topic, alarms (5xx, unhealthy targets, p95 latency, CPU, storage, Redis memory), CloudWatch dashboard |
| `ci_access` | GitHub OIDC provider and a deploy role scoped to ECR push, ECS deploy and the client bucket |

The runtime secret (`DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, optional API
keys) is assembled from the data tier's outputs, so connection strings are
never copied by hand.

## Bootstrap

1. Create an S3 bucket for state (versioning on), then
   `cp backend.hcl.example backend.hcl` and fill it in.
2. `cp terraform.tfvars.example terraform.tfvars` and fill it in (or export
   secrets as `TF_VAR_jwt_secret` etc.).
3. Build and push a first image (`docker build -f packages/server/Dockerfile .`)
   and set `image_uri` to its digest.
4. `scripts/deploy/aws-plan.sh`, review the plan, then
   `ALLOW_AWS_APPLY=I_UNDERSTAND AWS_APPLY_EXPIRY_UTC=... scripts/deploy/aws-apply.sh`.
5. Copy the outputs into the GitHub `staging` environment variables listed in
   `.github/workflows/deploy.yml`; later deploys run from Actions.
6. Tear down with `scripts/deploy/aws-destroy.sh`.

## Cost knobs

The defaults are a small staging profile. The main levers are `db_multi_az`,
`redis_replicas`, `enable_nat_gateway` (about $32/month plus data processing),
`enable_waf`, `gateway_min_count` (0 parks the service), and the four
interface endpoints (about $7/month per endpoint per AZ).

## Accepted scanner findings

`checkov` runs in CI with zero unexplained failures. Each accepted finding
has an inline `#checkov:skip=<id>:<reason>`, most often a customer-managed
KMS key where the AWS-managed key gives the same protection at no cost, or a
CloudFront setting that needs a custom domain.
