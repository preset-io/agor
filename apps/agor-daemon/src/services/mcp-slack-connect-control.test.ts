/**
 * The kill switch as an operator would work it, against real rows.
 *
 * §7.1.4 promised an operator control before a default-on rollout, and what
 * existed was a setter with no caller. The procedure this pins is the whole
 * requirement: read the setting for an explicit tenant, change it, verify it
 * took effect, do the same for the next tenant, and put it back.
 *
 * The role floors live on the registration rather than in the handler, so
 * those are read off `register-routes.ts` the way the MCP member policy's are.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AppVariableRepository,
  createDatabaseAsync,
  isMCPSlackConnectCardEnabled,
  MCP_SLACK_CONNECT_CARD_KEY,
  MCP_SLACK_CONNECT_SETTINGS_NAMESPACE,
  runMigrations,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import { describe, expect, it } from 'vitest';
import { createMCPSlackConnectCardControl } from './mcp-slack-connect-control.js';

async function control() {
  const rawDb = await createDatabaseAsync({ dialect: 'sqlite', url: ':memory:' });
  await runMigrations(rawDb);
  const db = rawDb as unknown as TenantScopeAwareDatabase;
  // A real actor: the setting records who changed it, which is half of what
  // makes the switch auditable.
  const actor = await new UsersRepository(rawDb).create({
    email: 'operator@agor.live',
    role: 'admin',
  });
  const operator = { tenant: { tenant_id: 'tenant-a' }, user: { user_id: actor.user_id } };
  return { db, rawDb, operator, control: createMCPSlackConnectCardControl(db) };
}

describe('the Slack MCP connect card switch, as an operator uses it', () => {
  it('reads on, turns off, and verifies from the predicate the lane itself calls', async () => {
    const { db, operator, control: card } = await control();

    // 1. Read. On by default — the card is additive to a link that still
    //    works, so it ships on (§7.1.4).
    expect(await card.find(operator)).toEqual({ tenant_id: 'tenant-a', enabled: true });

    // 2. Change, and 3. verify. The answer is a re-read, not an echo of the
    //    request, so a write that silently did not land cannot report success.
    expect(await card.patch(null, { enabled: false }, operator)).toEqual({
      tenant_id: 'tenant-a',
      enabled: false,
    });
    expect(await isMCPSlackConnectCardEnabled(db)).toBe(false);

    // 4. Restore.
    expect(await card.patch(null, { enabled: true }, operator)).toEqual({
      tenant_id: 'tenant-a',
      enabled: true,
    });
    expect(await isMCPSlackConnectCardEnabled(db)).toBe(true);
  });

  it('names the tenant it acted on, because a fleet-wide incident is one write per tenant', async () => {
    const { operator, control: card } = await control();
    expect(await card.patch(null, { enabled: false }, operator)).toMatchObject({
      tenant_id: 'tenant-a',
    });
    expect(
      await card.patch(null, { enabled: false }, { ...operator, tenant: { tenant_id: 'tenant-b' } })
    ).toMatchObject({ tenant_id: 'tenant-b' });
  });

  it('refuses anything that is not a boolean rather than writing a value nobody recognises', async () => {
    const { db, operator, control: card } = await control();
    for (const enabled of ['off', 'false', 0, null, undefined]) {
      await expect(card.patch(null, { enabled } as { enabled: unknown }, operator)).rejects.toThrow(
        /enabled must be true or false/
      );
    }
    // An unrecognised stored value leaves the card ON, deliberately — so the
    // one writer in the product must not be able to create one.
    expect(await isMCPSlackConnectCardEnabled(db)).toBe(true);
  });

  it('reports a card an unrecognised stored value left on, rather than guessing', async () => {
    const { rawDb, operator, control: card } = await control();
    await new AppVariableRepository(rawDb).set({
      namespace: MCP_SLACK_CONNECT_SETTINGS_NAMESPACE,
      key: MCP_SLACK_CONNECT_CARD_KEY,
      value: 'disbaled',
      content_type: 'text/plain',
    });
    // The read an operator does BEFORE reaching for the switch has to show the
    // same thing the lane sees, typo and all, or the typo is invisible until
    // the incident.
    expect(await card.find(operator)).toEqual({ tenant_id: 'tenant-a', enabled: true });
  });
});

describe('the switch, as it is registered', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'register-routes.ts'),
    'utf8'
  );
  const registration = source.slice(
    source.indexOf("'/mcp-slack-connect/card'"),
    source.indexOf('MCP marketplace connect')
  );

  it('keeps both the read and the write to admins', () => {
    // Unlike `/mcp-egress/status`, nothing this answers is about the caller's
    // own capabilities, so there is no answer a non-admin needs.
    expect(registration).toContain(
      "find: { role: ROLES.ADMIN, action: 'read the Slack MCP connect card switch' }"
    );
    expect(registration).toContain(
      "patch: { role: ROLES.ADMIN, action: 'change the Slack MCP connect card switch' }"
    );
  });

  it('is registered through the tenant-scoped registrar', () => {
    // `registerAuthenticatedRoute` in this file is the tenant-scoped one
    // (`createTenantScopedAuthenticatedRouteRegistrar`), which is what arms
    // the database scope these repository reads need.
    expect(source).toContain(
      'const registerAuthenticatedRoute = createTenantScopedAuthenticatedRouteRegistrar('
    );
    expect(registration).toContain('createMCPSlackConnectCardControl(db)');
  });
});
