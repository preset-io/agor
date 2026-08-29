/**
 * Widget submission / dismissal route handlers.
 *
 * Two custom REST routes:
 *   POST /widgets/:widget_id/submit
 *   POST /widgets/:widget_id/dismiss
 *
 * Both follow the same resolution path:
 *   1. Load the widget message row by `widget_id` (message_id == widget_id).
 *   2. Authorize through the canonical session prompt authority resolver.
 *   3. Idempotency: status MUST be 'pending'.
 *   4. Durably claim `pending -> resolving` with an opaque token.
 *   5. The sole claimant dispatches to the registry (`applySubmit` for
 *      submit; no external side-effect for dismiss).
 *   6. Queue a system-authored auto-resume task via the existing
 *      `/sessions/:id/prompt` route (the "Never lose a prompt" #1068 path),
 *      unless `auto_resume === false`.
 *   7. Token-check `resolving -> submitted|dismissed` with result metadata.
 *   8. Broadcast `widget:resolved` on the per-session Feathers room.
 *
 * Critical security invariant: the `applySubmit` handler is the ONLY place
 * the raw submit body reaches; from `result_meta` onward, no
 * caller-supplied values flow back into the agent context. See §5.1 of the
 * design doc for the path-by-path enumeration.
 */

import { generateId } from '@agor/core/db';
import { Conflict, Forbidden, NotAuthenticated, NotFound } from '@agor/core/feathers';
import type {
  Branch,
  Message,
  MessageID,
  Session,
  SessionID,
  SessionPromptAuthority,
  UserID,
  WidgetMessageMetadata,
} from '@agor/core/types';
import { sessionPromptDeniedMessage } from '../utils/branch-authorization.js';
import { widgetAutoResumeTaskId } from '../utils/durable-task-id.js';
import { structuredLogErrorCode } from '../utils/structured-log.js';
import { getWidget, type WidgetSubmitCtx } from './registry.js';
import type { WidgetResolutionStore } from './resolution-store.js';

/**
 * Minimal Feathers-like surface the resolver needs. Typed against a subset
 * so the resolver is trivially mockable in unit tests.
 */
export interface WidgetResolverApp {
  service(name: string): {
    get(id: string, params?: unknown): Promise<unknown>;
    patch(id: string, data: unknown, params?: unknown): Promise<unknown>;
    create(data: unknown, params?: unknown): Promise<unknown>;
    emit?(event: string, payload: unknown): void;
  };
}

export interface WidgetResolverDeps {
  app: WidgetResolverApp;
  /** Required short database unit for the initial, consistent authorization snapshot. */
  runInTenantDatabaseScope<T>(work: () => Promise<T>): Promise<T>;
  /** Durable, short-transaction state machine shared by every daemon. */
  resolutionStore: WidgetResolutionStore;
  /** Tenant-scoped custom-event publisher; production must not emit globally. */
  publishResolved?(payload: Record<string, unknown>): void;
  /** Canonical branch capability + shared-session authorization. */
  resolveSessionPromptAuthority(
    branchId: string,
    callerUserId: UserID,
    sessionOwnerUserId: UserID,
    sessionSdkHomeScope: Session['sdk_home_scope']
  ): Promise<SessionPromptAuthority>;
}

export interface AuthenticatedCaller {
  user_id: UserID;
  role?: string;
}

export type WidgetResolutionAction =
  | { kind: 'submit'; body: Record<string, unknown> }
  | { kind: 'dismiss' };

export interface WidgetResolutionResult {
  widget_id: MessageID;
  status: 'submitted' | 'dismissed';
  auto_resume_queued: boolean;
}

/**
 * Widget resolution queues a prompt, so it uses exactly the same authority
 * decision as every other prompt path. Branch management alone is never
 * enough to act through another user's home.
 */
export function canResolveWidget(authority: Pick<SessionPromptAuthority, 'allowed'>): boolean {
  return authority.allowed;
}

/**
 * Per-widget in-process coalescing. Correctness comes from the durable
 * `WidgetResolutionStore` claim; this map only avoids needless same-process
 * contention and duplicate auth/config reads.
 */
const inFlightResolutions = new Map<string, Promise<WidgetResolutionResult>>();

/**
 * Resolve a widget (submit or dismiss). Pure-ish: side effects all go
 * through `deps.app` so tests can supply a mock surface. Throws Feathers
 * standard errors (NotFound, Forbidden, NotAuthenticated) that the caller
 * wraps into HTTP responses.
 */
export async function resolveWidget(
  widgetId: string,
  action: WidgetResolutionAction,
  caller: AuthenticatedCaller | undefined,
  deps: WidgetResolverDeps
): Promise<WidgetResolutionResult> {
  if (!caller) {
    throw new NotAuthenticated('Authentication required to resolve a widget');
  }

  // Coalesce same-process resolutions. Another daemon can still race here;
  // the durable pending → resolving claim below elects the sole side-effect
  // owner across the fleet.
  const existing = inFlightResolutions.get(widgetId);
  if (existing) {
    await existing.catch(() => {}); // swallow — we re-check status below
  }
  const promise = (async () => doResolveWidget(widgetId, action, caller, deps))();
  inFlightResolutions.set(widgetId, promise);
  try {
    return await promise;
  } finally {
    if (inFlightResolutions.get(widgetId) === promise) {
      inFlightResolutions.delete(widgetId);
    }
  }
}

async function doResolveWidget(
  widgetId: string,
  action: WidgetResolutionAction,
  caller: AuthenticatedCaller,
  deps: WidgetResolverDeps
): Promise<WidgetResolutionResult> {
  // 1. Load the widget and authorization context in one short database unit.
  const { message, session, branch, widget } = await deps.runInTenantDatabaseScope(async () => {
    let message: Message;
    try {
      message = (await deps.app.service('messages').get(widgetId)) as Message;
    } catch (error) {
      if (error instanceof NotFound) throw new NotFound(`Widget ${widgetId} not found`);
      throw error;
    }

    if (message.type !== 'widget_request') {
      throw new NotFound(`Message ${widgetId} is not a widget request`);
    }
    const widget = message.metadata?.widget;
    if (!widget) throw new NotFound(`Widget ${widgetId} has no widget metadata`);

    const session = (await deps.app.service('sessions').get(message.session_id)) as Session;
    const branch = (await deps.app.service('branches').get(session.branch_id)) as Branch;
    return { message, session, branch, widget };
  });

  // 2. Authorize using the context loaded above.
  const authority = await deps.resolveSessionPromptAuthority(
    branch.branch_id,
    caller.user_id,
    session.created_by as UserID,
    session.sdk_home_scope
  );
  if (!canResolveWidget(authority)) {
    throw new Forbidden(sessionPromptDeniedMessage(authority));
  }

  // 3. Idempotency: only 'pending' widgets can be resolved.
  if (widget.status !== 'pending') {
    throw new Forbidden(
      `Widget ${widgetId} is already ${widget.status}; cannot ${action.kind} again.`
    );
  }

  // 4. Dispatch to the registry. Unknown widget types fail loudly — the
  //    client should know the daemon doesn't speak this widget type.
  const entry = getWidget(widget.widget_type);
  // (We tolerate a missing registry entry for the dismiss path because
  // dismissal needs no side-effect — but we still need the entry for the
  // dismissed-prompt builder. If no entry exists, fall back to a generic
  // user-visible prompt.)

  let resultMeta: unknown | undefined;
  let autoResumePrompt: string | undefined;
  let parsedSubmit: unknown;

  // Context for the registry hooks, built for BOTH paths so a widget can gate
  // who may dismiss it (authorizeDismiss), not just who may submit.
  const ctx: WidgetSubmitCtx = {
    // biome-ignore lint/suspicious/noExplicitAny: Pass-through Feathers Application
    app: deps.app as any,
    sessionId: message.session_id as SessionID,
    submitterUserId: caller.user_id,
    submitterRole: caller.role,
    sessionCreatorUserId: session.created_by as UserID,
  };

  if (action.kind === 'submit') {
    if (!entry) {
      throw new NotFound(
        `Widget type '${widget.widget_type}' is not registered on this daemon. ` +
          `Update the daemon or use a known widget type.`
      );
    }
    const parsed = entry.submitSchema.safeParse(action.body);
    if (!parsed.success) {
      throw new Forbidden(`Invalid submit payload: ${parsed.error.message}`);
    }
    parsedSubmit = parsed.data;
  } else {
    // dismiss — an admin-only widget gates this so a member-level dismissal
    // can't terminally decline a flow its submit path would have rejected.
    if (entry?.authorizeDismiss) {
      await entry.authorizeDismiss(ctx, widget.params);
    }
    autoResumePrompt = entry
      ? entry.buildDismissedPrompt(widget.params)
      : `[Agor] User dismissed a widget request. Do not re-request immediately — ask whether to proceed without, or move on to other work.`;
  }

  // 5. Commit the cross-daemon ownership claim before any submit side effect.
  // No DB transaction remains open while the registry handler, prompt
  // admission, or any other external/service work runs.
  const claimToken = generateId();
  const claim = await deps.resolutionStore.claim(widget.widget_id, {
    token: claimToken,
    action: action.kind,
    claimedAt: new Date().toISOString(),
    claimedBy: caller.user_id,
  });
  if (claim.outcome !== 'claimed') {
    const status = claim.message.metadata?.widget?.status ?? 'unavailable';
    throw new Forbidden(`Widget ${widgetId} is already ${status}; cannot ${action.kind} again.`);
  }

  if (action.kind === 'submit') {
    // The registry entry and parsed payload are established before the claim;
    // only the durable winner reaches this external-work boundary. A handler
    // that explicitly reports failure is the sole safe case for reopening the
    // widget: no later admission/completion failure may replay this effect.
    try {
      await entry!.applySubmit(ctx, parsedSubmit, widget.params);
    } catch (error) {
      await deps.resolutionStore.fail(widget.widget_id, claimToken, {
        failedAt: new Date().toISOString(),
        errorCode: structuredLogErrorCode(error),
      });
      throw error;
    }
    resultMeta = entry!.buildResultMeta(parsedSubmit);
    autoResumePrompt = entry!.buildAutoResumePrompt(resultMeta, widget.params);
  }

  // 6. Admit auto-resume before publishing terminal widget state. If this
  // process dies or any downstream operation fails after admission, the
  // stable Task remains recoverable while this claim stays `resolving`; never
  // reopen it and replay an already-completed external effect.
  let autoResumeQueued = false;
  if (widget.auto_resume !== false && autoResumePrompt) {
    // Re-evaluate at Task admission. A sharing switch may be revoked or the
    // caller may lose Collaborator access while a submit handler performs
    // external work. The durable widget claim remains `resolving` on denial so
    // the already-completed side effect is never replayed.
    const promptAuthority = await deps.resolveSessionPromptAuthority(
      branch.branch_id,
      caller.user_id,
      session.created_by as UserID,
      session.sdk_home_scope
    );
    if (!canResolveWidget(promptAuthority)) {
      throw new Forbidden(sessionPromptDeniedMessage(promptAuthority));
    }
    await deps.app.service('/sessions/:id/prompt').create(
      {
        prompt: autoResumePrompt,
        messageSource: 'agor',
        idempotencyTaskId: widgetAutoResumeTaskId(widget.widget_id),
        metadata: {
          system_authored: true,
          widget_id: widget.widget_id,
          widget_resolved_by_user_id: caller.user_id,
        },
      },
      {
        // The Task records the actual resolver so prompts, credentials, and
        // managed environment variables are attributed to the caller rather
        // than borrowed from the Session owner.
        user: { user_id: caller.user_id },
        route: { id: message.session_id },
      }
    );
    autoResumeQueued = true;
  }

  // 7. Only the claim token can publish the terminal resolution.
  const newStatus: WidgetMessageMetadata['status'] =
    action.kind === 'submit' ? 'submitted' : 'dismissed';
  const resolvedAt = new Date().toISOString();
  const finished = await deps.resolutionStore.complete(widget.widget_id, claimToken, {
    status: newStatus,
    resolvedAt,
    submittedBy: caller.user_id,
    resultMeta,
  });
  if (finished.outcome !== 'updated') {
    throw new Conflict(`Widget ${widgetId} resolution claim was lost before completion`);
  }

  // 8. Broadcast on the messages service's room (per-session subscribers
  // are already wired up to that channel — see register-services.ts).
  const resolvedPayload = {
    widget_id: widget.widget_id,
    session_id: message.session_id,
    status: newStatus,
    result_meta: resultMeta,
    resolved_at: resolvedAt,
    submitted_by: caller.user_id,
  };
  if (deps.publishResolved) deps.publishResolved(resolvedPayload);
  else deps.app.service('messages').emit?.('widget:resolved', resolvedPayload);

  return {
    widget_id: widget.widget_id,
    status: newStatus,
    auto_resume_queued: autoResumeQueued,
  };
}
