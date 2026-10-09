import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { Sql } from 'postgres';
import { expect } from 'vitest';
import type { BranchID, UserID } from '../types';
import type { Database } from './client';
import { executeRaw, rawRows } from './database-wrapper';
import { GatewayInboundEventRepository } from './repositories/gateway-inbound-events';
import { SessionRepository } from './repositories/sessions';
import { TeamsMessageDeliveryRepository } from './repositories/teams-message-deliveries';
import * as schema from './schema.postgres';
import { runWithSystemDatabaseScope, runWithTenantDatabaseScope } from './tenant-scope';

interface ExplainNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Actual Rows': number;
  'Actual Loops': number;
  'Rows Removed by Filter'?: number;
  Plans?: ExplainNode[];
}

function planNodes(node: ExplainNode): ExplainNode[] {
  return [node, ...(node.Plans ?? []).flatMap(planNodes)];
}

/** Actual repository SQL, including RLS, enabled-channel join and lane anti-joins. */
export async function proveTeamsDiscoveryPlans(
  db: Database,
  fixture: { teams: string; duplicate: string; branch: BranchID; owner: UserID }
) {
  await runWithTenantDatabaseScope(db, 'teams-a', async (scoped) => {
    const session = await new SessionRepository(scoped).create({
      branch_id: fixture.branch,
      created_by: fixture.owner,
    });
    // 20,000 terminal rows dominate both histories. Active work includes blocked
    // successors, future work and expired payloads on a disabled channel.
    await executeRaw(
      scoped,
      sql`INSERT INTO gateway_inbound_events
      (tenant_id,id,gateway_channel_id,provider_event_id,thread_id,status,processing_token,
       processing_expires_at,received_at,next_attempt_at,payload_expires_at,payload_encrypted)
      SELECT 'teams-a',md5('plan-inbound-'||n),
        CASE WHEN n>22100 THEN ${fixture.duplicate} ELSE ${fixture.teams} END,
        'plan-event-'||n,'plan-thread-'||(n % 1000),
        CASE WHEN n<=20000 THEN 'completed' ELSE 'pending' END,'token',
        CURRENT_TIMESTAMP + interval '1 day', CURRENT_TIMESTAMP + n * interval '1 millisecond',
        CASE WHEN n>20000 AND n<=21000 OR n>22100 THEN CURRENT_TIMESTAMP + interval '1 day' ELSE CURRENT_TIMESTAMP - interval '1 day' END,
        CASE WHEN n>22100 THEN CURRENT_TIMESTAMP - interval '1 hour' ELSE CURRENT_TIMESTAMP + interval '1 day' END,'ciphertext'
      FROM generate_series(1,22350) n`
    );
    // Give the eligible tail independent lanes instead of earlier predecessors.
    await executeRaw(
      scoped,
      sql`UPDATE gateway_inbound_events SET thread_id=provider_event_id
      WHERE provider_event_id LIKE 'plan-event-%' AND id IN (SELECT md5('plan-inbound-'||n) FROM generate_series(22001,22100) n)`
    );
    await executeRaw(
      scoped,
      sql`INSERT INTO thread_session_map
      (tenant_id,id,created_at,last_message_at,channel_id,thread_id,session_id,branch_id)
      SELECT 'teams-a',md5('plan-map-'||n),CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,${fixture.teams},
        'plan-map-thread-'||n,${session.session_id},${fixture.branch} FROM generate_series(0,1099) n`
    );
    await executeRaw(
      scoped,
      sql`INSERT INTO messages
      (tenant_id,message_id,created_at,session_id,type,role,"index",timestamp,data)
      SELECT 'teams-a',md5('plan-message-'||n),CURRENT_TIMESTAMP,${session.session_id},
        'assistant','assistant',n,CURRENT_TIMESTAMP,'{"content":"plan fixture"}'::jsonb FROM generate_series(1,22100) n`
    );
    await executeRaw(
      scoped,
      sql`INSERT INTO teams_message_deliveries
      (tenant_id,delivery_id,created_at,updated_at,message_id,gateway_channel_id,thread_session_map_id,
       provider_installation_id,provider_config_generation,status,next_attempt_at)
      SELECT 'teams-a',md5('plan-delivery-'||n),CURRENT_TIMESTAMP+n*interval '1 millisecond',CURRENT_TIMESTAMP,
        md5('plan-message-'||n),${fixture.teams},
        md5('plan-map-'||CASE WHEN n>22000 THEN n-21001 ELSE n%1000 END),
        'shared-teams-app',1,CASE WHEN n<=20000 THEN 'completed' ELSE 'pending' END,
        CASE WHEN n>20000 AND n<=21000 THEN CURRENT_TIMESTAMP+interval '1 day' ELSE CURRENT_TIMESTAMP-interval '1 day' END
      FROM generate_series(1,22100) n`
    );
    for (const table of [
      'gateway_inbound_events',
      'gateway_channels',
      'teams_message_deliveries',
    ]) {
      await executeRaw(scoped, sql.raw(`ANALYZE ${table}`));
    }
  });

  const captured: Array<{ query: string; params: unknown[] }> = [];
  const recordingDb = drizzle((db as Database & { $client: Sql }).$client, {
    schema,
    logger: {
      logQuery(query, params) {
        captured.push({ query, params });
      },
    },
  });
  for (const capability of [
    'teams_gateway_ingress_discovery',
    'teams_message_delivery_discovery',
  ] as const) {
    await runWithSystemDatabaseScope(
      recordingDb,
      'Teams populated discovery plan proof',
      async (scoped) => {
        captured.length = 0;
        const refs =
          capability === 'teams_gateway_ingress_discovery'
            ? await new GatewayInboundEventRepository(scoped).findDueTeamsRefs(scoped, {
                limit: 25,
              })
            : await new TeamsMessageDeliveryRepository(scoped).findDueRefs(scoped, { limit: 25 });
        expect(refs).toHaveLength(25);
        const queries = captured.filter(
          ({ query }) =>
            /^select /i.test(query) &&
            (query.includes('from "gateway_inbound_events"') ||
              query.includes('from "teams_message_deliveries"'))
        );
        expect(queries).toHaveLength(capability === 'teams_gateway_ingress_discovery' ? 2 : 1);
        for (const { query, params } of queries) {
          // Rebind the captured placeholders rather than interpolating values into SQL.
          const rebound = sql.join(
            query
              .split(/\$(\d+)/)
              .map((part, index) => (index % 2 ? sql`${params[Number(part) - 1]}` : sql.raw(part))),
            sql``
          );
          const plan = rawRows(
            await executeRaw(scoped, sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${rebound}`)
          );
          const serialized = JSON.stringify(plan);
          const expired =
            query.includes('"payload_encrypted" is not null') ||
            query.includes('"payload_encrypted" IS NOT NULL');
          const expected =
            capability === 'teams_message_delivery_discovery'
              ? 'teams_message_deliveries_discovery_idx'
              : expired
                ? 'gateway_inbound_events_teams_expiry_idx'
                : 'gateway_inbound_events_teams_due_idx';
          expect(serialized, serialized).toContain(expected);
          if (!expired)
            expect(serialized, serialized).toContain(
              capability === 'teams_message_delivery_discovery'
                ? 'teams_message_deliveries_lane_idx'
                : 'gateway_inbound_events_teams_lane_idx'
            );
          // Keep evidence visible without leaking any fixture payloads.
          const root = (plan[0]!['QUERY PLAN'] as Array<{ Plan: ExplainNode }>)[0]!.Plan;
          expect(root['Actual Rows']).toBe(25);
          const historyScans = planNodes(root).filter((node) =>
            ['gateway_inbound_events', 'teams_message_deliveries'].includes(
              node['Relation Name'] ?? ''
            )
          );
          for (const node of historyScans) {
            expect(node['Node Type']).not.toBe('Seq Scan');
            expect(
              (node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0)) * node['Actual Loops']
            ).toBeLessThan(5000);
          }
          console.log(
            'Teams discovery plan',
            JSON.stringify({
              expected,
              returned: root['Actual Rows'],
              scans: historyScans.map((node) => ({
                index: node['Index Name'],
                rows: node['Actual Rows'],
                loops: node['Actual Loops'],
              })),
            })
          );
        }
      },
      { capability }
    );
  }
}
