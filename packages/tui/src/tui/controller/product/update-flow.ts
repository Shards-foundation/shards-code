import type {
  McodeUpdateApplyOptions,
  McodeUpdateOutcome,
  McodeUpdatePlan,
} from '../../../update/application.js';
import { disposeComponents, type Component } from '../../rendering/component.js';
import { TuiUpdatePanel } from '../../features/update/panel.js';
import type { TuiInteractionSurface } from '../../shell/interaction-surface.js';
import { McodeUpdateAdmissionError } from '../../../update/progress.js';
import { formatTuiActionFailure } from '../../../user-facing-failure.js';

type AppendUpdateNotice = (content: string, kind?: 'warning' | 'error') => void;

export interface TuiUpdateOptions {
  readonly version: string;
  readonly checkForUpdate?: () => Promise<{ latestVersion: string } | undefined>;
  readonly inspectUpdate?: () => Promise<McodeUpdatePlan>;
  readonly applyUpdate?: (
    plan: McodeUpdatePlan,
    options?: McodeUpdateApplyOptions,
  ) => Promise<McodeUpdateOutcome>;
}

export interface TuiUpdateFlowOptions {
  readonly inspect: () => Promise<McodeUpdatePlan>;
  readonly apply: (
    plan: McodeUpdatePlan,
    options?: McodeUpdateApplyOptions,
  ) => Promise<McodeUpdateOutcome>;
  readonly append: AppendUpdateNotice;
  readonly showPanel: (panel: Component) => void;
  readonly closePanel: (panel?: Component) => boolean;
  readonly requestRender: () => void;
  readonly maxRows: () => number;
  readonly restart: () => Promise<void>;
  readonly admit?: () => Promise<{ allowed: boolean; reason?: string }>;
}

export function createTuiUpdateFlow(
  options: TuiUpdateOptions,
  append: AppendUpdateNotice,
  surface: TuiInteractionSurface,
  requestRender: () => void,
  maxRows: () => number,
  restart: () => Promise<void>,
  admit?: () => Promise<{ allowed: boolean; reason?: string }>,
): TuiUpdateFlow {
  return new TuiUpdateFlow({
    inspect:
      options.inspectUpdate ??
      (async () => ({
        kind: 'manual',
        source: 'unsupported',
        currentVersion: options.version,
        command: 'mcode update',
      })),
    apply:
      options.applyUpdate ??
      (async () => {
        throw new Error('In-process update is unavailable in this TUI build.');
      }),
    append,
    showPanel: (panel) => surface.show(panel),
    closePanel: (panel) => surface.close(panel),
    requestRender,
    maxRows,
    restart,
    ...(admit ? { admit } : {}),
  });
}

export class TuiUpdateFlow {
  private panel: Component | undefined;
  private requestSequence = 0;
  private stopped = false;
  private updateTask: Promise<void> | undefined;

  constructor(private readonly options: TuiUpdateFlowOptions) {}

  async show(): Promise<void> {
    if (this.stopped) return;
    if (this.updateTask) {
      this.options.append(
        'An Shards Code update is already running. Please wait for it to finish.',
        'warning',
      );
      return;
    }
    const requestSequence = ++this.requestSequence;
    let plan: McodeUpdatePlan;
    try {
      plan = await this.options.inspect();
    } catch (error) {
      if (this.stopped || requestSequence !== this.requestSequence) return;
      this.options.append(
        formatTuiActionFailure(error, {
          summary: "Couldn't check for updates.",
          nextStep: 'Retry /update.',
        }),
        'error',
      );
      return;
    }
    if (this.stopped || requestSequence !== this.requestSequence) return;

    if (plan.kind === 'current') {
      this.options.append(
        plan.source === 'managed-installer'
          ? `Shards Code ${plan.currentVersion} is current on ${plan.channel}.`
          : `Shards Code ${plan.currentVersion} is current on @${plan.packageTag}.`,
      );
      return;
    }
    if (plan.kind === 'ahead') {
      this.options.append(
        `Shards Code ${plan.currentVersion} is newer than ${
          plan.source === 'managed-installer' ? plan.channel : `@${plan.packageTag}`
        } ${plan.latestVersion}.`,
      );
      return;
    }
    if (plan.kind === 'manual') {
      this.options.append(
        plan.source === 'managed-installer'
          ? plan.message
          : `Automatic update is unavailable for this installation. Update manually with: ${plan.command}`,
        'warning',
      );
      return;
    }

    const panel = new TuiUpdatePanel({
      plan,
      maxRows: this.options.maxRows,
      apply: async (actionablePlan, progress) => {
        await this.requireAdmission();
        return this.options.apply(actionablePlan, progress);
      },
      requestRender: this.options.requestRender,
      onClose: () => this.close(panel),
      onRestart: async () => {
        await this.requireAdmission();
        await this.options.restart();
      },
      onApplyConfirmed: () => this.startBackgroundUpdate(plan, panel),
    });
    if (this.panel) {
      this.options.closePanel(this.panel);
      disposeComponents(this.panel);
    }
    this.panel = panel;
    this.options.showPanel(panel);
  }

  private startBackgroundUpdate(
    plan: Extract<McodeUpdatePlan, { kind: 'available' | 'package-manager' }>,
    panel: Component,
  ): void {
    if (this.updateTask) {
      this.options.append(
        'An Shards Code update is already running. Please wait for it to finish.',
        'warning',
      );
      return;
    }
    this.close(panel);
    this.options.append(
      `Shards Code update started in the background (${plan.currentVersion} → ${plan.latestVersion}).`,
    );
    const task = this.requireAdmission()
      .then(() =>
        this.options.apply(plan, {
          onOutput: (chunk) => {
            const lines = chunk
              .split(/[\r\n]+/u)
              .map((line) => line.trim())
              .filter(Boolean);
            if (lines.length > 0 && !this.stopped) {
              this.options.append(`Update: ${lines.at(-1)}`);
            }
          },
        }),
      )
      .then(
        (outcome) => {
          if (!this.stopped) {
            this.options.append(`Shards Code update completed: ${outcome.message}`);
            if (outcome.restartRequired) {
              void this.options.restart();
            }
          }
        },
        (error: unknown) => {
          if (!this.stopped) {
            this.options.append(
              `Shards Code update failed: ${error instanceof Error ? error.message : String(error)}`,
              'error',
            );
          }
        },
      )
      .finally(() => {
        this.updateTask = undefined;
      });
    this.updateTask = task;
  }

  stop(): void {
    this.stopped = true;
    this.requestSequence += 1;
    if (this.panel) {
      this.options.closePanel(this.panel);
      disposeComponents(this.panel);
    }
    this.panel = undefined;
  }

  private close(panel: Component): void {
    if (!this.options.closePanel(panel)) return;
    disposeComponents(panel);
    if (this.panel === panel) this.panel = undefined;
  }

  private async requireAdmission(): Promise<void> {
    const admission = await this.options.admit?.();
    if (admission && !admission.allowed) {
      throw new McodeUpdateAdmissionError(
        admission.reason ?? 'Finish active Shards Code work before updating.',
      );
    }
  }
}
