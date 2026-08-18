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
import type { Session, UUID } from '@agor/core/types';
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
    appRbacEnabled: false,
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
});
