import { eq, sql } from 'drizzle-orm';
import { expect } from 'vitest';
import { generateId } from '../lib/ids';
import { BRANCH_DELETION_BATCH_SIZE, deleteBranchDataBatch } from './branch-deletion-data';
import type { Database } from './client';
import { executeRaw, insert, rawRows, select } from './database-wrapper';
import { BranchMaintenanceRepository } from './repositories/branch-maintenance';
import { BranchRepository } from './repositories/branches';
import { seedEnvironmentCommandBranch } from './repositories/environment-commands.test-support';
import { SessionRepository } from './repositories/sessions';
import {
  gatewayChannels,
  messages,
  teamsConversationAddresses,
  teamsMessageDeliveries,
  threadSessionMap,
} from './schema';

export async function seedTeamsDeletionHome(db: Database) {
  const { branch, user } = await seedEnvironmentCommandBranch(db);
  await new BranchRepository(db).update(branch.branch_id, {
    path: `/tmp/teams-delete-${branch.branch_id}`,
  });
  const session = await new SessionRepository(db).create({
    branch_id: branch.branch_id,
    created_by: user.user_id,
  });
  const channel = generateId();
  const mapping = generateId();
  const message = generateId();
  const now = new Date();
  // Inert persisted fixtures: no connector, credential decryption or external effect.
  await insert(db, gatewayChannels)
    .values({
      id: channel,
      created_at: now,
      updated_at: now,
      created_by: user.user_id,
      name: 'Teams deletion',
      channel_type: 'teams',
      target_branch_id: branch.branch_id,
      channel_key: channel,
      enabled: false,
      config: {},
    })
    .run();
  await insert(db, threadSessionMap)
    .values({
      id: mapping,
      created_at: now,
      last_message_at: now,
      channel_id: channel,
      thread_id: mapping,
      session_id: session.session_id,
      branch_id: branch.branch_id,
    })
    .run();
  await insert(db, messages)
    .values({
      message_id: message,
      created_at: now,
      timestamp: now,
      session_id: session.session_id,
      type: 'assistant',
      role: 'assistant',
      index: 0,
      data: { content: 'retained neighbor' },
    })
    .run();
  return { branch, session, channel, mapping, message };
}

async function delivery(db: Database, message: string, channel: string, mapping: string) {
  const id = generateId();
  await insert(db, teamsMessageDeliveries)
    .values({
      delivery_id: id,
      created_at: new Date(),
      updated_at: new Date(),
      message_id: message,
      gateway_channel_id: channel,
      thread_session_map_id: mapping,
      provider_installation_id: 'test-app',
      provider_config_generation: 1,
      status: 'completed',
      next_attempt_at: new Date(),
    })
    .run();
  return id;
}

async function address(db: Database, channel: string) {
  const id = generateId();
  await insert(db, teamsConversationAddresses)
    .values({
      address_id: id,
      gateway_channel_id: channel,
      thread_id: id,
      conversation_id: id,
      encrypted_address: 'inert-ciphertext',
      verified_app_id: 'test-app',
      verified_tenant_id: 'test-entra',
      provider_config_generation: 1,
      refreshed_at: new Date(),
    })
    .run();
  return id;
}

type WithDatabase = <T>(work: (db: Database) => Promise<T>) => Promise<T>;

/** Each deletion batch gets its own normal maintenance transaction/tenant unit. */
export async function proveBoundedTeamsCleanup(withDb: WithDatabase) {
  const fixture = await withDb(async (db) => {
    const owned = await seedTeamsDeletionHome(db);
    const neighbor = await seedTeamsDeletionHome(db);
    const retainedDelivery = await delivery(
      db,
      neighbor.message,
      neighbor.channel,
      neighbor.mapping
    );
    const retainedAddress = await address(db, neighbor.channel);
    for (let i = 0; i < BRANCH_DELETION_BATCH_SIZE + 7; i++) {
      const message = generateId();
      await insert(db, messages)
        .values({
          message_id: message,
          session_id: owned.session.session_id,
          created_at: new Date(),
          timestamp: new Date(),
          type: 'assistant',
          role: 'assistant',
          index: i + 1,
          data: { content: 'owned message' },
        })
        .run();
      // Message ownership alone must remove this foreign-channel/map delivery.
      await delivery(db, message, neighbor.channel, neighbor.mapping);
      await address(db, owned.channel);
    }
    // Exercise the other two ownership paths independently. Different mappings
    // keep the message/map uniqueness constraint intact.
    const extraMap = generateId();
    await insert(db, threadSessionMap)
      .values({
        id: extraMap,
        created_at: new Date(),
        last_message_at: new Date(),
        channel_id: neighbor.channel,
        thread_id: extraMap,
        session_id: neighbor.session.session_id,
        branch_id: neighbor.branch.branch_id,
      })
      .run();
    await delivery(db, neighbor.message, owned.channel, extraMap);
    await delivery(db, neighbor.message, neighbor.channel, owned.mapping);
    return { owned, neighbor, retainedDelivery, retainedAddress };
  });
  const { claim, execution } = await withDb(async (db) => {
    const maintenance = new BranchMaintenanceRepository(db);
    const { claim } = await maintenance.claim(fixture.owned.branch.branch_id, 'delete');
    const execution = await maintenance.beginExecution(claim);
    await maintenance.claimExecution(claim, execution);
    return { claim, execution };
  });
  const batches: Record<string, number[]> = {};
  for (let attempt = 0; ; attempt++) {
    expect(attempt).toBeLessThan(30);
    const result = await withDb((db) =>
      new BranchMaintenanceRepository(db).withExecution(claim, execution, (tx) =>
        deleteBranchDataBatch(tx, fixture.owned.branch.branch_id, 'fixture-command')
      )
    );
    expect(result.changed).toBeLessThanOrEqual(BRANCH_DELETION_BATCH_SIZE);
    if (result.table) {
      batches[result.table] ??= [];
      batches[result.table].push(result.changed);
    }
    if (
      result.table &&
      ['thread_session_map', 'gateway_channels', 'messages'].includes(result.table)
    ) {
      // Children have been explicitly drained BEFORE a parent cascade can hide them.
      expect(batches.teams_message_deliveries).toEqual([100, 9]);
      expect(batches.teams_conversation_addresses).toEqual([100, 7]);
    }
    if (!result.remaining) break;
  }
  expect(batches.teams_message_deliveries).toEqual([100, 9]);
  expect(batches.teams_conversation_addresses).toEqual([100, 7]);
  await withDb(async (db) => {
    expect(
      rawRows(await executeRaw(db, sql`SELECT delivery_id FROM teams_message_deliveries`))
    ).toEqual([{ delivery_id: fixture.retainedDelivery }]);
    expect(
      rawRows(await executeRaw(db, sql`SELECT address_id FROM teams_conversation_addresses`))
    ).toEqual([{ address_id: fixture.retainedAddress }]);
    expect(await new SessionRepository(db).findById(fixture.owned.session.session_id)).toBeNull();
    expect(
      await new SessionRepository(db).findById(fixture.neighbor.session.session_id)
    ).not.toBeNull();
    expect(
      await select(db).from(messages).where(eq(messages.message_id, fixture.neighbor.message)).one()
    ).toBeDefined();
    expect(await new BranchRepository(db).findById(fixture.owned.branch.branch_id)).not.toBeNull();
  });
  return fixture;
}
