import type { MessagesRepository } from '@agor/core/db';
import type {
  Message,
  MessageID,
  UserID,
  WidgetMessageMetadata,
  WidgetResolutionActionKind,
} from '@agor/core/types';

export interface WidgetResolutionClaimInput {
  token: string;
  action: WidgetResolutionActionKind;
  claimedAt: string;
  claimedBy: UserID;
}

export type WidgetResolutionClaimResult =
  | { outcome: 'claimed'; message: Message; reclaimed?: boolean }
  | { outcome: 'not_pending'; message: Message };

/**
 * Permission to take over an abandoned `resolving` claim, supplied per call by
 * a lane that has declared itself `reclaimable`.
 *
 * Not a store-wide setting and not a default: the store's rule stays "an
 * abandoned claim is a diagnosis, not a lease", and this is the one caller
 * that has said, for one widget type, why replay is safe there.
 */
export interface WidgetClaimReclaimPolicy {
  /** Only a claim taken by this action may be reclaimed. */
  action: WidgetResolutionActionKind;
  /** How long a claim must have been held before it counts as abandoned. */
  afterMs: number;
}

export type WidgetResolutionFinishResult =
  | { outcome: 'updated'; message: Message }
  | { outcome: 'claim_lost'; message: Message };

export type WidgetSupersedeResult =
  | { outcome: 'superseded'; message: Message }
  | { outcome: 'not_pending'; message: Message };

type LockedMetadataRepository = Pick<MessagesRepository, 'mutateMetadataLocked'>;

/**
 * How long a claim has been held, or `0` when either timestamp is unreadable.
 *
 * Unreadable fails toward NOT reclaiming: a claim whose age cannot be computed
 * is one nothing is known about, and the conservative answer is the store's
 * default answer.
 */
function abandonedFor(claimedAt: string | undefined, now: string): number {
  const held = new Date(claimedAt ?? '').getTime();
  const at = new Date(now).getTime();
  if (!Number.isFinite(held) || !Number.isFinite(at)) return 0;
  return Math.max(0, at - held);
}

/**
 * Feathers app key the singleton {@link WidgetResolutionStore} is published
 * under, so an in-process caller that is not a route (the MCP widget tools) can
 * write widget lifecycle state through the same object the routes use rather
 * than reaching for a repository of its own.
 */
export const WIDGET_RESOLUTION_STORE_KEY = 'widgetResolutionStore';

/**
 * Durable widget-resolution state machine.
 *
 * Every method is one short Message-row transaction. Registry handlers and
 * other external work run only after `claim` commits and before `complete` or
 * `fail` starts. An abandoned `resolving` claim is by default never reclaimed:
 * the daemon cannot know whether the prior external handler completed before
 * dying, so replay could duplicate secret writes or connector restarts. The
 * persisted claim is the recovery diagnosis. A handler that reports failure
 * releases its claim back to `pending` with a secret-free diagnosis; registry
 * handlers must make a deliberate retry after a reported error safe.
 *
 * ONE lane opts out, per call and never by default. `claim` accepts a
 * {@link WidgetClaimReclaimPolicy} naming the action and the age at which an
 * abandoned claim may be taken over, and the resolver passes it only for a
 * widget type whose registry entry declared `recovery: 'reclaimable'` — i.e.
 * one whose handler has no external effect to duplicate. The default shape of
 * this method is unchanged, so the submit-backed widgets keep exactly the
 * claim/replay semantics they had.
 */
export class WidgetResolutionStore {
  constructor(
    private readonly messages: LockedMetadataRepository,
    private readonly onChanged?: (message: Message) => void
  ) {}

  async claim(
    widgetId: MessageID,
    input: WidgetResolutionClaimInput,
    reclaim?: WidgetClaimReclaimPolicy
  ): Promise<WidgetResolutionClaimResult> {
    let reclaimed = false;
    const result = await this.messages.mutateMetadataLocked(widgetId, (metadata) => {
      const widget = metadata?.widget;
      const takeOver =
        !!reclaim &&
        widget?.status === 'resolving' &&
        widget.resolution_claim?.action === reclaim.action &&
        abandonedFor(widget.resolution_claim.claimed_at, input.claimedAt) >= reclaim.afterMs;
      if (widget?.status !== 'pending' && !takeOver) return null;
      reclaimed = takeOver;
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
    return { outcome: 'claimed', message: result.message, ...(reclaimed ? { reclaimed } : {}) };
  }

  /**
   * Retire a still-`pending` widget because a newer request replaced it.
   *
   * Not a dismissal by the user, and not a resolution: no claim is taken, no
   * prompt is queued, nothing external happens. The row simply stops offering
   * a button that would drive a flow a newer row now owns.
   *
   * It lives on the store rather than in the caller for the same reason every
   * other transition does. Widget lifecycle state is written HERE and nowhere
   * else — a second writer poking `metadata.widget` through the repository
   * both breaks the invariant that generic Message mutation cannot alter live
   * widget state, and skips `publishChanged`, which is what patches the row
   * into every open browser. Without it a superseded Connect button stays
   * clickable until a reload, and then 403s.
   *
   * Only `pending` is superseded, re-read under the row lock: a `resolving`
   * claim belongs to whoever took it and must never be stolen.
   */
  async supersede(widgetId: MessageID, resolvedAt: string): Promise<WidgetSupersedeResult> {
    const result = await this.messages.mutateMetadataLocked(widgetId, (metadata) => {
      const widget = metadata?.widget;
      if (widget?.status !== 'pending') return null;
      return {
        ...metadata,
        widget: { ...widget, status: 'dismissed', resolved_at: resolvedAt },
      };
    });
    if (!result.changed) return { outcome: 'not_pending', message: result.message };
    this.publishChanged(result.message);
    return { outcome: 'superseded', message: result.message };
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
