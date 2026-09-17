import { type Message, MessageRole, type UserID, type UUID } from '@agor/core/types';
import { eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../../lib/ids';
import { JSON_SANITIZER_LIMITS } from '../../utils/sanitize-json';
import { createDatabase, type Database } from '../client';
import { executeRaw, select } from '../database-wrapper';
import { initializeDatabase } from '../migrate';
import { sanitizeDbError } from '../sanitize-error';
import { messages as messagesTable } from '../schema';
import { runWithTenantDatabaseScope } from '../tenant-scope';
import { setTestBranchUserRole } from '../test-helpers';
import { BranchRepository } from './branches';
import {
  MESSAGE_CONTENT_OMITTED,
  type MessageParentIntegrityError,
  MessagesRepository,
} from './messages';
import { RepoRepository } from './repos';
import { SessionRepository } from './sessions';
import { UsersRepository } from './users';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const describePostgres =
  postgresUrl && process.env.AGOR_DB_DIALECT === 'postgresql' ? describe : describe.skip;

describePostgres('MessagesRepository PostgreSQL Unicode persistence', () => {
  let db: Database;
  beforeAll(async () => {
    db = createDatabase({ url: postgresUrl!, dialect: 'postgresql' });
    await initializeDatabase(db);
  });

  it('reproduces PostgreSQL rejection without exposing the parameter in diagnostics', async () => {
    const actualNul = String.fromCharCode(0);
    const loneHighSurrogate = String.fromCharCode(0xd800);
    let failure: unknown;
    try {
      await executeRaw(
        db,
        sql`SELECT ${JSON.stringify({ content: `secret${actualNul}${loneHighSurrogate}` })}::jsonb`
      );
    } catch (error) {
      failure = error;
    }
    const diagnostic = sanitizeDbError(failure);
    expect(diagnostic).toMatchObject({ code: '22P05', message: 'Database operation failed' });
    expect(JSON.stringify(diagnostic)).not.toContain('secret');
  });

  it('round-trips sanitized create, update, and metadata mutation', async () => {
    const actualNul = String.fromCharCode(0);
    const loneHighSurrogate = String.fromCharCode(0xd800);
    const loneLowSurrogate = String.fromCharCode(0xdc00);
    await runWithTenantDatabaseScope(db, 'default', async (scoped) => {
      const owner = await new UsersRepository(scoped).create({
        email: `messages-owner-${generateId()}@example.invalid`,
        role: 'member',
      });
      const repos = new RepoRepository(scoped);
      const repo = await repos.create({
        slug: `nul-${generateId()}`,
        name: 'test',
        repo_type: 'remote',
        remote_url: 'https://example.invalid/repo.git',
        local_path: '/tmp/repo',
        default_branch: 'main',
      });
      const branch = await new BranchRepository(scoped).create({
        repo_id: repo.repo_id,
        name: 'test',
        path: '/tmp/test',
        ref: 'main',
        branch_unique_id: Math.floor(Math.random() * 1_000_000),
        created_by: owner.user_id as UUID,
      });
      const session = await new SessionRepository(scoped).create({
        branch_id: branch.branch_id,
        title: 'test',
        created_by: owner.user_id as UUID,
      });
      const repository = new MessagesRepository(scoped);
      const message = (index: number, content: string): Message => ({
        message_id: generateId(),
        session_id: session.session_id,
        type: 'assistant',
        role: MessageRole.ASSISTANT,
        index,
        timestamp: new Date().toISOString(),
        content_preview: content,
        content,
      });
      await expect(
        repository.create({
          ...message(99, 'invalid ID must not reach PostgreSQL'),
          message_id: `${generateId()}-overlength` as Message['message_id'],
        })
      ).rejects.toThrow('message_id must be a canonical full UUID');
      const first = await repository.create(message(0, `zip${actualNul}${loneHighSurrogate}😀`));
      const createdBeforePatch = await select(scoped, { created_at: messagesTable.created_at })
        .from(messagesTable)
        .where(eq(messagesTable.message_id, first.message_id))
        .one();
      expect(first.content).toBe('zip��😀');
      const second = await repository.create(message(1, `second${loneLowSurrogate}`));
      expect(second.content).toBe('second�');
      const finalized = await repository.update(first.message_id, {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'read-binary',
            content: `updated${actualNul}${loneHighSurrogate}`,
            provider_payload: { [`bad${actualNul}key`]: `value${loneLowSurrogate}` },
          },
        ] as Message['content'],
        content_preview: `updated${actualNul}`,
        tool_uses: [
          {
            id: 'read-binary',
            name: 'read',
            input: { [`path${actualNul}`]: `file${loneHighSurrogate}` },
          },
        ],
      });
      expect(finalized.content).toEqual([
        {
          type: 'tool_result',
          tool_use_id: 'read-binary',
          content: 'updated��',
          provider_payload: { 'bad�key': 'value�' },
        },
      ]);
      expect(finalized.content_preview).toBe('updated�');
      expect(finalized.tool_uses).toEqual([
        { id: 'read-binary', name: 'read', input: { 'path�': 'file�' } },
      ]);
      const createdAfterPatch = await select(scoped, { created_at: messagesTable.created_at })
        .from(messagesTable)
        .where(eq(messagesTable.message_id, first.message_id))
        .one();
      expect(createdAfterPatch?.created_at).toEqual(createdBeforePatch?.created_at);
      expect(
        (await repository.mutateMetadataLocked(first.message_id, () => ({ value: actualNul })))
          .message.metadata
      ).toEqual({ value: '�' });

      const oversized = new Array(JSON_SANITIZER_LIMITS.maxNodes).fill(null);
      const omitted = await repository.update(first.message_id, {
        content: oversized as Message['content'],
        content_preview: 'should not survive',
      });
      expect(omitted.content).toBe(MESSAGE_CONTENT_OMITTED);
      expect(omitted.content_preview).toBe(MESSAGE_CONTENT_OMITTED);
      expect(omitted.metadata).toEqual({ persistence_omission: { reason: 'size' } });
    });
  });

  it('keeps page count and RBAC visibility inside the active tenant scope', async () => {
    const viewerId = generateId() as UUID;
    const tenantA = `messages-page-a-${generateId()}`;
    const tenantB = `messages-page-b-${generateId()}`;
    let visibleSessionId: Message['session_id'] | undefined;

    await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
      const users = new UsersRepository(scoped);
      await users.create({
        user_id: viewerId,
        email: `${tenantA}@example.invalid`,
        name: 'Messages page viewer',
      });
      const owner = await users.create({
        email: `messages-page-owner-${generateId()}@example.invalid`,
        role: 'member',
      });
      const repo = await new RepoRepository(scoped).create({
        slug: `messages-page-${generateId()}`,
        name: 'Messages page',
        repo_type: 'remote',
        remote_url: 'https://example.invalid/messages-page.git',
        local_path: `/tmp/messages-page-${generateId()}`,
        default_branch: 'main',
      });
      const branches = new BranchRepository(scoped);
      const visibleBranch = await branches.create({
        repo_id: repo.repo_id,
        name: 'visible',
        path: `/tmp/messages-page-visible-${generateId()}`,
        ref: 'main',
        branch_unique_id: Math.floor(Math.random() * 1_000_000),
        created_by: owner.user_id as UUID,
        permission_source: 'override',
        others_can: 'none',
      });
      const hiddenBranch = await branches.create({
        repo_id: repo.repo_id,
        name: 'hidden',
        path: `/tmp/messages-page-hidden-${generateId()}`,
        ref: 'main',
        branch_unique_id: Math.floor(Math.random() * 1_000_000),
        created_by: owner.user_id as UUID,
        permission_source: 'override',
        others_can: 'none',
      });
      await setTestBranchUserRole(scoped, visibleBranch.branch_id, viewerId as UserID, 'manager');
      const sessions = new SessionRepository(scoped);
      const visibleSession = await sessions.create({
        branch_id: visibleBranch.branch_id,
        title: 'visible',
        created_by: owner.user_id as UUID,
      });
      const hiddenSession = await sessions.create({
        branch_id: hiddenBranch.branch_id,
        title: 'hidden',
        created_by: owner.user_id as UUID,
      });
      const messages = new MessagesRepository(scoped);
      const createMessage = (sessionId: Message['session_id'], index: number): Message => ({
        message_id: generateId(),
        session_id: sessionId,
        type: 'assistant',
        role: MessageRole.ASSISTANT,
        index,
        timestamp: new Date().toISOString(),
        content_preview: 'tenant-scoped message',
        content: 'tenant-scoped message',
      });
      await messages.create(createMessage(visibleSession.session_id, 0));
      await messages.create(createMessage(hiddenSession.session_id, 1));

      const page = await messages.findPage({ visibleToUserId: viewerId, limit: 10, skip: 0 });
      expect(page.total).toBe(1);
      expect(page.data.map((message) => message.session_id)).toEqual([visibleSession.session_id]);
      visibleSessionId = visibleSession.session_id;
    });

    await runWithTenantDatabaseScope(db, tenantB, async (scoped) => {
      const page = await new MessagesRepository(scoped).findPage({
        sessionId: visibleSessionId!,
        limit: 10,
        skip: 0,
      });
      expect(page).toMatchObject({ total: 0, data: [] });
    });
  });

  it('rejects a cross-tenant Session parent for a taskless create', async () => {
    const tenantA = `messages-parent-a-${generateId()}`;
    const tenantB = `messages-parent-b-${generateId()}`;
    let tenantBSessionId!: Message['session_id'];

    await runWithTenantDatabaseScope(db, tenantB, async (scoped) => {
      const owner = await new UsersRepository(scoped).create({
        email: `messages-parent-owner-${generateId()}@example.invalid`,
        role: 'member',
      });
      const repo = await new RepoRepository(scoped).create({
        slug: `messages-parent-${generateId()}`,
        name: 'Messages parent',
        repo_type: 'remote',
        remote_url: 'https://example.invalid/messages-parent.git',
        local_path: `/tmp/messages-parent-${generateId()}`,
        default_branch: 'main',
      });
      const branch = await new BranchRepository(scoped).create({
        repo_id: repo.repo_id,
        name: 'tenant-b',
        path: `/tmp/messages-parent-${generateId()}`,
        ref: 'main',
        branch_unique_id: Math.floor(Math.random() * 1_000_000),
        created_by: owner.user_id as UUID,
      });
      tenantBSessionId = (
        await new SessionRepository(scoped).create({
          branch_id: branch.branch_id,
          title: 'tenant-b',
          created_by: owner.user_id as UUID,
        })
      ).session_id;
    });

    const foreignMessage = (): Message => ({
      message_id: generateId(),
      session_id: tenantBSessionId,
      type: 'assistant',
      role: MessageRole.ASSISTANT,
      index: 0,
      timestamp: new Date().toISOString(),
      content_preview: 'must not cross tenants',
      content: 'must not cross tenants',
    });
    await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
      const repository = new MessagesRepository(scoped);
      await expect(repository.create(foreignMessage())).rejects.toMatchObject({
        reason: 'session_tenant_mismatch',
      } satisfies Partial<MessageParentIntegrityError>);
    });

    await runWithTenantDatabaseScope(db, tenantB, async (scoped) => {
      await expect(
        new MessagesRepository(scoped).findPage({ sessionId: tenantBSessionId, limit: 10 })
      ).resolves.toMatchObject({ total: 0, data: [] });
    });
  });
});

describePostgres('MessagesRepository Slack MCP connect due-work projection', () => {
  let db: Database;
  beforeAll(async () => {
    db = createDatabase({ url: postgresUrl!, dialect: 'postgresql' });
    await initializeDatabase(db);
  });

  /**
   * The indexed column and the JSON it projects must never disagree, and the
   * bounded sweep must never reach into another tenant. Both are properties of
   * real SQL against a real schema — the exact shape a `:memory:` unit test
   * cannot see, which is how the two worst bugs in this lane were found.
   */
  it('mirrors the repair time out of the widget metadata and keeps the sweep tenant-local', async () => {
    const tenantA = `connect-due-a-${generateId()}`;
    const tenantB = `connect-due-b-${generateId()}`;
    const now = new Date('2026-09-16T12:00:00.000Z');
    const seed = async (scoped: Database, dueAt: string | undefined) => {
      const owner = await new UsersRepository(scoped).create({
        email: `connect-due-${generateId()}@example.invalid`,
        role: 'member',
      });
      const repo = await new RepoRepository(scoped).create({
        slug: `connect-due-${generateId()}`,
        name: 'Connect due',
        repo_type: 'remote',
        remote_url: 'https://example.invalid/connect-due.git',
        local_path: `/tmp/connect-due-${generateId()}`,
        default_branch: 'main',
      });
      const branch = await new BranchRepository(scoped).create({
        repo_id: repo.repo_id,
        name: 'connect-due',
        path: `/tmp/connect-due-${generateId()}`,
        ref: 'main',
        branch_unique_id: Math.floor(Math.random() * 1_000_000),
        created_by: owner.user_id as UUID,
      });
      const session = await new SessionRepository(scoped).create({
        branch_id: branch.branch_id,
        title: 'connect-due',
        created_by: owner.user_id as UUID,
      });
      const repository = new MessagesRepository(scoped);
      const created = await repository.create({
        message_id: generateId(),
        session_id: session.session_id,
        type: 'widget_request',
        role: MessageRole.SYSTEM,
        index: 0,
        timestamp: now.toISOString(),
        content_preview: 'Widget: oauth (Notion)',
        content: 'Connect "Notion"',
      });
      if (dueAt) {
        await repository.mutateMetadataLocked(created.message_id, () => ({
          widget: {
            widget_type: 'oauth',
            widget_id: created.message_id,
            schema_version: 1,
            status: 'pending',
            requested_at: now.toISOString(),
            params: {},
            slack_connect: {
              delivery_id: 'delivery-1',
              delivery_generation: 1,
              token_jti: 'jti-1',
              issued_at: now.toISOString(),
              expires_at: new Date(now.getTime() + 600_000).toISOString(),
              next_repair_at: dueAt,
            },
          },
        }));
      }
      return { repository, messageId: created.message_id };
    };

    let dueId: Message['message_id'] | undefined;
    await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
      const due = await seed(scoped, new Date(now.getTime() - 60_000).toISOString());
      dueId = due.messageId;
      // Not yet due.
      await seed(scoped, new Date(now.getTime() + 60_000).toISOString());
      // Abandoned long before the horizon; the sweep must not carry it forever.
      await seed(scoped, new Date(now.getTime() - 48 * 60 * 60_000).toISOString());
      // Never Slack-delivered at all: the overwhelming majority of rows.
      await seed(scoped, undefined);

      const page = await due.repository.findMcpSlackConnectDuePage({ now });
      expect(page.messages.map((message) => message.message_id)).toEqual([dueId]);

      // Clearing the repair time clears the column in the same write, so the
      // sweep cannot keep finding a card that has nothing left to do.
      await due.repository.mutateMetadataLocked(dueId!, (metadata) => ({
        ...metadata,
        widget: {
          ...metadata!.widget!,
          slack_connect: { ...metadata!.widget!.slack_connect!, next_repair_at: undefined },
        },
      }));
      expect((await due.repository.findMcpSlackConnectDuePage({ now })).messages).toEqual([]);
    });

    await runWithTenantDatabaseScope(db, tenantB, async (scoped) => {
      await seed(scoped, new Date(now.getTime() - 60_000).toISOString());
      const page = await new MessagesRepository(scoped).findMcpSlackConnectDuePage({ now });
      expect(page.messages.map((message) => message.message_id)).not.toContain(dueId);
      expect(page.messages).toHaveLength(1);
    });

    await expect(
      runWithTenantDatabaseScope(db, tenantA, async (scoped) =>
        new MessagesRepository(scoped).findMcpSlackConnectDuePage({ limit: 0 })
      )
    ).rejects.toThrow(/between 1 and 100/);
  });
});
