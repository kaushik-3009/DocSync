#!/usr/bin/env bash
set -euo pipefail

# Collects CloudWatch service metrics around a completed AWS collaborative
# benchmark. It preserves the raw API response; missing datapoints remain
# visible instead of being treated as zero.
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
cd "$repo_root"

run_id="${1:-}"
input_file="$repo_root/artifacts/benchmarks/$run_id/client-results.json"
[[ -f "$input_file" ]] || input_file="$repo_root/artifacts/benchmarks/$run_id/resource-window.json"
if [[ -z "$run_id" || ! -f "$input_file" ]]; then
  echo "usage: $0 <aws-benchmark-run-id>" >&2
  exit 64
fi

region="${AWS_REGION:-us-east-2}"
cluster="${AWS_ECS_CLUSTER:-docsync-staging}"
gateway_service="${AWS_ECS_GATEWAY_SERVICE:-docsync-staging-gateway}"
worker_service="${AWS_ECS_WORKER_SERVICE:-docsync-staging-worker}"
db_instance="${AWS_RDS_INSTANCE:-docsync-staging-postgres}"
redis_cluster="${AWS_REDIS_CLUSTER:-docsync-staging-001}"
redis_node="${AWS_REDIS_NODE:-0001}"
alb_name="${AWS_ALB_NAME:-docsync-staging-alb}"
output_dir="$repo_root/artifacts/benchmarks/$run_id"

alb_dimension="$(aws elbv2 describe-load-balancers --names "$alb_name" --region "$region" --query 'LoadBalancers[0].LoadBalancerArn' --output text | sed 's#^arn:aws:elasticloadbalancing:[^:]*:[^:]*:loadbalancer/##')"
start_time="$(node -e 'const x=require(process.argv[1]); console.log(new Date(Date.parse(x.startedAt)-60000).toISOString())' "$input_file")"
end_time="$(node -e 'const x=require(process.argv[1]); console.log(new Date(Date.parse(x.finishedAt)+120000).toISOString())' "$input_file")"

node - "$output_dir/metric-queries.json" "$cluster" "$gateway_service" "$worker_service" "$db_instance" "$redis_cluster" "$redis_node" "$alb_dimension" <<'NODE'
const fs = require("node:fs");
const [file, cluster, gateway, worker, db, redis, node, alb] = process.argv.slice(2);
const q = (id, namespace, metricName, dimensions, stat = "Average") => ({
  Id: id,
  MetricStat: { Metric: { Namespace: namespace, MetricName: metricName, Dimensions: dimensions.map(([Name, Value]) => ({ Name, Value })) }, Period: 60, Stat: stat },
  ReturnData: true,
});
fs.writeFileSync(file, JSON.stringify([
  q("ecs_gateway_cpu", "AWS/ECS", "CPUUtilization", [["ClusterName", cluster], ["ServiceName", gateway]]),
  q("ecs_gateway_mem", "AWS/ECS", "MemoryUtilization", [["ClusterName", cluster], ["ServiceName", gateway]]),
  q("ecs_worker_cpu", "AWS/ECS", "CPUUtilization", [["ClusterName", cluster], ["ServiceName", worker]]),
  q("ecs_worker_mem", "AWS/ECS", "MemoryUtilization", [["ClusterName", cluster], ["ServiceName", worker]]),
  q("rds_cpu", "AWS/RDS", "CPUUtilization", [["DBInstanceIdentifier", db]]),
  q("rds_connections", "AWS/RDS", "DatabaseConnections", [["DBInstanceIdentifier", db]]),
  q("redis_cpu", "AWS/ElastiCache", "CPUUtilization", [["CacheClusterId", redis], ["CacheNodeId", node]]),
  q("redis_bytes", "AWS/ElastiCache", "BytesUsedForCache", [["CacheClusterId", redis], ["CacheNodeId", node]]),
  q("alb_response_seconds", "AWS/ApplicationELB", "TargetResponseTime", [["LoadBalancer", alb]]),
  q("alb_request_count", "AWS/ApplicationELB", "RequestCount", [["LoadBalancer", alb]], "Sum"),
], null, 2) + "\n");
NODE

aws cloudwatch get-metric-data --region "$region" \
  --start-time "$start_time" --end-time "$end_time" --scan-by TimestampDescending \
  --metric-data-queries "file://$output_dir/metric-queries.json" \
  --output json > "$output_dir/aws-metric-data.json"
aws ecs describe-services --cluster "$cluster" --services "$gateway_service" "$worker_service" --region "$region" \
  --output json > "$output_dir/aws-ecs-services.json"
target_group_arn="$(aws elbv2 describe-target-groups --names "$gateway_service" --region "$region" --query 'TargetGroups[0].TargetGroupArn' --output text)"
aws elbv2 describe-target-health --target-group-arn "$target_group_arn" --region "$region" \
  --output json > "$output_dir/aws-target-health.json"

node - "$output_dir/aws-metric-data.json" "$output_dir/resource-summary.json" "$run_id" "$start_time" "$end_time" <<'NODE'
const fs = require("node:fs");
const [input, output, runId, start, end] = process.argv.slice(2);
const raw = JSON.parse(fs.readFileSync(input, "utf8"));
const series = Object.fromEntries((raw.MetricDataResults ?? []).map((x) => [x.Id, { label: x.Label, timestamps: x.Timestamps ?? [], values: x.Values ?? [], status: x.StatusCode }]));
const summary = {};
for (const [id, value] of Object.entries(series)) {
  const numeric = value.values.filter((x) => Number.isFinite(x));
  summary[id] = { ...value, sampleCount: numeric.length, min: numeric.length ? Math.min(...numeric) : null, max: numeric.length ? Math.max(...numeric) : null, p50: numeric.length ? numeric.slice().sort((a,b)=>a-b)[Math.floor(numeric.length * 0.5)] : null, p95: numeric.length ? numeric.slice().sort((a,b)=>a-b)[Math.min(numeric.length - 1, Math.floor(numeric.length * 0.95))] : null };
}
fs.writeFileSync(output, JSON.stringify({ schemaVersion: 1, runId, region: "us-east-2", start, end, series: summary, limitations: ["CloudWatch period is 60 seconds and service-level for ECS; it is not per-task telemetry.", "Missing series are retained as null and are not converted to zero.", "Cost is calculated separately from the measured resource interval."], rawMetricData: input }, null, 2) + "\n");
NODE

echo "$output_dir/resource-summary.json"
