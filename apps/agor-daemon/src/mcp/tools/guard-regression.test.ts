import {
  createTenantScopedDatabaseProxy,
  runWithTenantContext,
  runWithTenantDatabaseScope,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { expect } from 'vitest';
import { dbTest } from '../../../../../packages/core/src/db/test-helpers';
import { CardsService } from '../../services/cards.js';
import { SessionsService } from '../../services/sessions.js';

/**
 * Deliverable A3 — prove the armed guard, exercised through a REAL guarded
 * SQLite proxy (not the old `db: {}` stub + mocked services), would have caught
 * the two pre-#2612 misses in their OWN unit environment.
 *
 * Both `agor_cards_get` and `agor_sessions_archive` used to call a custom
 * (non-transport) service method DIRECTLY from the MCP tool handler. The MCP
 * tool boundary (`tenantScopedToolProxy`) enters tenant *context* only — never a
 * DB scope. Cards still needs the transport wrapper; archive now establishes
 * its own service-side scope before touching the database.
 *
 * These tests reproduce the exact boundary (tenant context, no DB scope) over a
 * real guarded proxy and assert that cards fails until externally scoped while
 * archive self-scopes and reaches the ordinary database result.
 *
 * No rows are seeded: even a lookup for a missing id issues a SELECT against the
 * guarded proxy, which is enough to trip the scope guard.
 */

dbTest(
  'guarded harness would catch the pre-fix unscoped agor_cards_get (cardsService.getWithType)',
  async ({ db }) => {
    const guardedDb = createTenantScopedDatabaseProxy(db, { label: 'guarded MCP test database' });
    const cardsService = new CardsService(guardedDb);

    // Reproduce the MCP tool boundary: tenant identity is ambient, but no tenant
    // DATABASE scope is active — exactly what `tenantScopedToolProxy` provides.
    await runWithTenantContext('tenant-a', async () => {
      // PRE-FIX agor_cards_get: called getWithType directly, unscoped. The
      // repository wraps the guard error, so assert on its stable message.
      await expect(cardsService.getWithType('card-missing' as never)).rejects.toThrow(
        /Missing tenant database scope/
      );

      // POST-FIX / Stage-B: the same call inside a tenant DB scope reaches the
      // DB and returns null for a missing card — the guard is satisfied.
      const result = await runWithTenantDatabaseScope(guardedDb, 'tenant-a', () =>
        cardsService.getWithType('card-missing' as never)
      );
      expect(result).toBeNull();
    });
  }
);

dbTest('agor_sessions_archive self-scopes when only tenant context is present', async ({ db }) => {
  const guardedDb = createTenantScopedDatabaseProxy(db, { label: 'guarded MCP test database' });
  // setArchiveStateForTree touches the DB (this.get) before any app.service
  // use, so a stub application suffices for this scope-presence proof.
  const app = {
    service: () => {
      throw new Error('unexpected app.service use in scope-presence proof');
    },
  } as unknown as Application;
  const sessionsService = new SessionsService(guardedDb, app);

  await runWithTenantContext('tenant-a', async () => {
    await expect(sessionsService.archive('session-missing')).rejects.toThrow(/not found/i);
  });
});
