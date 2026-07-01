/**
 * Unit tests for the onboarding-agent trigger.
 *
 * Covers the contract this module exists to enforce:
 *   - `auto` queues when the user's progress document doesn't exist yet
 *     AND the credential actually resolves (live check, not just "a
 *     session exists")
 *   - `auto` does NOT queue when the credential does not resolve - this is
 *     the fix for firing the kickoff into a session that cannot execute
 *     anything yet
 *   - `auto` no-ops once the progress document already exists (idempotent
 *     - no duplicate opening message), and does so WITHOUT even running
 *     the live credential check (cheap existence check short-circuits first)
 *   - `manual` always queues, even when the document exists (an explicit
 *     re-invocation overrides a prior dismissal) and skips the live
 *     credential check entirely (an open session is already known-good)
 *   - the queued task carries `onboarding_trigger` + `system_authored`
 *     metadata via the existing `/sessions/:id/prompt` path
 *
 * `createCheckAuthService` is mocked at the module boundary rather than
 * exercised for real: this file's job is to test *trigger.ts's* decision
 * logic (does it call the live check, and does it respect the result?),
 * not to re-test `check-auth.ts`'s own provider-probing internals, which
 * belong in that module's own tests.
 */

import {
  type Database,
  generateId,
  KnowledgeDocumentRepository,
  KnowledgeNamespaceRepository,
  UsersRepository,
} from '@agor/core/db';
import type { AgenticToolName, SessionID, User, UserID } from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import { beforeEach, describe, expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import {
  ONBOARDING_KNOWLEDGE_DOC_PATH,
  type OnboardingTriggerApp,
  onboardingNamespaceSlug,
  triggerOnboarding,
} from './trigger';

const checkAuthMock = vi.hoisted(() => ({
  create: vi.fn(async () => ({ authenticated: true, method: 'api-key' as const })),
}));

vi.mock('../services/check-auth.js', () => ({
  createCheckAuthService: () => checkAuthMock,
}));

const SOME_TOOL = 'claude-code' as AgenticToolName;

interface MockCall {
  data: unknown;
  params: unknown;
}

function makeMockApp() {
  const calls: MockCall[] = [];
  const app: OnboardingTriggerApp = {
    service(name: string) {
      if (name !== '/sessions/:id/prompt') {
        throw new Error(`Mock app has no service '${name}'`);
      }
      return {
        async create(data: unknown, params?: unknown) {
          calls.push({ data, params });
          return { task_id: 'task-mock' };
        },
      };
    },
  };
  return { app, calls };
}

async function seedUser(db: Database, label: string): Promise<User> {
  const users = new UsersRepository(db);
  return users.create({
    user_id: generateId() as UserID,
    email: `${label}-${Date.now()}-${Math.random()}@test.local`,
    name: label,
    role: ROLES.MEMBER,
  }) as Promise<User>;
}

/** Seed a progress document exactly where `triggerOnboarding` expects to find it. */
async function seedProgressDocument(db: Database, userId: UserID): Promise<void> {
  const namespace = await new KnowledgeNamespaceRepository(db).create({
    slug: onboardingNamespaceSlug(userId),
    display_name: 'Onboarding',
    kind: 'user',
    owner_user_id: userId,
    visibility_default: 'private',
    created_by: userId,
  });
  await new KnowledgeDocumentRepository(db).create({
    namespace_id: namespace.namespace_id,
    path: ONBOARDING_KNOWLEDGE_DOC_PATH,
    title: 'Onboarding progress',
    kind: 'memory',
    visibility: 'private',
    status: 'published',
    edit_policy: 'owner',
    content_text: '# Onboarding progress',
    created_by: userId,
  });
}

describe('triggerOnboarding', () => {
  beforeEach(() => {
    checkAuthMock.create.mockReset();
    checkAuthMock.create.mockResolvedValue({ authenticated: true, method: 'api-key' });
  });

  dbTest('auto queues the kickoff prompt when the credential resolves', async ({ db }) => {
    const { app, calls } = makeMockApp();
    const userId = (await seedUser(db, 'new-user')).user_id as UserID;

    const result = await triggerOnboarding(app, db, {
      sessionId: generateId() as SessionID,
      userId,
      callerUserId: userId,
      agenticTool: SOME_TOOL,
      reason: 'auto',
    });

    expect(result).toEqual({ queued: true, reason: 'auto' });
    expect(calls).toHaveLength(1);
    expect(calls[0].data).toMatchObject({
      messageSource: 'agor',
      metadata: { system_authored: true, onboarding_trigger: 'auto' },
    });
    expect((calls[0].data as { prompt: string }).prompt).toContain(onboardingNamespaceSlug(userId));
    expect(checkAuthMock.create).toHaveBeenCalledWith(
      { tool: SOME_TOOL },
      expect.objectContaining({ user: expect.objectContaining({ user_id: userId }) })
    );
  });

  dbTest(
    'auto does NOT queue when the credential does not actually resolve, even though a session exists',
    async ({ db }) => {
      checkAuthMock.create.mockResolvedValue({
        authenticated: false,
        method: 'none',
        hint: 'not configured',
      });
      const { app, calls } = makeMockApp();
      const userId = (await seedUser(db, 'no-credential-user')).user_id as UserID;

      // Simulates the "Continue without key" wizard path, or a rejected
      // key from "Save & Continue": a session exists (the caller always
      // has one by the time it calls this), but nothing actually
      // authenticates. This is the exact case that used to slip through
      // when the trigger only checked "did the wizard run a
      // credential-setting button", not "does a credential really work".
      const result = await triggerOnboarding(app, db, {
        sessionId: generateId() as SessionID,
        userId,
        callerUserId: userId,
        agenticTool: SOME_TOOL,
        reason: 'auto',
      });

      expect(result).toEqual({ queued: false, reason: 'auto' });
      expect(calls).toHaveLength(0);
    }
  );

  dbTest(
    'auto no-ops once the progress document already exists, without even running the live check',
    async ({ db }) => {
      const { app, calls } = makeMockApp();
      const userId = (await seedUser(db, 'returning-user')).user_id as UserID;
      await seedProgressDocument(db, userId);

      const result = await triggerOnboarding(app, db, {
        sessionId: generateId() as SessionID,
        userId,
        callerUserId: userId,
        agenticTool: SOME_TOOL,
        reason: 'auto',
      });

      expect(result).toEqual({ queued: false, reason: 'auto' });
      expect(calls).toHaveLength(0);
      expect(checkAuthMock.create).not.toHaveBeenCalled();
    }
  );

  dbTest('manual always queues, even when the progress document exists', async ({ db }) => {
    const { app, calls } = makeMockApp();
    const userId = (await seedUser(db, 'dismissed-user')).user_id as UserID;
    await seedProgressDocument(db, userId);

    const result = await triggerOnboarding(app, db, {
      sessionId: generateId() as SessionID,
      userId,
      callerUserId: userId,
      agenticTool: SOME_TOOL,
      reason: 'manual',
    });

    expect(result).toEqual({ queued: true, reason: 'manual' });
    expect(calls).toHaveLength(1);
    expect(calls[0].data).toMatchObject({
      metadata: { system_authored: true, onboarding_trigger: 'manual' },
    });
    expect(checkAuthMock.create).not.toHaveBeenCalled();
  });

  dbTest(
    'manual always queues even when the credential would not resolve - explicit request wins',
    async ({ db }) => {
      checkAuthMock.create.mockResolvedValue({ authenticated: false, method: 'none' });
      const { app, calls } = makeMockApp();
      const userId = (await seedUser(db, 'manual-no-credential-user')).user_id as UserID;

      const result = await triggerOnboarding(app, db, {
        sessionId: generateId() as SessionID,
        userId,
        callerUserId: userId,
        agenticTool: SOME_TOOL,
        reason: 'manual',
      });

      expect(result).toEqual({ queued: true, reason: 'manual' });
      expect(calls).toHaveLength(1);
    }
  );

  dbTest('two users get independent namespace slugs', async ({ db }) => {
    const { app, calls } = makeMockApp();
    const userA = (await seedUser(db, 'user-a')).user_id as UserID;
    const userB = (await seedUser(db, 'user-b')).user_id as UserID;

    await triggerOnboarding(app, db, {
      sessionId: generateId() as SessionID,
      userId: userA,
      callerUserId: userA,
      agenticTool: SOME_TOOL,
      reason: 'auto',
    });
    await triggerOnboarding(app, db, {
      sessionId: generateId() as SessionID,
      userId: userB,
      callerUserId: userB,
      agenticTool: SOME_TOOL,
      reason: 'auto',
    });

    expect(calls).toHaveLength(2);
    const slugA = onboardingNamespaceSlug(userA);
    const slugB = onboardingNamespaceSlug(userB);
    expect(slugA).not.toEqual(slugB);
    expect((calls[0].data as { prompt: string }).prompt).toContain(slugA);
    expect((calls[1].data as { prompt: string }).prompt).toContain(slugB);
  });
});
