import {
  BranchRepository,
  generateId,
  RepoRepository,
  SessionRepository,
  shortId,
  UsersRepository,
} from '@agor/core/db';
import { feathers } from '@agor/core/feathers';
import type { Application, HookContext, SessionID } from '@agor/core/types';
import { ROLES, SessionStatus } from '@agor/core/types';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { ensureCanView, loadSessionBranch } from '../utils/branch-authorization.js';
import { SessionsService } from './sessions.js';

describe('sessions.get authorization loading', () => {
  beforeEach(() => vi.stubEnv('AGOR_BASE_URL', 'http://agor.test'));
  afterEach(() => vi.unstubAllEnvs());

  dbTest(
    'reduces an external get from two Feathers invocations/relationship reads to one',
    async ({ db }) => {
      const user = await new UsersRepository(db).create({
        email: `${generateId()}@example.invalid`,
        name: 'Session get authorization receipt',
      });
      const repo = await new RepoRepository(db).create({
        repo_id: generateId(),
        slug: `session-get-auth-${generateId()}`,
        name: 'Session get authorization receipt',
        repo_type: 'remote',
        remote_url: 'https://example.invalid/session-get-auth.git',
        local_path: `/tmp/${generateId()}`,
        default_branch: 'main',
      });
      const branch = await new BranchRepository(db).create({
        branch_id: generateId(),
        repo_id: repo.repo_id,
        name: `session-get-auth-${generateId()}`,
        ref: 'main',
        branch_unique_id: 8_660_000,
        path: `/tmp/${generateId()}`,
        created_by: user.user_id,
      });
      const session = await new SessionRepository(db).create({
        session_id: generateId(),
        branch_id: branch.branch_id,
        agentic_tool: 'claude-code',
        status: SessionStatus.IDLE,
        created_by: user.user_id,
        tasks: [],
        contextFiles: [],
        genealogy: { children: [] },
      });

      const params = {
        provider: 'rest',
        user: { user_id: user.user_id, role: ROLES.MEMBER },
      } as never;
      const shortSessionId = shortId(session.session_id) as SessionID;

      const createRegisteredService = () => {
        const app = feathers();
        const service = new SessionsService(db, app as unknown as Application);
        app.use('sessions', service as never, { methods: ['get'] });
        let wrappedGets = 0;
        const relationshipReads = vi.spyOn(
          (
            service as unknown as {
              sessionRelationshipRepo: { findForSessions(ids: SessionID[]): Promise<unknown[]> };
            }
          ).sessionRelationshipRepo,
          'findForSessions'
        );
        app.service('sessions').hooks({
          around: {
            get: [
              async (_context, next) => {
                wrappedGets += 1;
                await next();
              },
            ],
          },
        });
        return { app, relationshipReads, wrappedGets: () => wrappedGets };
      };

      // Deployed pre-fix shape: the external authorization hook recursively
      // called the registered sessions.get with provider undefined. The outer
      // service reused that row, but both service bodies enriched relationships.
      const before = createRegisteredService();
      before.app.service('sessions').hooks({
        before: {
          get: [
            async (context: HookContext) => {
              if (!context.params.provider) return context;
              const loaded = await context.service.get(context.id, { provider: undefined });
              context.id = loaded.session_id;
              (
                context.params as typeof context.params & {
                  _agorPrefetchedRecord?: unknown;
                }
              )._agorPrefetchedRecord = {
                id: loaded.session_id,
                idField: 'session_id',
                record: loaded,
              };
              return context;
            },
          ],
        },
      });
      await before.app.service('sessions').get(shortSessionId, params);
      expect(before.wrappedGets()).toBe(2);
      expect(before.relationshipReads).toHaveBeenCalledTimes(2);

      // New shape: one tenant-scoped repository read authorizes the branch and
      // is passed to the outer service, whose enrichment runs exactly once.
      const after = createRegisteredService();
      const authSessions = new SessionRepository(db);
      const authFind = vi.spyOn(authSessions, 'findById');
      after.app.service('sessions').hooks({
        before: {
          get: [loadSessionBranch(authSessions, new BranchRepository(db)), ensureCanView()],
        },
      });
      const result = await after.app.service('sessions').get(shortSessionId, params);

      expect(result.session_id).toBe(session.session_id);
      expect(authFind).toHaveBeenCalledTimes(1);
      expect(after.wrappedGets()).toBe(1);
      expect(after.relationshipReads).toHaveBeenCalledTimes(1);
    }
  );
});
