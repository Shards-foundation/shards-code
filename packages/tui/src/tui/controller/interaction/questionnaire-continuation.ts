import type { TuiChatController } from '../chat-controller.js';
import {
  buildQuestionnaireReplyAnswers,
  formatQuestionnaireAnswerSummary,
  type ActiveTuiQuestionnaire,
} from '../../interaction/questionnaire.js';
import type { TranscriptStore } from '../../transcript/store.js';
import type { TranscriptCellUpdate } from '../../transcript/model.js';
import type { TuiInteractionPort, TuiRuntimeEvent } from '../../../runtime/port.js';
import { MINIMAX_CODE_DEFAULT_AGENT_NAME } from '../../../product-context.js';
import type { TuiSessionLifecycleEvent } from '../../../types/runtime-events.js';
import { classifyQuestionnaireReplyError } from './questionnaire-reply-outcome.js';

type ContinuationState = {
  requestId: string;
  sessionId: string;
  turnId?: string;
  finished: boolean;
};

export interface QuestionnaireContinuationDependencies {
  runtime: Pick<TuiInteractionPort, 'replyQuestionnaire'>;
  controller: TuiChatController;
  transcript: TranscriptStore;
  requestRender(): void;
  updateChrome(): void;
  hasActiveQuestionnaire(): boolean;
  isStopped?: () => boolean;
}

export class QuestionnaireContinuation {
  private state: ContinuationState | undefined;

  constructor(private readonly dependencies: QuestionnaireContinuationDependencies) {}

  async reply(
    questionnaire: ActiveTuiQuestionnaire,
    skipUnanswered: boolean,
  ): Promise<{ ok: boolean; finished: boolean }> {
    const { controller, runtime } = this.dependencies;
    const sessionId = questionnaire.sessionId ?? controller.snapshot().session?.sessionId;
    this.state = sessionId
      ? { requestId: questionnaire.request.id, sessionId, finished: false }
      : undefined;
    this.updateTranscript(questionnaire.request.id, {
      status: 'pending',
      detail: 'Sending your answer…',
      updatedAtMs: Date.now(),
    });
    this.render();

    let ok: boolean;
    try {
      ok = await runtime.replyQuestionnaire(
        questionnaire.agentName ??
          questionnaire.request.requester?.agentName ??
          MINIMAX_CODE_DEFAULT_AGENT_NAME,
        questionnaire.request.id,
        buildQuestionnaireReplyAnswers(questionnaire, { skipUnanswered }),
      );
    } catch (error) {
      if (!this.isSessionActive(sessionId)) {
        this.clear(questionnaire.request.id);
        return { ok: false, finished: false };
      }
      const outcome = classifyQuestionnaireReplyError(error);
      if (outcome.status === 'terminal') {
        const existing = this.dependencies.transcript.get(`question:${questionnaire.request.id}`);
        this.clear(questionnaire.request.id);
        if (sessionId) await controller.refreshSessionMetadata(sessionId).catch(() => undefined);
        const now = Date.now();
        this.dependencies.transcript.upsert({
          id: `question:${questionnaire.request.id}`,
          kind: 'question',
          status: 'resolved',
          title: existing?.title ?? questionnaire.request.title ?? 'Agent needs input',
          content: existing?.content ?? formatQuestionnaireAnswerSummary(questionnaire),
          detail: outcome.detail,
          ephemeral: true,
          createdAtMs: existing?.createdAtMs ?? now,
          updatedAtMs: now,
        });
        this.render();
        return { ok: true, finished: true };
      }
      this.restoreRetryableQuestion(questionnaire);
      throw error;
    }
    if (!this.isSessionActive(sessionId)) {
      this.clear(questionnaire.request.id);
      return { ok, finished: false };
    }
    if (!ok) {
      this.restoreRetryableQuestion(questionnaire);
      return { ok: false, finished: false };
    }

    const finished = this.finished(questionnaire.request.id);
    if (!finished) {
      this.updateTranscript(questionnaire.request.id, {
        status: 'resolved',
        detail: 'Answer sent · Shards Code is continuing…',
        updatedAtMs: Date.now(),
      });
    }
    return { ok: true, finished };
  }

  clear(requestId?: string): void {
    if (requestId && this.state?.requestId !== requestId) return;
    this.state = undefined;
  }

  isActive(requestId: string): boolean {
    return this.state?.requestId === requestId && !this.state.finished;
  }

  async handleEvent(event: TuiRuntimeEvent, sessionId: string): Promise<boolean> {
    if (this.state?.sessionId !== sessionId || event.sessionId !== sessionId) return false;
    if (event.type === 'session.start') {
      if (!event.turnId) return false;
      if (this.state.turnId && this.state.turnId !== event.turnId) return false;
      this.state.turnId = event.turnId;
      this.dependencies.updateChrome();
      return false;
    }
    if (!isTerminalEvent(event) || !this.state.turnId || event.turnId !== this.state.turnId) {
      return false;
    }

    const requestId = this.state.requestId;
    this.state.finished = true;
    await this.dependencies.controller.refreshSessionMetadata(sessionId).catch(() => undefined);
    if (!this.isSessionActive(sessionId)) return true;
    const receipt = this.dependencies.transcript.get(`question:${requestId}`);
    if (receipt?.ephemeral) {
      this.dependencies.transcript.upsert({
        id: receipt.id,
        detail: undefined,
        updatedAtMs: Date.now(),
      });
    }
    if (!this.dependencies.hasActiveQuestionnaire()) this.clear();
    this.render();
    return true;
  }

  private restoreRetryableQuestion(questionnaire: ActiveTuiQuestionnaire): void {
    this.clear(questionnaire.request.id);
    this.updateTranscript(questionnaire.request.id, {
      status: 'blocked',
      title: questionnaire.request.title || 'Agent needs input',
      detail: 'Answer could not be sent · retry',
      updatedAtMs: Date.now(),
    });
    this.render();
  }

  private finished(requestId: string): boolean {
    return this.state?.requestId === requestId && this.state.finished;
  }

  private updateTranscript(requestId: string, update: Omit<TranscriptCellUpdate, 'id'>): void {
    const id = `question:${requestId}`;
    if (!this.dependencies.transcript.get(id)) return;
    this.dependencies.transcript.upsert({ id, ...update });
  }

  private render(): void {
    this.dependencies.updateChrome();
    this.dependencies.requestRender();
  }

  private isSessionActive(sessionId: string | undefined): boolean {
    return (
      !this.dependencies.isStopped?.() &&
      Boolean(sessionId) &&
      this.dependencies.controller.snapshot().session?.sessionId === sessionId
    );
  }
}

function isTerminalEvent(event: TuiRuntimeEvent): event is TuiSessionLifecycleEvent {
  return (
    event.type === 'session.finish' ||
    event.type === 'session.error' ||
    event.type === 'session.abort'
  );
}
