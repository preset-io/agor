/**
 * Gateway outbound routing addresses a Task, not a Session (SQLite).
 *
 * `gateway-reply-routing.postgres.test.ts` runs the same scenarios against
 * PostgreSQL. Both lanes exist because the read this replaces was a different
 * statement on each engine — `.get()` here, an unordered `LIMIT 1` there — so
 * a green SQLite run said nothing about the deployed one.
 *
 * Verified to fail without the fix: restoring
 * `this.threadMapRepo.findBySession(...)` in place of `resolveOutboundMapping`
 * sends the DM answer into the public thread on both engines.
 */

import { describe, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
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

describe('gateway reply routing is task-scoped (SQLite)', () => {
  for (const scenario of replyRoutingScenarios) {
    dbTest(scenario.name, async ({ db }) => {
      await scenario.run(db, sends);
    });
  }
});
