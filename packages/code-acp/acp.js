#!/usr/bin/env node
// Thin launcher: run Shards Code's single CLI bin with the given args.
// Exists because the package ships multiple bins, so `npx <package> acp` cannot pick one.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const pkgPath = require.resolve('@shards-foundation/shards-code/package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['shards-code'] ?? pkg.bin?.mcode;
if (!bin) {
  console.error('code-acp: Shards Code package has no "shards-code" or legacy "mcode" bin');
  process.exit(1);
}
const entry = resolve(dirname(pkgPath), bin);

const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  windowsHide: true,
});

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    try { child.kill(sig); } catch {}
  });
}

child.on('error', (err) => {
  console.error(`code-acp: failed to start shards-code: ${err.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeAllListeners(s);
    try {
      process.kill(process.pid, signal);
    } catch {}
    // Fallback if self-signal is unsupported (e.g. Windows): 128 + signo.
    process.exit(128 + ((os.constants.signals)[signal] ?? 0));
  }
  process.exit(code ?? 1);
});
