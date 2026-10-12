/**
 * Gateway outbound routing addresses a Task, not a Session (PostgreSQL).
 *
 * The same scenarios as `gateway-reply-routing.test.ts`, on the engine where
 * the replaced read was an unordered `LIMIT 1` rather than SQLite's `.get()`.
 * Each scenario seeds its own channel, session and mappings, so the suite can
 * share one database without sharing state between cases.
 */

import { createDatabase, type Database, initializeDatabase } from '@agor/core/db';
import { afterAll, beforeAll, describe, it, vi } from 'vitest';
import { type RecordedSend, replyRoutingScenarios } from '../../test/gateway-reply-routing-fixture';

const { sends } = vi.hoisted(() => ({ sends: [] as RecordedSend[] }));

vi.mock('@agor/core/gateway', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/gateway')>();
  return {
    ...actual,
    getConnector: vi.fn(() => ({
      channelType: 'slack' as const,
      sendMessage: async (request: { threadId: string; text: string }) => {
        sends.push({ threadId: request.threadId, text: request.text });
        return `sent-${sends.length}`;
      },
    })),
  };
});

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;

describe.skipIf(!postgresUrl || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'gateway reply routing is task-scoped (PostgreSQL)',
  () => {
    let db: Database;

    beforeAll(async () => {
      process.env.AGOR_MASTER_SECRET ||= 'gateway-reply-routing-test-secret';
      db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(db);
    });

    afterAll(async () => {
      if (db) await (db as Database & { $client: { end(): Promise<void> } }).$client.end();
    });

    for (const scenario of replyRoutingScenarios) {
      it(scenario.name, async () => {
        await scenario.run(db, sends);
      });
    }
  }
);
