import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Session } from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { authorizeMcpSessionConfigAccess } from './mcp-session-config-authorization.js';

const session = {
  session_id: 'session-owner' as Session['session_id'],
  created_by: 'owner' as Session['created_by'],
};
const collaborator = { user_id: 'collaborator', role: ROLES.MEMBER };
const exactExecutor = {
  sessionId: session.session_id,
  taskId: 'task-collaborator',
};

describe('authorizeMcpSessionConfigAccess', () => {
  it('allows an exact active executor only for the projection path', () => {
    expect(() =>
      authorizeMcpSessionConfigAccess({
        user: collaborator,
        session,
        executorScope: exactExecutor,
        operation: 'projection',
      })
    ).not.toThrow();
  });

  it.each(['attach', 'detach', 'bulk update', 'session initialization'])(
    'rejects a non-owner collaborator executor attempting %s',
    () => {
      expect(() =>
        authorizeMcpSessionConfigAccess({
          user: collaborator,
          session,
          executorScope: exactExecutor,
          operation: 'mutation',
        })
      ).toThrow(/cannot mutate MCP session configuration/);
    }
  );

  it('rejects projection for an executor scoped to another Session', () => {
    expect(() =>
      authorizeMcpSessionConfigAccess({
        user: collaborator,
        session,
        executorScope: { ...exactExecutor, sessionId: 'session-stale' },
        operation: 'projection',
      })
    ).toThrow(/only for their exact Session/);
  });

  it('rejects an ordinary non-owner collaborator on mutation', () => {
    expect(() =>
      authorizeMcpSessionConfigAccess({
        user: collaborator,
        session,
        executorScope: null,
        operation: 'mutation',
      })
    ).toThrow(/Only the session's creator or an admin/);
  });

  it('keeps every attachment and initialization mutation on the mutation guard', () => {
    const source = readFileSync(join(__dirname, '../register-routes.ts'), 'utf8');
    const attachmentStart = source.indexOf("'/sessions/:id/mcp-servers'");
    const attachmentEnd = source.indexOf('const mcpRefreshAttempts', attachmentStart);
    const attachmentRoute = source.slice(attachmentStart, attachmentEnd);
    const initializationStart = source.indexOf("'/sessions/:id/initialize'");
    const initializationEnd = source.indexOf('// Health endpoint', initializationStart);
    const initializationRoute = source.slice(initializationStart, initializationEnd);

    expect(attachmentStart).toBeGreaterThan(0);
    expect(
      attachmentRoute.match(/authorizeAndLoadSessionForMcpConfig\(id, params\);/g)
    ).toHaveLength(4);
    expect(attachmentRoute.match(/allowExecutorProjection: true/g)).toHaveLength(1);
    expect(initializationStart).toBeGreaterThan(0);
    expect(initializationRoute).toContain('authorizeAndLoadSessionForMcpConfig(id, params)');
    expect(initializationRoute).not.toContain('allowExecutorProjection');
  });
});
