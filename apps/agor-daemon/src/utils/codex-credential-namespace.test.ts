import { describe, expect, it } from 'vitest';
import {
  applySimpleCodexTaskHome,
  resolveSimpleCodexHome,
  resolveSimpleCodexTaskHome,
} from './codex-credential-namespace.js';

describe('resolveSimpleCodexHome', () => {
  const resolve = (tenantId: string, subjectUserId: string) =>
    resolveSimpleCodexHome({ tenantId, subjectUserId, homeDir: '/home/agor' });

  it('is stable for the same trusted tenant and user identity', () => {
    expect(resolve('tenant-a', 'user-a')).toBe(resolve('tenant-a', 'user-a'));
    expect(resolve('tenant-a', 'user-a')).toMatch(
      /^\/home\/agor\/\.local\/share\/agor\/codex\/[0-9a-f]{64}$/
    );
  });

  it('separates users and tenants', () => {
    const first = resolve('tenant-a', 'user-a');
    expect(resolve('tenant-a', 'user-b')).not.toBe(first);
    expect(resolve('tenant-b', 'user-a')).not.toBe(first);
  });

  it('rejects missing identity and a relative executor home', () => {
    expect(() => resolve('', 'user-a')).toThrow(/tenant and user identity/);
    expect(() =>
      resolveSimpleCodexHome({ tenantId: 'tenant-a', subjectUserId: 'user-a', homeDir: 'relative' })
    ).toThrow(/absolute executor home/);
  });
});

describe('resolveSimpleCodexTaskHome', () => {
  it('routes a simple Codex task by session owner', () => {
    const codexHome = resolveSimpleCodexTaskHome({
      mode: 'simple',
      tenantId: 'tenant-a',
      session: { agentic_tool: 'codex', created_by: 'owner-a' },
      homeDir: '/home/agor',
    });
    expect(codexHome).toBe(
      resolveSimpleCodexHome({
        tenantId: 'tenant-a',
        subjectUserId: 'owner-a',
        homeDir: '/home/agor',
      })
    );
  });

  it('overrides a user-supplied CODEX_HOME with the daemon-authorized owner namespace', () => {
    const executorEnv = { PATH: '/bin', CODEX_HOME: '/tmp/user-controlled' };
    const codexHome = applySimpleCodexTaskHome(executorEnv, {
      mode: 'simple',
      tenantId: 'tenant-a',
      session: { agentic_tool: 'codex', created_by: 'owner-a' },
      homeDir: '/home/agor',
    });

    expect(codexHome).toBe(
      resolveSimpleCodexHome({
        tenantId: 'tenant-a',
        subjectUserId: 'owner-a',
        homeDir: '/home/agor',
      })
    );
    expect(executorEnv).toEqual({ PATH: '/bin', CODEX_HOME: codexHome });
  });

  it.each(['sandbox', 'delegated'] as const)('does not change %s task routing', (mode) => {
    expect(
      resolveSimpleCodexTaskHome({
        mode,
        tenantId: 'tenant-a',
        session: { agentic_tool: 'codex', created_by: 'owner-a' },
        homeDir: '/home/agor',
      })
    ).toBeUndefined();
  });

  it('does not change other tools in simple mode', () => {
    expect(
      resolveSimpleCodexTaskHome({
        mode: 'simple',
        tenantId: 'tenant-a',
        session: { agentic_tool: 'claude-code', created_by: 'owner-a' },
        homeDir: '/home/agor',
      })
    ).toBeUndefined();
  });

  it('does not pass a daemon-local path to a templated simple executor', () => {
    const executorEnv = { CODEX_HOME: '/external/runtime/home' };
    expect(
      applySimpleCodexTaskHome(executorEnv, {
        mode: 'simple',
        executorCommandTemplate: 'launcher -- agor-executor --stdin',
        tenantId: 'tenant-a',
        session: { agentic_tool: 'codex', created_by: 'owner-a' },
        homeDir: '/home/agor',
      })
    ).toBeUndefined();
    expect(executorEnv.CODEX_HOME).toBe('/external/runtime/home');
  });

  it('fails closed when a local simple Codex task has no trusted tenant or owner', () => {
    expect(() =>
      resolveSimpleCodexTaskHome({
        mode: 'simple',
        tenantId: undefined,
        session: { agentic_tool: 'codex', created_by: 'owner-a' },
        homeDir: '/home/agor',
      })
    ).toThrow(/tenant context/);
    expect(() =>
      resolveSimpleCodexTaskHome({
        mode: 'simple',
        tenantId: 'tenant-a',
        session: { agentic_tool: 'codex', created_by: '' },
        homeDir: '/home/agor',
      })
    ).toThrow(/session owner/);
  });
});
