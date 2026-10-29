import { spawnSync } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { extractSourceArchive } from "./lib/source-archive.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--out" || !args[1].endsWith(".tar.gz")) {
  throw new Error(
    "Usage: node scripts/export-source-preview.mjs --out /outside/repository/source.tar.gz",
  );
}
const destination = path.resolve(args[1]);
const parent = realpathSync(path.dirname(destination));
const relative = path.relative(realpathSync(root), parent);
if (
  relative === "" ||
  (!relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative))
) {
  throw new Error("Archive must be outside the source repository");
}
function git(args, options = {}) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    ...options,
  });
  if (result.error || result.status !== 0)
    throw new Error(`Git ${args[0]} failed`);
  return result.stdout;
}
if (git(["status", "--porcelain", "--untracked-files=no"]).trim())
  throw new Error("Commit reviewed changes before exporting");
const revision = git(["rev-parse", "HEAD"]).trim();
const sidecar = `${destination}.json`;
// Exclusive creation prevents accidentally replacing an earlier reviewed archive or receipt.
const fd = openSync(destination, "wx", 0o600);
let receiptFd;
let snapshot;
const stages = {};
async function measure(name, action) {
  const start = performance.now();
  try {
    return await action();
  } finally {
    stages[name] = Math.round(performance.now() - start);
    console.log(`Source export ${name}: ${(stages[name] / 1000).toFixed(1)}s`);
  }
}
let extractor;
try {
  receiptFd = openSync(sidecar, "wx", 0o600);
  await measure("archive", () =>
    git(["archive", "--format=tar.gz", "--prefix=shards-code/", revision], {
      stdio: ["ignore", fd, "pipe"],
    }),
  );
  snapshot = mkdtempSync(path.join(tmpdir(), "shards-code-source-export-"));
  extractor = await measure("extract", () =>
    extractSourceArchive(
      destination,
      snapshot,
      process.env.MCODE_SOURCE_EXTRACTOR,
    ),
  );
  const snapshotRoot = path.join(snapshot, "shards-code");
  const check = await measure("inventory", () =>
    spawnSync(
      process.execPath,
      [path.join(snapshotRoot, "scripts/source-inventory.mjs")],
      { cwd: snapshotRoot, stdio: "inherit" },
    ),
  );
  if (check.status !== 0)
    throw new Error("Committed source inventory check failed");
  const sha256 = await measure("hash", () =>
    createHash("sha256").update(readFileSync(destination)).digest("hex"),
  );
  writeFileSync(
    receiptFd,
    `${JSON.stringify({ schemaVersion: 1, revision, sha256, format: "source-only-no-git-history", publicationPerformed: false }, null, 2)}\n`,
  );
  console.log(
    `Exported source-only preview with SHA-256 ${sha256}. No Git history or publication included.`,
  );
} catch (error) {
  closeSync(fd);
  rmSync(destination, { force: true });
  if (receiptFd !== undefined) {
    closeSync(receiptFd);
    rmSync(sidecar, { force: true });
  }
  throw error;
} finally {
  if (snapshot)
    await measure("cleanup", () =>
      rmSync(snapshot, { recursive: true, force: true }),
    );
  if (process.env.MCODE_VERIFY_REPORT_DIR) {
    mkdirSync(process.env.MCODE_VERIFY_REPORT_DIR, { recursive: true });
    writeFileSync(
      path.join(process.env.MCODE_VERIFY_REPORT_DIR, "export.json"),
      `${JSON.stringify({ revision, extractor, stages }, null, 2)}\n`,
    );
  }
}
closeSync(fd);
closeSync(receiptFd);
