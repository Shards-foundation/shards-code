import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const productionRoots = [
  'packages/config/src',
  'packages/local-runtime/src',
  'packages/local-runtime-v2/src',
  'packages/protocol/src',
  'packages/shared/src',
  'packages/tui/src',
];
const forbidden = [
  ['business-event upload endpoint', /meerkat-reporter\/api\/report\?project=MiniMaxAgent/iu],
  ['runtime metrics upload endpoint', /matrix\/api\/v1\/metrics\/batch/iu],
  ['automatic diagnostic upload endpoint', /minimax-cloud\/api\/v1\/observability\/desktop-errors\/batch/iu],
  ['eval-capture implementation or config', /\b(?:IEvalCaptureConfig|LocalEvalReporter|evalCapture|eval_capture)\b|eval-capture/iu],
  ['eval-capture upload route', /eval\/(?:steps|snapshot)\/report/iu],
];

function filesUnder(directory, extensions) {
  const result = [];
  for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...filesUnder(relative, extensions));
    else if (
      extensions.has(path.extname(entry.name)) &&
      !/\.(?:test|spec)\.[^.]+$/u.test(entry.name)
    ) result.push(relative);
  }
  return result;
}

function violationsIn(files) {
  const violations = [];
  for (const file of files) {
    const text = readFileSync(path.join(root, file), 'utf8');
    for (const [label, pattern] of forbidden) {
      if (pattern.test(text)) violations.push(`${label}: ${file}`);
    }
  }
  return violations;
}

function isTuiSourceFile(file) {
  return file.replaceAll('\\', '/').startsWith('packages/tui/src/');
}

test('privacy source selection recognizes Windows path separators', () => {
  const windowsPath = path.win32.join(
    'packages',
    'tui',
    'src',
    'runtime',
    'feedback',
    'ticket.ts',
  );
  const selected = [windowsPath].filter(isTuiSourceFile);
  assert.deepEqual(selected, [windowsPath]);
});

test('production source contains no automatic MiniMax telemetry or eval-capture channel', () => {
  const files = productionRoots.flatMap((directory) => filesUnder(directory, new Set(['.ts', '.js', '.mjs'])));
  assert.deepEqual(violationsIn(files), []);
  const tuiSource = files
    .filter(isTuiSourceFile)
    .map((file) => readFileSync(path.join(root, file), 'utf8'))
    .join('\n');
  assert.match(tuiSource, /feedback\/ticket/iu, 'the user-initiated feedback path must remain');
});

test('built distribution contains no automatic MiniMax telemetry or eval-capture channel', () => {
  const files = filesUnder('dist', new Set(['.js', '.mjs']));
  assert.ok(files.length > 0, 'build the distribution before running this packaging check');
  assert.deepEqual(violationsIn(files), []);
  const bundles = files.map((file) => readFileSync(path.join(root, file), 'utf8')).join('\n');
  assert.match(bundles, /feedback\/ticket/iu, 'the user-initiated feedback path must remain packaged');
});
