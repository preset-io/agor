import { describe, expect, it } from 'vitest';
import {
  classifyMigrationWatermark,
  createMigrationImpactRegistry,
  getMigrationImpact,
  introspectMigrationStatus,
  MIGRATION_IMPACT_SUMMARY_MAX_LENGTH,
  type MigrationImpactPolicy,
  pendingOfflineCutoverMigrations,
} from './migrate';

describe('migration status introspection', () => {
  it('classifies a later reconciliation watermark as database-ahead for an old binary', () => {
    expect(
      classifyMigrationWatermark(
        [{ tag: '0100_mcp_oauth_client_registrations', when: 1_788_292_800_000 }],
        1_788_379_200_000
      )
    ).toEqual({
      hasPending: false,
      pending: [],
      applied: ['0100_mcp_oauth_client_registrations'],
      dbAheadOfBinary: true,
    });
  });

  it('reports an offline pending migration and aggregate cutover requirement', () => {
    const report = introspectMigrationStatus('postgresql', {
      applied: ['0000_init'],
      pending: ['0074_knowledge_embedding_claims'],
      dbAheadOfBinary: false,
    });

    expect(report).toEqual({
      schemaVersion: 1,
      dialect: 'postgresql',
      appliedMigrations: ['0000_init'],
      pendingMigrations: [
        {
          name: '0074_knowledge_embedding_claims',
          requiresOfflineCutover: true,
          impact: {
            classification: 'protocol',
            userAction: 'required',
            rollbackCompatibility: 'incompatible',
            summary: 'Requires a coordinated offline cutover and is not rollback compatible.',
          },
        },
      ],
      requiresOfflineCutover: true,
      databaseAheadOfBinary: false,
    });
  });

  it('keeps ordinary and fresh-database migrations online', () => {
    expect(
      introspectMigrationStatus('postgresql', {
        applied: ['0000_init'],
        pending: ['0001_ordinary'],
        dbAheadOfBinary: false,
      }).pendingMigrations[0]?.requiresOfflineCutover
    ).toBe(false);
    expect(
      introspectMigrationStatus('postgresql', {
        applied: [],
        pending: ['0074_knowledge_embedding_claims'],
        dbAheadOfBinary: false,
      }).requiresOfflineCutover
    ).toBe(false);
    const fresh = introspectMigrationStatus('postgresql', {
      applied: [],
      pending: ['0074_knowledge_embedding_claims'],
      dbAheadOfBinary: false,
    }).pendingMigrations[0];
    expect(fresh?.impact.userAction).toBe('none');
    expect(fresh?.impact.summary).not.toMatch(/requires? .*offline cutover/i);
  });

  it('shares queued-message impact metadata across the actual journal tags', () => {
    const postgresqlMigration = introspectMigrationStatus('postgresql', {
      applied: ['0000_init'],
      pending: ['0030_migrate_queued_messages'],
      dbAheadOfBinary: false,
    }).pendingMigrations[0];
    const sqliteMigration = introspectMigrationStatus('sqlite', {
      applied: ['0000_init'],
      pending: ['0040_migrate_queued_messages'],
      dbAheadOfBinary: false,
    }).pendingMigrations[0];

    expect(postgresqlMigration).toMatchObject({
      requiresOfflineCutover: false,
      impact: { classification: 'data', userAction: 'required' },
    });
    expect(sqliteMigration).toMatchObject({
      requiresOfflineCutover: false,
      impact: { classification: 'data', userAction: 'required' },
    });
    expect(sqliteMigration?.impact).toBe(postgresqlMigration?.impact);
  });

  it('requires offline acknowledgement for the SQLite RBAC cutover on an existing database', () => {
    const report = introspectMigrationStatus('sqlite', {
      applied: ['0000_init'],
      pending: ['0098_board_branch_capability_policies'],
      dbAheadOfBinary: false,
    });
    expect(report.dialect).toBe('sqlite');
    expect(report.requiresOfflineCutover).toBe(true);
    expect(report.pendingMigrations[0]).toMatchObject({
      requiresOfflineCutover: true,
      impact: { userAction: 'required', rollbackCompatibility: 'incompatible' },
    });
  });

  it('describes the index migration as rollback-compatible performance work', () => {
    expect(getMigrationImpact('0083_transcript_hydration_keysets')).toMatchObject({
      classification: 'performance',
      userAction: 'required',
      rollbackCompatibility: 'compatible',
    });
  });

  it('reports Claude OAuth authority as a rollback-incompatible protocol cutover', () => {
    const migration = introspectMigrationStatus('postgresql', {
      applied: ['0093_scheduler_poison_recovery'],
      pending: ['0100_claude_oauth_attempts'],
      dbAheadOfBinary: false,
    }).pendingMigrations[0];

    expect(migration).toMatchObject({
      requiresOfflineCutover: true,
      impact: {
        classification: 'protocol',
        userAction: 'required',
        rollbackCompatibility: 'incompatible',
      },
    });
  });

  it('reports MCP DCR authority as an offline, rollback-incompatible cohort cutover', () => {
    const migration = introspectMigrationStatus('postgresql', {
      applied: ['0100_claude_oauth_attempts'],
      pending: ['0101_mcp_oauth_client_registrations'],
      dbAheadOfBinary: false,
    }).pendingMigrations[0];

    expect(migration).toMatchObject({
      requiresOfflineCutover: true,
      impact: {
        classification: 'protocol',
        userAction: 'required',
        rollbackCompatibility: 'incompatible',
      },
    });
  });

  it('reports the OAuth authority collision reconciliation as an offline incompatible cutover', () => {
    const migration = introspectMigrationStatus('postgresql', {
      applied: ['0099_shared_session_prompting'],
      pending: ['0102_oauth_authority_watermark_reconciliation'],
      dbAheadOfBinary: false,
    }).pendingMigrations[0];

    expect(migration).toMatchObject({
      requiresOfflineCutover: true,
      impact: {
        classification: 'protocol',
        userAction: 'required',
        rollbackCompatibility: 'incompatible',
      },
    });
  });

  it('uses an explicit conservative representation for absent impact metadata', () => {
    expect(getMigrationImpact('9999_unregistered')).toEqual({
      classification: 'unknown',
      userAction: 'unknown',
      rollbackCompatibility: 'unknown',
      summary: 'Migration impact metadata is unavailable.',
    });
  });

  it('registers impact metadata for every offline cutover migration', () => {
    const offlineMigrations = pendingOfflineCutoverMigrations('postgresql', {
      applied: ['0000_init'],
      pending: [
        '0074_knowledge_embedding_claims',
        '0078_mcp_oauth_pending_flows',
        '0082_github_install_state',
        '0083_transcript_hydration_keysets',
        '0091_codex_device_auth_attempts',
        '0100_claude_oauth_attempts',
        '0101_mcp_oauth_client_registrations',
        '0102_oauth_authority_watermark_reconciliation',
      ],
    });

    expect(offlineMigrations).toHaveLength(8);
    for (const name of offlineMigrations) {
      expect(getMigrationImpact(name).classification).not.toBe('unknown');
    }
  });

  it('does not derive offline cutover policy from impact metadata presence', () => {
    const onlinePolicy: MigrationImpactPolicy = {
      requiresOfflineCutover: false,
      impact: {
        classification: 'schema',
        userAction: 'none',
        rollbackCompatibility: 'compatible',
        summary: 'Adds an ordinary online schema change.',
      },
    };

    const registry = createMigrationImpactRegistry([['9998_ordinary_online', onlinePolicy]]);

    expect(registry.impacts.get('9998_ordinary_online')).toBe(onlinePolicy);
    expect(registry.offlineCutoverMigrations.has('9998_ordinary_online')).toBe(false);
  });

  it('keeps impact summaries within the public bound', () => {
    for (const name of [
      '0074_knowledge_embedding_claims',
      '0078_mcp_oauth_pending_flows',
      '0082_github_install_state',
      '0083_transcript_hydration_keysets',
      '0091_codex_device_auth_attempts',
      '0100_claude_oauth_attempts',
      '0101_mcp_oauth_client_registrations',
      '0102_oauth_authority_watermark_reconciliation',
      'unregistered',
    ]) {
      expect(getMigrationImpact(name).summary.length).toBeLessThanOrEqual(
        MIGRATION_IMPACT_SUMMARY_MAX_LENGTH
      );
    }
  });
});
