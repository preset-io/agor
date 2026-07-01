/**
 * Onboarding-agent trigger.
 *
 * Queues the kickoff prompt (`./kickoff-prompt.ts`) into an existing session
 * via the same `/sessions/:id/prompt` path the `env_vars` widget's
 * auto-resume uses (see `../widgets/submissions.ts`). No new session/agent
 * type - this just decides *whether* to queue and builds the prompt text.
 *
 * Two callers:
 *   - `reason: 'auto'` - the Onboarding Wizard, right after it creates (or
 *     reuses) the user's assistant session. A session existing is NOT the
 *     same thing as AI being connected - "Continue without key" also
 *     creates a session, with no credential at all. So this path performs
 *     a LIVE credential-resolution check (`createCheckAuthService`, the
 *     same probe the wizard's own "Test Connection" button and Settings
 *     use) immediately before queuing, and no-ops silently if it fails.
 *     This is the fallback described in the PRD §3: Feature 1
 *     (`feature-connect-ai-empty-state`) isn't merged yet, so there's no
 *     "credential resolution succeeded" event to hook into server-side
 *     today - reusing its underlying check is the next best thing. Once
 *     Feature 1 merges, its own success event is the better long-term
 *     hook (see PRD §3) - this call site is the one to revisit then.
 *     Also idempotent on the Knowledge existence check: no-ops if this
 *     user's progress document already exists.
 *   - `reason: 'manual'` - the "Setup guide" re-entry affordance. Always
 *     queues, no live re-check - an explicit click from inside an already
 *     -open session means that session is already known to work.
 */

import { KnowledgeDocumentRepository, shortId, type TenantScopeAwareDatabase } from '@agor/core/db';
import type { AgenticToolName, AuthenticatedParams, SessionID, UserID } from '@agor/core/types';
import { buildOnboardingKickoffPrompt, type OnboardingTriggerReason } from './kickoff-prompt.js';

export const ONBOARDING_KNOWLEDGE_DOC_PATH = 'progress.md';

export function onboardingNamespaceSlug(userId: UserID): string {
  return `onboarding-${shortId(userId)}`;
}

export interface OnboardingTriggerApp {
  service(name: string): {
    create(data: unknown, params?: unknown): Promise<unknown>;
  };
}

export interface TriggerOnboardingInput {
  sessionId: SessionID;
  /** The user this onboarding progress document belongs to (session creator). */
  userId: UserID;
  /** The user attributed as the author of the queued task (usually the same as `userId`). */
  callerUserId: UserID;
  /**
   * The session's agentic tool, used only by the `auto` path's live
   * credential-resolution check. Ignored for `manual`.
   */
  agenticTool: AgenticToolName;
  reason: OnboardingTriggerReason;
}

export interface TriggerOnboardingResult {
  queued: boolean;
  reason: OnboardingTriggerReason;
}

/**
 * Per-user in-process serialization of concurrent `auto` existence checks.
 * Mirrors `inFlightResolutions` in `../widgets/submissions.ts`: a second
 * caller waits for the first check to settle, then runs its own fresh
 * check rather than trusting the first's result. That's a deliberate,
 * narrow guarantee - this function never writes the progress document
 * itself (only the agent does, once it actually responds), so two truly
 * simultaneous `auto` calls can still both see "not found" and both queue.
 * Acceptable for single-daemon deployments; the same trade-off is accepted
 * in the widget resolver this mirrors.
 */
const inFlightAutoTriggers = new Map<string, Promise<boolean>>();

async function alreadyTriggered(db: TenantScopeAwareDatabase, userId: UserID): Promise<boolean> {
  const repo = new KnowledgeDocumentRepository(db);
  const existing = await repo.findByNamespaceSlugAndPath(
    onboardingNamespaceSlug(userId),
    ONBOARDING_KNOWLEDGE_DOC_PATH
  );
  return existing !== null;
}

export async function triggerOnboarding(
  app: OnboardingTriggerApp,
  db: TenantScopeAwareDatabase,
  input: TriggerOnboardingInput
): Promise<TriggerOnboardingResult> {
  const { sessionId, userId, callerUserId, agenticTool, reason } = input;

  if (reason === 'auto') {
    const key = String(userId);
    // If another `auto` check for this user is already in flight, wait for
    // it to settle before running our own - this is what actually closes
    // the race (two calls landing back-to-back before either check
    // resolves). It does NOT make the two calls share a result: each still
    // performs its own fresh existence check afterward, which is correct
    // since the progress document isn't written by this function at all
    // (the agent writes it later, once it actually responds) - see the
    // module comment on `inFlightAutoTriggers`.
    const inFlight = inFlightAutoTriggers.get(key);
    if (inFlight) {
      await inFlight.catch(() => {});
    }
    const check = alreadyTriggered(db, userId);
    inFlightAutoTriggers.set(key, check);
    let exists: boolean;
    try {
      exists = await check;
    } finally {
      if (inFlightAutoTriggers.get(key) === check) {
        inFlightAutoTriggers.delete(key);
      }
    }
    if (exists) return { queued: false, reason };

    // Cheap existence check passed - now do the expensive, authoritative
    // part: actually confirm the credential resolves, the same live probe
    // "Test Connection" uses. A session existing (even one just created by
    // the wizard) does not mean AI is connected - "Continue without key"
    // creates a session with nothing to authenticate with at all. Firing
    // the kickoff prompt into a session that cannot execute would just
    // surface as a raw CLI passthrough error, defeating the entire point
    // of treating "AI connected" as this flow's precondition.
    //
    // Dynamic import deliberately, not a static top-level one:
    // `check-auth.ts` pulls in the Claude SDK (for its CLI-auth probe),
    // which is otherwise never touched by anything importing this module
    // (`register-routes.ts` -> `trigger.ts`). A static import here would
    // make every consumer of `register-routes.ts` eagerly load that chain
    // at module-evaluation time - harmless in the running daemon, but it
    // widened the blast radius of an unrelated, pre-existing ESM
    // resolution issue in this package's Vitest setup (confirmed by
    // diffing full-suite runs with/without this change) to test files
    // that have nothing to do with onboarding.
    const { createCheckAuthService } = await import('../services/check-auth.js');
    const authResult = await createCheckAuthService(db).create(
      { tool: agenticTool },
      // Internal trusted call - createCheckAuthService only ever reads
      // `params.user.user_id`, so the other AuthenticatedUser fields are
      // irrelevant here; cast rather than fabricate values that mean
      // nothing in this context.
      { user: { user_id: userId } } as unknown as AuthenticatedParams
    );
    if (!authResult.authenticated) return { queued: false, reason };
  }

  const prompt = buildOnboardingKickoffPrompt({
    reason,
    namespaceSlug: onboardingNamespaceSlug(userId),
    docPath: ONBOARDING_KNOWLEDGE_DOC_PATH,
  });

  await app.service('/sessions/:id/prompt').create(
    {
      prompt,
      messageSource: 'agor',
      metadata: {
        system_authored: true,
        onboarding_trigger: reason,
      },
    },
    {
      user: { user_id: callerUserId },
      route: { id: sessionId },
    }
  );

  return { queued: true, reason };
}
