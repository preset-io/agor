import { describe, expect, it } from 'vitest';
import { requireOpenCodeMode, resolveOpenCodeCapabilities } from './capabilities.js';

const hostedBase = {
  multi_tenancy: { mode: 'required_from_auth' as const },
  execution: {
    unix_user_mode: 'delegated' as const,
    executor_command_template: 'launch {task_id}',
    executor_storage: { user_home: 'persistent-per-user' as const },
  },
};

describe('OpenCode capability resolver', () => {
  it('keeps local simple/sandbox deployments on the native-file authority', () => {
    expect(resolveOpenCodeCapabilities({})).toEqual({
      mode: 'native-file',
      unixUserMode: 'simple',
    });
    expect(resolveOpenCodeCapabilities({ execution: { unix_user_mode: 'sandbox' } })).toEqual({
      mode: 'native-file',
      unixUserMode: 'sandbox',
    });
  });

  it('reports a hosted workspace as unsupported until the operator opts in', () => {
    const capabilities = resolveOpenCodeCapabilities(hostedBase);
    expect(capabilities.mode).toBe('unsupported');
    if (capabilities.mode !== 'unsupported') throw new Error('expected unsupported');
    expect(capabilities.reason.code).toBe('hosted_native_state_disabled');
    expect(capabilities.reason.message).toMatch(/not been enabled/);
  });

  it('reports the historical reasons for local templated or delegated deployments', () => {
    expect(
      resolveOpenCodeCapabilities({ execution: { executor_command_template: 'launch' } })
    ).toMatchObject({ mode: 'unsupported', reason: { code: 'templated_transport' } });
    expect(
      resolveOpenCodeCapabilities({ execution: { unix_user_mode: 'delegated' } })
    ).toMatchObject({ mode: 'unsupported', reason: { code: 'delegated_execution' } });
  });

  it('admits managed projection only when every hosted prerequisite holds', () => {
    const optIn = { agentic_tools: { opencode_hosted_native_state: 'checkpointed' as const } };
    expect(resolveOpenCodeCapabilities({ ...hostedBase, ...optIn })).toEqual({
      mode: 'managed-projection',
    });
    expect(
      resolveOpenCodeCapabilities({
        ...hostedBase,
        ...optIn,
        execution: { ...hostedBase.execution, executor_storage: { user_home: 'shared' } },
      })
    ).toMatchObject({ mode: 'unsupported', reason: { code: 'persistent_user_home_required' } });
    expect(
      resolveOpenCodeCapabilities({
        ...hostedBase,
        ...optIn,
        execution: { ...hostedBase.execution, executor_command_template: undefined },
      })
    ).toMatchObject({ mode: 'unsupported', reason: { code: 'templated_transport' } });
    expect(
      resolveOpenCodeCapabilities({
        ...hostedBase,
        ...optIn,
        execution: { ...hostedBase.execution, unix_user_mode: 'simple' },
      })
    ).toMatchObject({ mode: 'unsupported', reason: { code: 'delegated_execution' } });
    expect(
      resolveOpenCodeCapabilities({ ...hostedBase, ...optIn, multi_tenancy: { mode: 'static' } })
    ).toMatchObject({ mode: 'unsupported', reason: { code: 'hosted_tenancy' } });
  });

  it('fails closed with the structured reason and distinguishes non-admitted modes', () => {
    expect(() =>
      requireOpenCodeMode(resolveOpenCodeCapabilities(hostedBase), ['native-file'], 'x')
    ).toThrow(/not been enabled/);
    try {
      requireOpenCodeMode(resolveOpenCodeCapabilities(hostedBase), ['native-file'], 'x');
    } catch (error) {
      expect((error as { data?: { code?: string } }).data?.code).toBe(
        'hosted_native_state_disabled'
      );
    }
    expect(() =>
      requireOpenCodeMode({ mode: 'managed-projection' }, ['native-file'], 'native OAuth')
    ).toThrow(/native OAuth is not available in managed-projection mode/);
    expect(
      requireOpenCodeMode({ mode: 'native-file', unixUserMode: 'simple' }, ['native-file'], 'x')
    ).toEqual({ mode: 'native-file', unixUserMode: 'simple' });
  });
});
