import { describe, expect, it } from 'vitest';
import { assertOpenCodeExecutionAllowed } from './execution-admission.js';

const allowed = {
  tenantId: 'tenant-a',
  config: { execution: { unix_user_mode: 'simple' as const } },
  sessionOwnerId: 'owner',
  sessionSdkHomeScope: 'execution_home' as const,
  prompterUserId: 'owner',
};

const hostedConfig = {
  multi_tenancy: { mode: 'required_from_auth' as const },
  execution: {
    unix_user_mode: 'delegated' as const,
    executor_command_template: 'launch {task_id}',
    executor_storage: { user_home: 'persistent-per-user' as const },
  },
};

describe('OpenCode execution admission', () => {
  it('allows a locally contained prompt from the session owner', () => {
    expect(() => assertOpenCodeExecutionAllowed(allowed)).not.toThrow();
  });

  it('rejects a prompt from another user before native state is opened', () => {
    expect(() =>
      assertOpenCodeExecutionAllowed({ ...allowed, prompterUserId: 'another-user' })
    ).toThrow(/session owner/i);
  });

  it('admits a collaborator only on a hosted branch-home Session', () => {
    const collaborator = { ...allowed, config: hostedConfig, prompterUserId: 'another-user' };
    expect(() =>
      assertOpenCodeExecutionAllowed({ ...collaborator, sessionSdkHomeScope: 'branch' })
    ).not.toThrow();
    expect(() => assertOpenCodeExecutionAllowed(collaborator)).toThrow(/session owner/i);
    expect(() =>
      assertOpenCodeExecutionAllowed({
        ...collaborator,
        sessionSdkHomeScope: 'branch',
        prompterUserId: undefined,
      })
    ).toThrow(/session owner/i);
  });

  it('keeps local OpenCode owner-only even for a branch-scoped Session', () => {
    expect(() =>
      assertOpenCodeExecutionAllowed({
        ...allowed,
        sessionSdkHomeScope: 'branch',
        prompterUserId: 'another-user',
      })
    ).toThrow(/session owner/i);
  });

  it('rejects execution whose writer cannot be locally contained', () => {
    expect(() =>
      assertOpenCodeExecutionAllowed({
        ...allowed,
        config: { execution: { executor_command_template: 'launch {command}' } },
      })
    ).toThrow(/locally containable/i);
  });
});
