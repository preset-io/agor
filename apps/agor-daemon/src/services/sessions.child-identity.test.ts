/**
 * Regression tests for `SessionsService.resolveChildIdentity()`'s internal
 * (provider-less) path.
 *
 * Internal fork/spawn preserves parent attribution and inherits the parent's
 * immutable `unix_username` stamp. In delegated mode that stamp is
 * load-bearing identity, so a null-stamped parent must be rejected at
 * fork/spawn time — not persisted as a child that only fails at first prompt
 * (or, in hosted deployments, silently shares an identity).
 */
import type { Application } from '@agor/core/feathers';
import type { Branch, Session, UUID } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@agor/core/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/config')>();
  return {
    ...actual,
    resolveExecutionSecurityMode: vi.fn(),
  };
});

import { resolveExecutionSecurityMode } from '@agor/core/config';
import { SessionsService } from './sessions';

const resolveExecutionSecurityModeMock = vi.mocked(resolveExecutionSecurityMode);

function mockMode(unixUserMode: 'simple' | 'delegated' | 'sandbox'): void {
  resolveExecutionSecurityModeMock.mockReturnValue({
    unixUserMode,
    requiresExecutionHomeKey: unixUserMode === 'delegated',
  });
}

// The internal path never touches repositories or the app — it inherits from
// the parent object and returns before any lookup. Bare stubs keep the
// harness minimal (mirrors STUB_APP in sessions.agentic-tool-guard.test.ts).
function makeService(): SessionsService {
  return new SessionsService({} as never, {} as unknown as Application);
}

function makeParent(unixUsername: string | null): Session {
  return {
    session_id: 'parent-session' as Session['session_id'],
    branch_id: 'branch-1' as Session['branch_id'],
    created_by: 'parent-owner' as UUID,
    unix_username: unixUsername,
    sdk_home_scope: 'execution_home',
  } as Session;
}

async function resolveInternalChildIdentity(
  service: SessionsService,
  parent: Session
): Promise<{ created_by: Session['created_by']; unix_username: Session['unix_username'] }> {
  // Private method; tested directly because the surrounding fork()/spawn()
  // flows need a full service harness while the security branch under test
  // lives entirely in this function's provider-less early return.
  return (
    service as unknown as {
      resolveChildIdentity: (
        parent: Session,
        params?: unknown
      ) => Promise<{ created_by: Session['created_by']; unix_username: Session['unix_username'] }>;
    }
  ).resolveChildIdentity(parent, undefined);
}

async function resolveExternalChildIdentity(
  service: SessionsService,
  parent: Session,
  userId: UUID
): Promise<{ created_by: Session['created_by']; unix_username: Session['unix_username'] }> {
  return (
    service as unknown as {
      resolveChildIdentity: (
        parent: Session,
        params?: unknown
      ) => Promise<{ created_by: Session['created_by']; unix_username: Session['unix_username'] }>;
    }
  ).resolveChildIdentity(parent, {
    provider: 'rest',
    user: { user_id: userId, role: 'member' },
  });
}

describe('resolveChildIdentity — internal (provider-less) calls', () => {
  it('rejects a null-stamped parent in delegated mode', async () => {
    mockMode('delegated');
    await expect(resolveInternalChildIdentity(makeService(), makeParent(null))).rejects.toThrow(
      /unix_user_mode 'delegated' requires a unix_username/
    );
  });

  it('inherits the parent stamp in delegated mode when present', async () => {
    mockMode('delegated');
    await expect(resolveInternalChildIdentity(makeService(), makeParent('alice'))).resolves.toEqual(
      { created_by: 'parent-owner', unix_username: 'alice' }
    );
  });

  it('allows a null stamp in simple mode', async () => {
    mockMode('simple');
    await expect(resolveInternalChildIdentity(makeService(), makeParent(null))).resolves.toEqual({
      created_by: 'parent-owner',
      unix_username: null,
    });
  });

  it('does not require the old owner stamp for a branch-scoped child', async () => {
    mockMode('delegated');
    const parent = { ...makeParent(null), sdk_home_scope: 'branch' as const };
    await expect(resolveInternalChildIdentity(makeService(), parent)).resolves.toEqual({
      created_by: 'parent-owner',
      unix_username: null,
    });
  });
});

describe('resolveChildIdentity — external calls', () => {
  it('rejects an own-session fork when the creator no longer has Collaborator access', async () => {
    mockMode('simple');
    const ownerId = 'parent-owner' as UUID;
    const service = makeService();
    const resolveSessionPromptAuthority = vi.fn(async () => ({
      allowed: false,
      source: 'denied' as const,
      denial_reason: 'branch_access_required' as const,
    }));
    Object.assign(service as unknown as Record<string, unknown>, {
      app: {
        service: (name: string) => {
          if (name === 'branches') {
            return { get: vi.fn(async () => ({ branch_id: 'branch-1' }) as Branch) };
          }
          throw new Error(`Unexpected service: ${name}`);
        },
      },
      branchRepo: { resolveSessionPromptAuthority },
    });

    await expect(
      resolveExternalChildIdentity(service, makeParent('alice'), ownerId)
    ).rejects.toThrow(/Only Collaborators and Managers/);
    expect(resolveSessionPromptAuthority).toHaveBeenCalledWith(
      'branch-1',
      ownerId,
      ownerId,
      'execution_home'
    );
  });

  it('attributes a branch-scoped cross-user child to the caller', async () => {
    mockMode('delegated');
    const callerId = 'branch-collaborator' as UUID;
    const service = makeService();
    const parent = { ...makeParent(null), sdk_home_scope: 'branch' as const };
    const resolveSessionPromptAuthority = vi.fn(async () => ({
      allowed: true,
      execution_user_id: callerId,
      source: 'branch_session' as const,
    }));
    Object.assign(service as unknown as Record<string, unknown>, {
      app: {
        service: (name: string) => {
          if (name === 'branches') {
            return { get: vi.fn(async () => ({ branch_id: 'branch-1' }) as Branch) };
          }
          throw new Error(`Unexpected service: ${name}`);
        },
      },
      branchRepo: { resolveSessionPromptAuthority },
      usersRepo: {
        findById: vi.fn(async () => ({ user_id: callerId, unix_username: 'caller-home' })),
      },
    });

    await expect(resolveExternalChildIdentity(service, parent, callerId)).resolves.toEqual({
      created_by: callerId,
      unix_username: 'caller-home',
    });
  });
});
