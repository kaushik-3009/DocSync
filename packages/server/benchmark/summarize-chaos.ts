/** Reconstructs durable chaos outcomes from a host-captured Postgres dump. */
import { readFile, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import * as Y from "yjs";

interface Workload {
  schemaVersion: number;
  status: string;
  pageId: string;
  mutations?: { generated?: string[]; acceptedByHarness?: string[]; records?: Array<{ mutationId: string }> };
  clients?: Array<{ clientId: string; mapKeys: string[]; mapHash: string; reconnects: number; socketErrors: number; duplicateWireFrames: number }>;
  convergence?: { converged: boolean };
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return resolve(value);
}

async function main(): Promise<void> {
  const workloadPath = env("CHAOS_WORKLOAD_OUTPUT");
  const dumpPath = env("CHAOS_DB_DUMP");
  const outputPath = env("CHAOS_SUMMARY_OUTPUT");
  const workload = JSON.parse(await readFile(workloadPath, "utf8")) as Workload;
  const accepted = [...new Set(workload.mutations?.acceptedByHarness ?? workload.mutations?.generated ?? [])].sort();
  const doc = new Y.Doc();
  const fingerprints: string[] = [];
  const rows: Array<{ seq: number; fingerprint: string | null }> = [];
  for (const line of (await readFile(dumpPath, "utf8")).split(/\r?\n/)) {
    if (!line) continue;
    const [seqText, fingerprintText, updateBase64] = line.split("\t");
    if (!seqText || !updateBase64) continue;
    const seq = Number(seqText);
    if (!Number.isInteger(seq)) continue;
    Y.applyUpdate(doc, new Uint8Array(Buffer.from(updateBase64, "base64")));
    const fingerprint = fingerprintText || null;
    rows.push({ seq, fingerprint });
    if (fingerprint) fingerprints.push(fingerprint);
  }
  const durableSet = new Set<string>();
  for (const id of accepted) if (doc.getMap<number>("benchmark-mutations").has(id)) durableSet.add(id);
  const durable = [...durableSet].sort();
  const lost = accepted.filter((id) => !durableSet.has(id));
  const counts = new Map<string, number>();
  for (const fingerprint of fingerprints) counts.set(fingerprint, (counts.get(fingerprint) ?? 0) + 1);
  const duplicateRows = [...counts.values()].filter((count) => count > 1).reduce((sum, count) => sum + count - 1, 0);
  const clientHashes = new Set((workload.clients ?? []).map((client) => client.mapHash));
  const clientWireDuplicates = (workload.clients ?? []).reduce((sum, client) => sum + client.duplicateWireFrames, 0);
  const summary = {
    schemaVersion: 1,
    runId: process.env.CHAOS_RUN_ID ?? null,
    scenario: process.env.CHAOS_SCENARIO ?? null,
    pageId: workload.pageId,
    generatedCount: accepted.length,
    acceptedByHarnessCount: accepted.length,
    durableCount: durable.length,
    lostCount: lost.length,
    acceptedMutationIds: accepted,
    durableMutationIds: durable,
    lostMutationIds: lost,
    duplicateDelivery: {
      durableDuplicateRows: duplicateRows,
      clientDuplicateWireFrames: clientWireDuplicates,
      exactFingerprintRows: rows.length,
    },
    convergence: {
      workloadClientConverged: workload.convergence?.converged ?? false,
      durableDocumentHash: createHash("sha256").update(JSON.stringify([...doc.getMap<number>("benchmark-mutations").entries()].sort(([a], [b]) => a.localeCompare(b)))).digest("hex"),
      clientHashCount: clientHashes.size,
      durableAcceptedSetConverged: lost.length === 0,
    },
    recovery: { measuredBy: "scripts/chaos/persistent-run.sh", readinessOnly: true },
    claimBoundary: "acceptedByHarness is a generated workload intent. durable is membership in the reconstructed Postgres Yjs document; lost is accepted minus durable. Duplicate counts are exact fingerprint row duplicates or repeated raw client wire frames, not semantic duplicate business edits.",
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ output: outputPath, accepted: accepted.length, durable: durable.length, lost: lost.length, duplicateRows })}\n`);
  if (lost.length > 0) process.exitCode = 2;
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
