import { describe, expect, it } from 'vitest';
import {
  assertOpenCodeNativeAuthSupported,
  resolveOpenCodeCredentialNamespace,
  resolveOpenCodeTaskCredentialNamespace,
} from './credential-namespace';
import { OPENCODE_DAEMON_CONTRIBUTION } from './index.js';

describe('OpenCode credential namespace routing', () => {
  it('is stable for one tenant and subject without exposing either identifier in the path', () => {
    const first = resolveOpenCodeCredentialNamespace({
      tenantId: 'tenant-a',
      subjectUserId: 'user-1',
      homeDir: '/home/alice',
    });
    const second = resolveOpenCodeCredentialNamespace({
      tenantId: 'tenant-a',
      subjectUserId: 'user-1',
      homeDir: '/home/alice',
    });

    expect(first).toEqual(second);
    expect(first.namespaceKey).toBe(
      'e8d27b8337cc8452e28a74a7afdae72daa6bf9b3a66c68037b24cc545c094e1c'
    );
    expect(first.dataHome).toBe(
      '/home/alice/.local/share/agor/opencode/e8d27b8337cc8452e28a74a7afdae72daa6bf9b3a66c68037b24cc545c094e1c'
    );
    expect(first.dataHome).not.toContain('tenant-a');
    expect(first.dataHome).not.toContain('user-1');
  });

  it('separates identical user IDs across tenants', () => {
    const tenantA = resolveOpenCodeCredentialNamespace({
      tenantId: 'tenant-a',
      subjectUserId: 'same-user',
      homeDir: '/home/shared',
    });
    const tenantB = resolveOpenCodeCredentialNamespace({
      tenantId: 'tenant-b',
      subjectUserId: 'same-user',
      homeDir: '/home/shared',
    });

    expect(tenantA.namespaceKey).not.toBe(tenantB.namespaceKey);
    expect(tenantA.dataHome).not.toBe(tenantB.dataHome);
  });

  it('routes tasks by immutable session owner rather than a prompt actor', () => {
    const owner = resolveOpenCodeTaskCredentialNamespace({
      tenantId: 'tenant-a',
      session: {
        created_by: 'session-owner',
        unix_username: 'alice',
      },
      homeDir: '/home/alice',
    });
    const expected = resolveOpenCodeCredentialNamespace({
      tenantId: 'tenant-a',
      subjectUserId: 'session-owner',
      homeDir: '/home/alice',
    });
    const promptActor = resolveOpenCodeCredentialNamespace({
      tenantId: 'tenant-a',
      subjectUserId: 'latest-prompt-actor',
      homeDir: '/home/alice',
    });

    expect(owner).toEqual(expected);
    expect(owner).not.toEqual(promptActor);
  });

  it('uses the credential namespace as the primary writer coordination key', () => {
    const input = {
      tenantId: 'tenant-a',
      session: { created_by: 'owner', unix_username: 'alice' },
      homeDir: '/home/alice',
    };
    const namespace = resolveOpenCodeTaskCredentialNamespace(input);
    const launch = {
      ...input,
      session: {
        ...input.session,
        session_id: '01a08d5f-775f-73f6-86a1-624b43050180',
        sdk_native_state: undefined,
      },
      taskId: '01a08d5f-7773-77fa-a7dc-2575cfe6727e',
      config: {},
    };

    expect(OPENCODE_DAEMON_CONTRIBUTION.getExecutorLaunch(launch)).toEqual({
      namespaceKey: namespace.namespaceKey,
      executorPayload: { agenticToolContext: { dataHome: namespace.dataHome } },
    });
  });

  it('emits the logical managed-projection context instead of a daemon path in hosted mode', () => {
    const accepted = {
      version: 1 as const,
      attemptTaskId: '01a08d5f-7773-77fa-a7dc-2575cfe6727d',
      digest: `sha256:${'a'.repeat(64)}`,
      bytes: 4096,
      openCodeSessionId: 'ses_1',
      publishedAt: '2026-09-10T22:18:55.000Z',
    };
    const launch = OPENCODE_DAEMON_CONTRIBUTION.getExecutorLaunch({
      tenantId: 'tenant-a',
      session: {
        created_by: 'owner',
        unix_username: 'alice',
        session_id: '01a08d5f-775f-73f6-86a1-624b43050180',
        sdk_native_state: accepted,
      },
      taskId: '01a08d5f-7773-77fa-a7dc-2575cfe6727e',
      homeDir: '/home/daemon',
      config: {
        multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
        execution: {
          unix_user_mode: 'delegated',
          executor_command_template: 'launch',
          executor_storage: { user_home: 'persistent-per-user' },
        },
        agentic_tools: { opencode_hosted_native_state: 'checkpointed' },
      },
    });
    const context = launch.executorPayload.agenticToolContext as Record<string, unknown>;
    expect(context).toEqual({
      version: 2,
      mode: 'managed-projection',
      namespaceKey: launch.namespaceKey,
      agorSessionId: '01a08d5f-775f-73f6-86a1-624b43050180',
      taskId: '01a08d5f-7773-77fa-a7dc-2575cfe6727e',
      accepted,
    });
    expect(JSON.stringify(context)).not.toContain('/home/daemon');
    expect(JSON.stringify(context)).not.toContain('tenant-a');
  });

  it('rejects hosted auth-resolved tenancy before native OpenCode work', () => {
    expect(() =>
      assertOpenCodeNativeAuthSupported({
        multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
      })
    ).toThrow(/hosted native-state execution has not been enabled/i);
  });

  it('rejects delegated execution before deriving native OpenCode paths', () => {
    expect(() =>
      assertOpenCodeNativeAuthSupported({
        execution: { unix_user_mode: 'delegated' },
      })
    ).toThrow(/delegated execution provides no native-state home boundary/i);
  });

  it('rejects managed projection for native-file credential operations with a structured reason', () => {
    let caught: unknown;
    try {
      assertOpenCodeNativeAuthSupported({
        multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
        execution: {
          unix_user_mode: 'delegated',
          executor_command_template: 'launch',
          executor_storage: { user_home: 'persistent-per-user' },
        },
        agentic_tools: { opencode_hosted_native_state: 'checkpointed' },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      message: expect.stringMatching(/not available in managed-projection mode/),
      data: { code: 'mode_not_admitted', mode: 'managed-projection' },
    });
  });

  it.each(['simple', 'sandbox'] as const)(
    'returns supported %s execution mode for downstream path resolution',
    (mode) => {
      expect(
        assertOpenCodeNativeAuthSupported({
          execution: { unix_user_mode: mode },
        })
      ).toBe(mode);
    }
  );
});
