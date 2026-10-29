import { createInterface } from 'node:readline/promises';
import { stripVTControlCharacters } from 'node:util';
import { McodeUpdateApplication, type McodeUpdatePlan } from '../update/application.js';
import {
  mcodePrefixActivationScheduledMessage,
  mcodePrefixJournalScheduleFailedMessage,
} from '../update/messages.js';
import { schedulePendingMcodePrefixUpdate } from '../update/prefix-update.js';
import type { McodeUpdatePhase } from '../update/progress.js';

const UPDATE_ANIMATION_INTERVAL_MS = 80;
const UPDATE_ACTIVITY_INTERVAL_MS = 15_000;
const UPDATE_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const UPDATE_OUTPUT_MAX_LENGTH = 72;

export interface RunMcodeUpdateOptions {
  readonly application?: McodeUpdateApplication;
  readonly interactive?: boolean;
  readonly confirm?: (message: string) => Promise<boolean>;
  readonly write?: (value: string) => void;
  readonly schedulePendingPrefixUpdate?: () => Promise<boolean>;
}

export async function runMcodeUpdate(
  currentVersion: string,
  options: RunMcodeUpdateOptions = {},
): Promise<void> {
  const application = options.application ?? new McodeUpdateApplication({ currentVersion });
  const interactive = options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const write = options.write ?? ((value: string) => process.stdout.write(value));
  const schedulePendingPrefixUpdate =
    options.schedulePendingPrefixUpdate ?? (() => schedulePendingMcodePrefixUpdate());
  if (await schedulePendingPrefixUpdate()) {
    write(`${mcodePrefixActivationScheduledMessage()}\n`);
    return;
  }
  const plan = await application.inspect();

  if (plan.kind === 'current') {
    write(
      plan.source === 'managed-installer'
        ? `Shards Code ${plan.currentVersion} is current on ${plan.channel}.\n`
        : `Shards Code ${plan.currentVersion} is current on @${plan.packageTag}.\n`,
    );
    return;
  }
  if (plan.kind === 'ahead') {
    write(
      `Shards Code ${plan.currentVersion} is newer than ${
        plan.source === 'managed-installer' ? plan.channel : `@${plan.packageTag}`
      } ${plan.latestVersion}; no update was applied.\n`,
    );
    return;
  }
  if (plan.kind === 'manual') {
    if (plan.source === 'managed-installer') {
      write(`${plan.message}\n`);
      return;
    }
    write(
      'Shards Code could not identify the owner of this installation. ' +
        `Update manually with:\n  ${plan.command}\n`,
    );
    return;
  }

  write(renderAvailableUpdate(plan));
  if (!interactive) {
    write(`${renderNonInteractiveInstruction(plan)}\n`);
    return;
  }

  const confirm = options.confirm ?? confirmInTerminal;
  if (!(await confirm('Install the update now? [y/N] '))) {
    write('Update cancelled.\n');
    return;
  }

  const progress = new McodeUpdateCliProgress(write, updateProcessLabel(plan));
  progress.start();
  try {
    const outcome = await application.apply(plan, {
      onOutput: (chunk) => progress.acceptOutput(chunk),
      onPhase: (event) => progress.acceptPhase(event.phase),
    });
    progress.stop();
    write(`${outcome.message}\n`);
    if (outcome.restartRequired && !(await schedulePendingPrefixUpdate())) {
      throw new Error(mcodePrefixJournalScheduleFailedMessage());
    }
  } catch (error) {
    progress.stop();
    throw error;
  }
}

class McodeUpdateCliProgress {
  private frameIndex = 0;
  private latestOutput = '';
  private latestOutputAtMs: number | undefined;
  private phase: McodeUpdatePhase | undefined;
  private startedAtMs = 0;
  private animationTimer: ReturnType<typeof setInterval> | undefined;
  private activityTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly write: (value: string) => void,
    private readonly processLabel: string,
  ) {}

  start(): void {
    if (this.animationTimer) return;
    this.startedAtMs = Date.now();
    this.render();
    this.animationTimer = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % UPDATE_SPINNER_FRAMES.length;
      this.render();
    }, UPDATE_ANIMATION_INTERVAL_MS);
    this.animationTimer.unref?.();
    this.activityTimer = setInterval(() => this.reportActivity(), UPDATE_ACTIVITY_INTERVAL_MS);
    this.activityTimer.unref?.();
  }

  acceptPhase(phase: McodeUpdatePhase): void {
    this.phase = phase;
    if (phase === 'completed') {
      this.render();
      return;
    }
    const suffix = phase === 'installing' ? ' (this can take a few minutes)' : '';
    this.writePersistent(`${phaseLabel(phase)}${suffix}...`);
  }

  acceptOutput(chunk: string): void {
    const latest = stripVTControlCharacters(chunk)
      .split(/[\r\n]+/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);
    if (!latest) return;
    this.latestOutput = truncateOutput(latest);
    this.latestOutputAtMs = Date.now();
    this.render();
  }

  stop(): void {
    if (this.animationTimer) clearInterval(this.animationTimer);
    if (this.activityTimer) clearInterval(this.activityTimer);
    this.animationTimer = undefined;
    this.activityTimer = undefined;
    this.write('\r\u001B[2K');
  }

  private reportActivity(): void {
    if (this.phase === 'completed') return;
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - this.startedAtMs) / 1000));
    const outputActivity = this.latestOutputAtMs
      ? `; last output ${Math.max(0, Math.floor((Date.now() - this.latestOutputAtMs) / 1000))}s ago`
      : '; waiting for output';
    const phase = this.phase ? phaseLabel(this.phase) : 'Updating Shards Code';
    this.writePersistent(
      `${this.processLabel} is still running (${elapsedSeconds}s elapsed${outputActivity}) · ${phase}.`,
    );
  }

  private writePersistent(message: string): void {
    this.write(`\r\u001B[2K${message}\n`);
    this.render();
  }

  private render(): void {
    const frame = UPDATE_SPINNER_FRAMES[this.frameIndex] ?? UPDATE_SPINNER_FRAMES[0];
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - this.startedAtMs) / 1000));
    const elapsed = elapsedSeconds > 0 ? ` · ${elapsedSeconds}s` : '';
    const phase = this.phase ? ` · ${phaseLabel(this.phase)}` : '';
    const output = this.latestOutput ? ` · ${this.latestOutput}` : '';
    this.write(`\r\u001B[2K${frame} Updating Shards Code${phase}${elapsed}${output}`);
  }
}

function phaseLabel(phase: McodeUpdatePhase): string {
  if (phase === 'checking') return 'Checking for updates';
  if (phase === 'downloading') return 'Downloading release';
  if (phase === 'staging') return 'Preparing isolated update';
  if (phase === 'installing') return 'Installing package';
  if (phase === 'validating') return 'Validating installed version';
  if (phase === 'activating') return 'Activating new version';
  return 'Completing update';
}

function updateProcessLabel(
  plan: Extract<McodeUpdatePlan, { kind: 'available' | 'package-manager' }>,
): string {
  if (plan.kind === 'available') return 'installer';
  if (plan.source === 'npm-prefix') return 'npm';
  return plan.source.replace('-global', '');
}

function truncateOutput(value: string): string {
  if (value.length <= UPDATE_OUTPUT_MAX_LENGTH) return value;
  return `${value.slice(0, UPDATE_OUTPUT_MAX_LENGTH - 1)}…`;
}

function renderAvailableUpdate(
  plan: Extract<McodeUpdatePlan, { kind: 'available' | 'package-manager' }>,
): string {
  if (plan.kind === 'available') {
    return (
      `Shards Code ${plan.latestVersion} is available on ${plan.channel} ` +
      `(current ${plan.currentVersion}).\n`
    );
  }
  return (
    `Shards Code ${plan.latestVersion} is available on @${plan.packageTag} ` +
    `(current ${plan.currentVersion}, installed through ${plan.source.replace('-global', '')}).\n` +
    `Command: ${plan.command.display}\n`
  );
}

function renderNonInteractiveInstruction(
  plan: Extract<McodeUpdatePlan, { kind: 'available' | 'package-manager' }>,
): string {
  return plan.kind === 'package-manager'
    ? `No interactive confirmation is available. Run: ${plan.command.display}`
    : 'No interactive confirmation is available. Run `mcode update` from a terminal to install it.';
}

async function confirmInTerminal(message: string): Promise<boolean> {
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  try {
    const answer = (await prompt.question(message)).trim().toLocaleLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    prompt.close();
  }
}
