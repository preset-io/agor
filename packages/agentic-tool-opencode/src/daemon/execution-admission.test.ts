import { describe, expect, it } from 'vitest';
import { assertOpenCodeExecutionAllowed } from './execution-admission.js';

const allowed = {
  tenantId: 'tenant-a',
  config: { execution: { unix_user_mode: 'simple' as const } },
  sessionOwnerId: 'owner',
  prompterUserId: 'owner',
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

  it('rejects execution whose writer cannot be locally contained', () => {
    expect(() =>
      assertOpenCodeExecutionAllowed({
        ...allowed,
        config: { execution: { executor_command_template: 'launch {command}' } },
      })
    ).toThrow(/locally containable/i);
  });
});
