import { readFileSync } from 'node:fs';
import { feathers } from '@agor/core/feathers';
import type { HookContext } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { redactUserOwnerOnlyFieldsForBroadcast } from './register-hooks';

/**
 * `users` is a tenant-wide realtime fan-out path, and `rowToUser` decides one
 * of its fields PER REQUESTER: `agentic_tools_public_values` holds decrypted
 * plaintext and is populated only when `requesterId === row.user_id`
 * (`services/users.ts`). A self-patch satisfies that, so without redaction the
 * `patched` broadcast hands every other socket in the tenant a value that
 * `GET /users/:id` deliberately returns as `undefined` for them.
 *
 * These drive the real hook through real Feathers hook composition and the
 * real transport payload rule, so a change to any of the three fails here.
 */

const OWNER_ONLY = {
  'claude-code': { ANTHROPIC_BASE_URL: 'https://llm.internal.corp.example/v1' },
};

const ownerRow = () => ({
  user_id: 'u-owner',
  email: 'owner@example.com',
  name: 'Owner',
  agentic_tools_public_values: structuredClone(OWNER_ONLY),
});

/**
 * What a socket other than the caller actually receives. Mirrors
 * `getDispatcher` in `@feathersjs/transport-commons`: `channel.dataFor()`, then
 * `context.dispatch`, then `context.result`.
 */
function broadcastPayload(context: Partial<HookContext>): unknown {
  return context.dispatch !== undefined ? context.dispatch : context.result;
}

describe('users owner-only field redaction', () => {
  it('keeps the decrypted value in the result the caller gets', async () => {
    const context = { event: 'patched', result: ownerRow() } as unknown as HookContext;

    await redactUserOwnerOnlyFieldsForBroadcast(context);

    // The caller IS the owner — they asked for their own value and keep it.
    expect((context.result as Record<string, unknown>).agentic_tools_public_values).toEqual(
      OWNER_ONLY
    );
  });

  it('strips the decrypted value from what every other socket receives', async () => {
    const context = { event: 'patched', result: ownerRow() } as unknown as HookContext;

    await redactUserOwnerOnlyFieldsForBroadcast(context);

    const broadcast = broadcastPayload(context) as Record<string, unknown>;
    expect(broadcast).not.toHaveProperty('agentic_tools_public_values');
    expect(JSON.stringify(broadcast)).not.toContain('llm.internal.corp.example');
    // Redaction must not gut the directory entry the broadcast exists to carry.
    expect(broadcast.user_id).toBe('u-owner');
    expect(broadcast.email).toBe('owner@example.com');
    expect(broadcast.name).toBe('Owner');
  });

  it.each(['created', 'updated', 'patched', 'removed'])(
    'redacts the %s broadcast, not just patched',
    async (event) => {
      const context = { event, result: ownerRow() } as unknown as HookContext;

      await redactUserOwnerOnlyFieldsForBroadcast(context);

      expect(broadcastPayload(context)).not.toHaveProperty('agentic_tools_public_values');
    }
  );

  it('leaves find/get alone so the owner can still read their own value', async () => {
    // `context.event` is null for find/get — those broadcast nothing, and a
    // redacted dispatch there would only strip the value out of the owner's own
    // socket reads.
    const context = { event: null, result: ownerRow() } as unknown as HookContext;

    await redactUserOwnerOnlyFieldsForBroadcast(context);

    expect(context.dispatch).toBeUndefined();
    expect((context.result as Record<string, unknown>).agentic_tools_public_values).toEqual(
      OWNER_ONLY
    );
  });

  it.each([
    ['a list result', () => [ownerRow(), ownerRow()]],
    ['a paginated result', () => ({ total: 2, data: [ownerRow(), ownerRow()] })],
  ])('redacts %s', async (_label, build) => {
    const context = { event: 'patched', result: build() } as unknown as HookContext;

    await redactUserOwnerOnlyFieldsForBroadcast(context);

    expect(JSON.stringify(broadcastPayload(context))).not.toContain('llm.internal.corp.example');
  });

  it('passes through a row that never had the field', async () => {
    const context = {
      event: 'patched',
      result: { user_id: 'u-other', email: 'other@example.com' },
    } as unknown as HookContext;

    await redactUserOwnerOnlyFieldsForBroadcast(context);

    expect(broadcastPayload(context)).toEqual({
      user_id: 'u-other',
      email: 'other@example.com',
    });
  });
});

describe('users redaction under real Feathers hook composition', () => {
  /**
   * The hook body being right is not enough — it has to actually run, last,
   * on the event-emitting methods. This stands up a real Feathers app with the
   * real hook registered the way `registerHooks` registers it (`after.all`,
   * alongside a method-specific `after.patch` standing in for the avatar hook)
   * and reads the context off the service event emit — the same
   * `(data, context)` pair `@feathersjs/transport-commons` hands the publisher.
   */
  async function patchThroughRealFeathers() {
    const app = feathers();
    let broadcast: unknown;

    app.use('users', {
      async patch(_id: string, _data: unknown) {
        // Stands in for rowToUser with requesterId === row.user_id.
        return ownerRow();
      },
    } as never);

    app.service('users').hooks({
      after: {
        all: [redactUserOwnerOnlyFieldsForBroadcast],
        // Listed after `all` in source order but composed INNER by Feathers,
        // so this must not be able to reinstate the field on the broadcast.
        patch: [
          (context: HookContext) => {
            (context.result as Record<string, unknown>).agentic_tools_public_values =
              structuredClone(OWNER_ONLY);
            return context;
          },
        ],
      },
    } as never);

    app.service('users').on('patched', (_data: unknown, context: HookContext) => {
      broadcast = broadcastPayload(context);
    });

    await app.service('users').patch('u-owner', { name: 'Owner' } as never);
    return broadcast;
  }

  it('redacts the broadcast even when a later after-hook re-adds the field', async () => {
    const published = await patchThroughRealFeathers();

    expect(published).toBeDefined();
    expect(published).not.toHaveProperty('agentic_tools_public_values');
    expect(JSON.stringify(published)).not.toContain('llm.internal.corp.example');
  });
});

describe('users redaction wiring', () => {
  const source = readFileSync(new URL('./register-hooks.ts', import.meta.url), 'utf8');

  it('registers the redaction on the users service', () => {
    // Behaviour tests above cover the hook itself; this pins that it is
    // actually attached, and attached to `all` rather than a method list —
    // the omission that let mcp-servers `remove` broadcast unredacted (#2374).
    const start = source.indexOf("app.service('users').hooks({");
    expect(start, 'users hooks block not found').toBeGreaterThan(-1);
    // Bound the block at the next service registration rather than the first
    // `});`, which closes a nested hook long before the block ends.
    const next = source.indexOf("app.service('", start + 1);
    const block = source.slice(start, next > -1 ? next : undefined);
    const afterBlock = block.slice(block.indexOf('after:'));
    expect(afterBlock).toMatch(/all:\s*\[redactUserOwnerOnlyFieldsForBroadcast\]/);
  });
});
