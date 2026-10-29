import test from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, constants, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { t as listTar, x as extractTar } from 'tar';
import { extractMcodeToolsArtifact, MCODE_TOOLS_ARTIFACT } from '../scripts/lib/mcode-tools-artifact.mjs';

test('public archive yields the exact embedded production tool artifact', async () => {
  const archive = readFileSync(new URL('../.cache/artifacts/code-0.3.11.tgz', import.meta.url));
  const extracted = await extractMcodeToolsArtifact(archive);
  const built = readFileSync(new URL('../dist/embedded/mcode-tools/cli.mjs', import.meta.url));
  assert.deepEqual(extracted.cli, built);
  assert.equal(createHash('sha256').update(built).digest('hex'), MCODE_TOOLS_ARTIFACT.sha256);
  assert.equal(JSON.parse(extracted.manifest).auth.mode, 'shared-broker');
});

test('modified public archives fail before any artifact is accepted', async () => {
  const archive = readFileSync(new URL('../.cache/artifacts/code-0.3.11.tgz', import.meta.url));
  archive[archive.length - 1] ^= 1;
  await assert.rejects(extractMcodeToolsArtifact(archive), /integrity mismatch/);
});

test('the built mcode-tools CLI starts independently and exposes its commands', () => {
  const cli = fileURLToPath(new URL('../dist/mcode-tools.js', import.meta.url));
  const result = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /mcode-tools/);
});

test('the built package identifies Shards Code and exposes both CLI names', () => {
  const manifest = JSON.parse(readFileSync(new URL('../dist/package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.name, '@shards-foundation/shards-code');
  assert.deepEqual(manifest.bin, { 'shards-code': 'cli.js', mcode: 'cli.js' });
});

test('the built CLI runs through the executable ACP package launcher', { skip: process.platform === 'win32' }, () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'shards-code-acp-launcher-'));
  const scopeDir = path.join(temporaryRoot, 'node_modules', '@shards-foundation');
  const acpPackageDir = path.join(scopeDir, 'shards-code-acp');
  const acpLauncher = path.join(acpPackageDir, 'acp.js');

  try {
    mkdirSync(acpPackageDir, { recursive: true });
    copyFileSync(path.join(root, 'packages/code-acp/acp.js'), acpLauncher);
    copyFileSync(path.join(root, 'packages/code-acp/package.json'), path.join(acpPackageDir, 'package.json'));
    symlinkSync(path.join(root, 'dist'), path.join(scopeDir, 'shards-code'), 'dir');

    const result = spawnSync(acpLauncher, ['--help'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    assert.match(result.stdout, /Usage: shards-code/u);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('the packed ACP launcher preserves executable mode and runs against the built CLI', { skip: process.platform === 'win32', timeout: 30000 }, async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const acpPackageRoot = path.join(root, 'packages/code-acp');
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'shards-code-acp-pack-'));

  try {
    const packResult = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporaryRoot], {
      cwd: acpPackageRoot,
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(packResult.status, 0, packResult.error?.message ?? packResult.stderr);
    const packInfo = JSON.parse(packResult.stdout);
    assert.equal(packInfo.length, 1, packResult.stdout);
    const tarball = path.join(temporaryRoot, packInfo[0].filename);
    let launcherMode;
    await listTar({
      file: tarball,
      onReadEntry(entry) {
        if (entry.path === 'package/acp.js') launcherMode = entry.mode;
      },
    });
    assert.ok(Number.isInteger(launcherMode), 'ACP tarball must contain package/acp.js');
    assert.ok((launcherMode & 0o100) !== 0, `packed package/acp.js must have owner execute permission (mode ${launcherMode.toString(8)})`);

    const fixtureRoot = path.join(temporaryRoot, 'fixture');
    const packageScope = path.join(fixtureRoot, 'node_modules', '@shards-foundation');
    const acpFixtureDir = path.join(packageScope, 'shards-code-acp');
    mkdirSync(acpFixtureDir, { recursive: true });
    await extractTar({ file: tarball, cwd: acpFixtureDir, strip: 1 });
    symlinkSync(path.join(root, 'dist'), path.join(packageScope, 'shards-code'), 'dir');

    const result = spawnSync(path.join(acpFixtureDir, 'acp.js'), ['--help'], {
      cwd: fixtureRoot,
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    assert.match(result.stdout, /Usage: shards-code/u);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('the built mcode-tools POSIX launcher executes its bundled CLI', { skip: process.platform === 'win32' }, () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const launcher = path.join(root, 'dist/internal-bin/mcode-tools');
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'shards-code-mcode-launcher-'));

  try {
    accessSync(path.join(root, 'packages/tui/src/cli/mcode-tools-launchers/mcode-tools'), constants.X_OK);
    const result = spawnSync(launcher, ['--help'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 15000,
      env: {
        ...process.env,
        __MAVIS_MCODE_TOOLS_RUNTIME_EXECUTABLE: process.execPath,
        __MAVIS_MCODE_TOOLS_BROKER_ENDPOINT: path.join(temporaryRoot, 'broker.sock'),
        __MAVIS_MCODE_TOOLS_BROKER_CAPABILITY_FILE: path.join(temporaryRoot, 'broker.cap'),
        __MAVIS_MCODE_TOOLS_CONFIG_DIR: path.join(temporaryRoot, 'config'),
        __MAVIS_MCODE_TOOLS_REGION: 'en',
      },
    });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    assert.match(result.stdout, /Usage: mcode-tools/u);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('the built DOCX preview skill script runs from its documented executable path', { skip: process.platform === 'win32' }, () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const script = path.join(root, 'dist/assets/skills/docx/scripts/docx_preview.sh');
  const result = spawnSync(script, [], {
    cwd: root,
    encoding: 'utf8',
    timeout: 5000,
  });

  assert.equal(result.status, 1, result.error?.message ?? result.stderr);
  assert.match(result.stdout, /Usage: docx_preview\.sh <file\.docx>/u);
});

test('the built image preview worker processes a synthetic PNG and exits cleanly', { timeout: 15000 }, async (t) => {
  const { Worker } = await import('node:worker_threads');
  const worker = new Worker(new URL('../dist/image-preview-worker.js', import.meta.url), {
    workerData: {
      bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR4nGP4n8LwnxLMMGrAqAGjBgwXAwCOqWIfmQV0zAAAAABJRU5ErkJggg==', 'base64'),
      mimeType: 'image/png',
      maxWidth: 960,
    },
  });
  // Allow normal Worker/WASM teardown after the reply. A message alone does
  // not prove a clean exit; force termination is only timeout/failure cleanup.
  t.after(() => worker.terminate());
  const preview = await new Promise((resolve, reject) => {
    let response;
    worker.once('message', (value) => { response = value; });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`Preview worker exited with code ${code}`));
      else resolve(response);
    });
  });
  assert.equal(typeof preview, 'string');
  assert.deepEqual([...Buffer.from(preview, 'base64').subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});
