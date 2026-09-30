import { describe, expect, it } from 'vitest';
import {
  requireOpenCodeNativeFile,
  requireOpenCodeSupported,
  resolveOpenCodeCapabilities,
} from './capabilities.js';

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

  it.each([
    [{ multi_tenancy: { mode: 'required_from_auth' as const } }, 'hosted_tenancy'],
    [{ execution: { unix_user_mode: 'delegated' as const } }, 'delegated_execution'],
    [{ execution: { executor_command_template: 'launch {task_id}' } }, 'templated_transport'],
  ])('reports %o as unsupported with code %s', (config, code) => {
    expect(resolveOpenCodeCapabilities(config)).toMatchObject({
      mode: 'unsupported',
      reason: { code, message: expect.any(String) },
    });
  });

  it('admits hosted managed mode only with the opt-in and a persistent per-user home', () => {
    const hosted = {
      multi_tenancy: { mode: 'required_from_auth' as const },
      execution: {
        unix_user_mode: 'delegated' as const,
        executor_command_template: 'launch {task_id}',
        executor_storage: { user_home: 'persistent-per-user' as const },
      },
    };
    const optIn = { agentic_tools: { opencode_hosted_native_state: 'checkpointed' as const } };
    expect(resolveOpenCodeCapabilities({ ...hosted, ...optIn })).toEqual({
      mode: 'managed-projection',
    });
    expect(resolveOpenCodeCapabilities(hosted)).toMatchObject({
      reason: { code: 'hosted_tenancy' },
    });
    expect(
      resolveOpenCodeCapabilities({
        ...hosted,
        ...optIn,
        execution: { ...hosted.execution, executor_storage: { user_home: 'shared' } },
      })
    ).toMatchObject({ reason: { code: 'persistent_user_home_required' } });
    expect(() => requireOpenCodeNativeFile({ ...hosted, ...optIn })).toThrow(/hosted workspaces/);
  });

  it('fails closed with the structured reason as BadRequest data', () => {
    expect(() =>
      requireOpenCodeSupported({ multi_tenancy: { mode: 'required_from_auth' } })
    ).toThrow(expect.objectContaining({ code: 400, data: { code: 'hosted_tenancy' } }));
    expect(requireOpenCodeSupported({})).toEqual({ mode: 'native-file', unixUserMode: 'simple' });
  });
});
