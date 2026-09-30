import { describe, expect, it } from 'vitest';
import { requireOpenCodeSupported, resolveOpenCodeCapabilities } from './capabilities.js';

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

  it('fails closed with the structured reason as BadRequest data', () => {
    expect(() =>
      requireOpenCodeSupported({ multi_tenancy: { mode: 'required_from_auth' } })
    ).toThrow(expect.objectContaining({ code: 400, data: { code: 'hosted_tenancy' } }));
    expect(requireOpenCodeSupported({})).toEqual({ mode: 'native-file', unixUserMode: 'simple' });
  });
});
