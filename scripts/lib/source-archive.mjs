import { spawnSync } from "node:child_process";
import path from "node:path";
import { t as list, x as extract } from "tar";

// Validate the entire archive before either extractor writes anything. Native
// tar avoids thousands of Node filesystem operations on Windows runners.
export async function extractSourceArchive(
  file,
  cwd,
  extractor = process.platform === "win32" ? "native" : "node",
) {
  if (!["native", "node"].includes(extractor))
    throw new Error("Unknown source extractor");
  let unsafe = false;
  let entries = 0;
  const seen = new Set();
  await list({
    file,
    strict: true,
    onReadEntry(entry) {
      const name = entry.path.replace(/\/$/u, "");
      const parts = name.split("/");
      const key = process.platform === "win32" ? name.toLowerCase() : name;
      if (
        parts[0] !== "shards-code" ||
        parts.some((p) => !p || p === "." || p === ".." || p === ".git") ||
        /[\\:\x00]/u.test(name) ||
        !["File", "Directory"].includes(entry.type) ||
        seen.has(key)
      )
        unsafe = true;
      seen.add(key);
      entries++;
    },
  });
  if (unsafe || entries === 0)
    throw new Error("Archive contains an unreviewed path or file type");
  if (extractor === "native") {
    // Git Bash prepends its GNU tar to PATH. Unlike Windows' bundled bsdtar,
    // it can interpret a drive-letter archive path as a remote host. Select
    // the Windows executable explicitly so both shells extract identically.
    const nativeTar = process.platform === "win32"
      ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
      : "tar";
    const result = spawnSync(nativeTar, ["-xzf", file, "-C", cwd], {
      encoding: "utf8",
    });
    if (result.error?.code !== "ENOENT") {
      if (result.error || result.status !== 0)
        throw new Error(`Native source extraction failed: ${result.error?.message || result.stderr?.trim() || `exit ${result.status}`}`);
      return "native";
    }
    // Source export remains usable on machines without an external tar binary.
  }
  await extract({ file, cwd, strict: true });
  return "node";
}
