import { describe, expect, it } from 'vitest';
import { executorLogContext } from './log-context.js';

function segment(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function token(claims: Record<string, unknown>): string {
  return `${segment({ alg: 'HS256', typ: 'JWT' })}.${segment(claims)}.not-a-real-signature`;
}

const claims = {
  sub: 'user-1',
  tenant_id: 'tenant-1',
  branch_id: 'branch-1',
  session_id: 'session-from-token',
  task_id: 'task-from-token',
};

describe('executorLogContext', () => {
  it('reads claims from the session token', () => {
    expect(executorLogContext({ sessionToken: token(claims) })).toEqual({
      tenant_id: 'tenant-1',
      user_id: 'user-1',
      branch_id: 'branch-1',
      session_id: 'session-from-token',
      task_id: 'task-from-token',
    });
  });

  it('prefers payload IDs over claims', () => {
    expect(
      executorLogContext({
        sessionToken: token(claims),
        params: { sessionId: 'session-from-payload', taskId: 'task-from-payload' },
      })
    ).toMatchObject({ session_id: 'session-from-payload', task_id: 'task-from-payload' });
  });

  it('returns no claims for a malformed or two-segment token without throwing', () => {
    expect(executorLogContext({ sessionToken: 'not-a-jwt' })).toEqual({});
    expect(executorLogContext({ sessionToken: `${segment(claims)}.sig` })).toEqual({});
    expect(executorLogContext({ sessionToken: 'a.!!!.c' })).toEqual({});
    expect(executorLogContext({ sessionToken: `a.${segment(['x'])}.c` })).toEqual({});
    expect(executorLogContext({})).toEqual({});
  });

  it('never contains the token', () => {
    const sessionToken = token(claims);
    const serialized = JSON.stringify(executorLogContext({ sessionToken }));
    expect(serialized).not.toContain(sessionToken);
    expect(serialized).not.toContain('not-a-real-signature');
    expect(serialized).not.toContain(sessionToken.split('.')[1]);
  });
});
