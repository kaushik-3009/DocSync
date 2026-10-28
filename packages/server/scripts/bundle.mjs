// Production build: one ESM bundle per entry point. Workspace packages
// (@docsync/shared ships TypeScript source) are inlined; npm dependencies stay
// external and are installed with `pnpm install --prod` in the image.
import { build } from "esbuild";
import { cp, readFile, rm } from "node:fs/promises";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const external = Object.keys(pkg.dependencies).filter((name) => !name.startsWith("@docsync/"));

await rm("dist", { recursive: true, force: true });
await build({
  entryPoints: ["src/index.ts", "src/worker.ts"],
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
  external,
  logLevel: "info",
});
// runMigrations reads SQL files relative to the module.
await cp("src/persistence/migrations", "dist/migrations", { recursive: true });
