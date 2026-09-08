import { describe, expect, it } from 'vitest';
import {
  assertAsyncEnvironmentCommandConfig,
  environmentCommandCapabilities,
  usesAsyncEnvironmentCommands,
} from './environment-commands';
import type { AgorConfig } from './types';

const hybrid: AgorConfig = {
  daemon: { public_url: 'https://daemon.example.test' },
  deployment: { mode: 'ha', ha: { execution_topology: 'external' } },
  execution: {
    unix_user_mode: 'delegated',
    executor_command_template: 'launcher',
    managed_envs_execution_mode: 'hybrid',
    environment_command_job_deadline_ms: 365000,
  },
};
describe('environment execution capability matrix', () => {
  it('preserves standalone and webhook-only without external shell prerequisites', () => {
    expect(usesAsyncEnvironmentCommands({})).toBe(false);
    expect(() => assertAsyncEnvironmentCommandConfig({})).not.toThrow();
    expect(() =>
      assertAsyncEnvironmentCommandConfig({
        deployment: { mode: 'ha' },
        execution: { managed_envs_execution_mode: 'webhook-only' },
      })
    ).not.toThrow();
  });
  it('accepts external hybrid without query-response support and independently gates shell Logs', () => {
    expect(() => assertAsyncEnvironmentCommandConfig(hybrid)).not.toThrow();
    expect(environmentCommandCapabilities(hybrid)).toMatchObject({
      asynchronous: true,
      shellLogs: false,
    });
    expect(
      environmentCommandCapabilities({
        ...hybrid,
        execution: {
          ...hybrid.execution,
          executor_response: {
            external_protocol: 'executor-response-v1',
            origin_url: 'https://replica.example.test',
          },
        },
      })
    ).toMatchObject({ shellLogs: true });
  });
  it.each([
    { unix_user_mode: 'simple' as const },
    { executor_command_template: '' },
    { environment_command_job_deadline_ms: undefined },
    { environment_command_job_deadline_ms: 366000 },
    { environment_command_job_deadline_ms: 1000 },
    { session_token_expiration_ms: 300000 },
  ])('rejects missing actual execution/deadline prerequisites: %j', (execution) => {
    expect(() =>
      assertAsyncEnvironmentCommandConfig({
        ...hybrid,
        execution: { ...hybrid.execution, ...execution },
      })
    ).toThrow();
  });
  it('rejects HA local shell even with a launcher string', () => {
    expect(() =>
      assertAsyncEnvironmentCommandConfig({
        ...hybrid,
        deployment: { mode: 'ha', ha: { execution_topology: 'shared-local' } },
      })
    ).toThrow('daemon-local HA shell');
  });
});
