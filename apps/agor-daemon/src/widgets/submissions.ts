/**
 * Widget submission / dismissal route handlers.
 *
 * Two custom REST routes:
 *   POST /widgets/:widget_id/submit
 *   POST /widgets/:widget_id/dismiss
 *
 * Both follow the same resolution path:
 *   1. Load the widget message row by `widget_id` (message_id == widget_id).
 *   2. Authorize: caller is session creator OR has prompt-tier worktree RBAC.
 *   3. Idempotency: status MUST be 'pending'.
 *   4. Dispatch to the registry (`applySubmit` for submit; no side-effect
 *      for dismiss).
 *   5. Patch `metadata.widget.status` to 'submitted' / 'dismissed' along
 *      with `result_meta` and `resolved_at`.
 *   6. Queue a system-authored auto-resume task via the existing
 *      `/sessions/:id/prompt` route (the "Never lose a prompt" #1068 path),
 *      unless `auto_resume === false`.
 *   7. Broadcast `widget:resolved` on the per-session Feathers room.
 *
 * Critical security invariant: the `applySubmit` handler is the ONLY place
 * the raw submit body reaches; from `result_meta` onward, no
 * caller-supplied values flow back into the agent context. See §5.1 of the
 * design doc for the path-by-path enumeration.
 */

import { Forbidden, NotAuthenticated, NotFound } from '@agor/core/feathers';
import type {
  Message,
  MessageID,
  Session,
  SessionID,
  UserID,
  WidgetMessageMetadata,
  Worktree,
} from '@agor/core/types';
import { PERMISSION_RANK, resolveWorktreePermission } from '../utils/worktree-authorization.js';
import { getWidget, type WidgetSubmitCtx } from './registry.js';

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
  /** Worktree ownership lookup — pulled out so tests can stub without RBAC plumbing. */
  isWorktreeOwner(worktreeId: string, userId: UserID): Promise<boolean>;
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
 * Check whether the caller is allowed to resolve a widget for the given
 * session+worktree. Mirrors the rule in §5.2 / R4: session creator always
 * passes; worktree owners pass via the owner-bypass path; non-creators need
 * prompt-tier worktree RBAC.
 */
export function canResolveWidget(
  caller: AuthenticatedCaller,
  session: Pick<Session, 'created_by'>,
  worktree: Worktree,
  isOwner: boolean
): boolean {
  if (session.created_by === caller.user_id) return true;
  const effective = resolveWorktreePermission(worktree, caller.user_id, isOwner, caller.role);
  return PERMISSION_RANK[effective] >= PERMISSION_RANK.prompt;
}

/**
 * Per-widget in-process serialization. Two concurrent submits (e.g. two
 * browser tabs both posting in the small window between the status check
 * and the message.patch) would each pass the `status === 'pending'` gate
 * and both run side effects: doubled auto-resume tasks, surprise writes.
 *
 * The lock guards the critical section (status check → applySubmit →
 * message.patch → tasks.create). Sufficient for single-daemon deployments,
 * which is the only deployment shape today. A multi-daemon setup would need
 * a DB-level optimistic check; we accept that trade today.
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

  // Serialize concurrent resolutions for the same widget (see comment on
  // `inFlightResolutions`). The second caller will await the first's
  // outcome and then hit the `status !== 'pending'` rejection.
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
  // 1. Load the widget message.
  let message: Message;
  try {
    message = (await deps.app.service('messages').get(widgetId)) as Message;
  } catch {
    throw new NotFound(`Widget ${widgetId} not found`);
  }

  if (message.type !== 'widget_request') {
    throw new NotFound(`Message ${widgetId} is not a widget request`);
  }

  const widget = message.metadata?.widget;
  if (!widget) {
    throw new NotFound(`Widget ${widgetId} has no widget metadata`);
  }

  // 2. Load the session + worktree for authz.
  const session = (await deps.app.service('sessions').get(message.session_id)) as Session;
  const worktree = (await deps.app.service('worktrees').get(session.worktree_id)) as Worktree;
  const isOwner = await deps.isWorktreeOwner(worktree.worktree_id, caller.user_id);

  if (!canResolveWidget(caller, session, worktree, isOwner)) {
    throw new Forbidden(
      `You need to be the session creator, a worktree owner, or have 'prompt' permission on the worktree to resolve this widget.`
    );
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
    const submit = parsed.data;

    const submitCtx: WidgetSubmitCtx = {
      // biome-ignore lint/suspicious/noExplicitAny: Pass-through Feathers Application
      app: deps.app as any,
      sessionId: message.session_id as SessionID,
      submitterUserId: caller.user_id,
      submitterRole: caller.role,
      sessionCreatorUserId: session.created_by as UserID,
    };
    await entry.applySubmit(submitCtx, submit, widget.params);
    resultMeta = entry.buildResultMeta(submit);
    autoResumePrompt = entry.buildAutoResumePrompt(resultMeta, widget.params);
  } else {
    // dismiss
    autoResumePrompt = entry
      ? entry.buildDismissedPrompt(widget.params)
      : `[Agor] User dismissed a widget request. Do not re-request immediately — ask whether to proceed without, or move on to other work.`;
  }

  // 5. Patch the widget message — flip status, stamp resolution.
  const newStatus: WidgetMessageMetadata['status'] =
    action.kind === 'submit' ? 'submitted' : 'dismissed';
  const updatedWidget: WidgetMessageMetadata = {
    ...widget,
    status: newStatus,
    resolved_at: new Date().toISOString(),
    submitted_by: caller.user_id,
    ...(resultMeta !== undefined ? { result_meta: resultMeta } : {}),
  };
  await deps.app.service('messages').patch(widgetId, {
    metadata: {
      ...(message.metadata ?? {}),
      widget: updatedWidget,
    },
  });

  // 6. Auto-resume task (skipped when the agent set auto_resume:false on
  //    the original tool call). Goes through `/sessions/:id/prompt` so the
  //    idle-vs-queued branching is identical to a user-typed prompt — the
  //    "Never lose a prompt" #1068 path.
  let autoResumeQueued = false;
  if (widget.auto_resume !== false && autoResumePrompt) {
    await deps.app.service('/sessions/:id/prompt').create(
      {
        prompt: autoResumePrompt,
        messageSource: 'agor',
        // Stamp traceability fields onto the queued task so the UI can
        // distinguish system-authored auto-resume prompts from user-typed
        // ones, and so the resulting task links back to its widget.
        metadata: {
          system_authored: true,
          widget_id: widget.widget_id,
        },
      },
      {
        // Internal call — no `provider` so RBAC hooks bypass. Submitter is
        // attributed (`created_by`) for audit; see §5.3 of the design.
        user: { user_id: caller.user_id },
        route: { id: message.session_id },
      }
    );
    autoResumeQueued = true;
  }

  // 7. Broadcast on the messages service's room (per-session subscribers
  //    are already wired up to that channel — see register-services.ts).
  deps.app.service('messages').emit?.('widget:resolved', {
    widget_id: widget.widget_id,
    session_id: message.session_id,
    status: newStatus,
    result_meta: resultMeta,
    resolved_at: updatedWidget.resolved_at,
    submitted_by: caller.user_id,
  });

  return {
    widget_id: widget.widget_id,
    status: newStatus,
    auto_resume_queued: autoResumeQueued,
  };
}
