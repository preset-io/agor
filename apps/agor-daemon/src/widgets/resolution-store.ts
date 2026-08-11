import type { MessagesRepository } from '@agor/core/db';
import type { Message, MessageID, UserID, WidgetMessageMetadata } from '@agor/core/types';

export interface WidgetResolutionClaimInput {
  token: string;
  action: 'submit' | 'dismiss';
  claimedAt: string;
  claimedBy: UserID;
}

export type WidgetResolutionClaimResult =
  | { outcome: 'claimed'; message: Message }
  | { outcome: 'not_pending'; message: Message };

export type WidgetResolutionFinishResult =
  | { outcome: 'updated'; message: Message }
  | { outcome: 'claim_lost'; message: Message };

type LockedMetadataRepository = Pick<MessagesRepository, 'mutateMetadataLocked'>;

/**
 * Durable widget-resolution state machine.
 *
 * Every method is one short Message-row transaction. Registry handlers and
 * other external work run only after `claim` commits and before `complete` or
 * `fail` starts. An abandoned `resolving` claim is intentionally never
 * reclaimed automatically: the daemon cannot know whether the prior external
 * handler completed before dying, so replay could duplicate secret writes or
 * connector restarts. The persisted claim is the recovery diagnosis. A
 * handler that reports failure releases its claim back to `pending` with a
 * secret-free diagnosis; registry handlers must make a deliberate retry after
 * a reported error safe.
 */
export class WidgetResolutionStore {
  constructor(
    private readonly messages: LockedMetadataRepository,
    private readonly onChanged?: (message: Message) => void
  ) {}

  async claim(
    widgetId: MessageID,
    input: WidgetResolutionClaimInput
  ): Promise<WidgetResolutionClaimResult> {
    const result = await this.messages.mutateMetadataLocked(widgetId, (metadata) => {
      const widget = metadata?.widget;
      if (widget?.status !== 'pending') return null;
      return {
        ...metadata,
        widget: {
          ...widget,
          status: 'resolving',
          resolution_claim: {
            token: input.token,
            action: input.action,
            claimed_at: input.claimedAt,
            claimed_by: input.claimedBy,
          },
          resolution_failure: undefined,
        },
      };
    });
    if (!result.changed) return { outcome: 'not_pending', message: result.message };
    this.publishChanged(result.message);
    return { outcome: 'claimed', message: result.message };
  }

  async complete(
    widgetId: MessageID,
    token: string,
    input: {
      status: 'submitted' | 'dismissed';
      resolvedAt: string;
      submittedBy: UserID;
      resultMeta?: unknown;
    }
  ): Promise<WidgetResolutionFinishResult> {
    return this.finish(widgetId, token, (widget) => ({
      ...widget,
      status: input.status,
      resolved_at: input.resolvedAt,
      submitted_by: input.submittedBy,
      ...(input.resultMeta !== undefined ? { result_meta: input.resultMeta } : {}),
      resolution_claim: undefined,
      resolution_failure: undefined,
    }));
  }

  async fail(
    widgetId: MessageID,
    token: string,
    input: { failedAt: string; errorCode: string }
  ): Promise<WidgetResolutionFinishResult> {
    return this.finish(widgetId, token, (widget) => ({
      ...widget,
      status: 'pending',
      resolution_claim: undefined,
      resolution_failure: {
        failed_at: input.failedAt,
        error_code: input.errorCode,
      },
    }));
  }

  private async finish(
    widgetId: MessageID,
    token: string,
    update: (widget: WidgetMessageMetadata) => WidgetMessageMetadata
  ): Promise<WidgetResolutionFinishResult> {
    const result = await this.messages.mutateMetadataLocked(widgetId, (metadata) => {
      const widget = metadata?.widget;
      if (widget?.status !== 'resolving' || widget.resolution_claim?.token !== token) {
        return null;
      }
      return { ...metadata, widget: update(widget) };
    });
    if (!result.changed) return { outcome: 'claim_lost', message: result.message };
    this.publishChanged(result.message);
    return { outcome: 'updated', message: result.message };
  }

  private publishChanged(message: Message): void {
    try {
      this.onChanged?.(message);
    } catch (error) {
      // Persistence already committed. Realtime delivery is best effort and a
      // later transcript reload observes the durable state.
      console.warn('[widgets] failed to publish durable resolution state:', error);
    }
  }
}
