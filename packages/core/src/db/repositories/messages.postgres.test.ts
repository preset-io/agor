import { type Message, MessageRole, type UUID } from '@agor/core/types';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../../lib/ids';
import { createDatabase, type Database } from '../client';
import { executeRaw } from '../database-wrapper';
import { initializeDatabase } from '../migrate';
import { sanitizeDbError } from '../sanitize-error';
import { runWithTenantDatabaseScope } from '../tenant-scope';
import { BranchRepository } from './branches';
import { MessagesRepository } from './messages';
import { RepoRepository } from './repos';
import { SessionRepository } from './sessions';

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

  it('round-trips sanitized create, bulk create, update, and metadata mutation', async () => {
    const actualNul = String.fromCharCode(0);
    const loneHighSurrogate = String.fromCharCode(0xd800);
    const loneLowSurrogate = String.fromCharCode(0xdc00);
    await runWithTenantDatabaseScope(db, 'default', async (scoped) => {
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
        created_by: generateId() as UUID,
      });
      const sessions = new SessionRepository(scoped);
      const session = await sessions.create({
        branch_id: branch.branch_id,
        title: 'test',
        created_by: generateId() as UUID,
      });
      await sessions.update(session.session_id, {
        custom_context: { provider_payload: `value${actualNul}${loneHighSurrogate}` },
      });
      expect((await sessions.findById(session.session_id))?.custom_context).toEqual({
        provider_payload: 'value��',
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
      const first = await repository.create(message(0, `zip${actualNul}${loneHighSurrogate}😀`));
      expect(first.content).toBe('zip��😀');
      const [second] = await repository.createMany([message(1, `bulk${loneLowSurrogate}`)]);
      expect(second.content).toBe('bulk�');
      const finalized = await repository.update(first.message_id, {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'read-binary',
            content: `updated${actualNul}${loneHighSurrogate}`,
          },
        ] as Message['content'],
        content_preview: `updated${actualNul}`,
      });
      expect(finalized.content).toEqual([
        { type: 'tool_result', tool_use_id: 'read-binary', content: 'updated��' },
      ]);
      expect(finalized.content_preview).toBe('updated�');
      expect(
        (await repository.mutateMetadataLocked(first.message_id, () => ({ value: actualNul })))
          .message.metadata
      ).toEqual({ value: '�' });
    });
  });
});
