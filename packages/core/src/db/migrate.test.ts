import { describe, expect, it } from 'vitest';
import {
  getMigrationImpact,
  introspectMigrationStatus,
  MIGRATION_IMPACT_SUMMARY_MAX_LENGTH,
} from './migrate';

describe('migration status introspection', () => {
  it('reports an offline pending migration and aggregate cutover requirement', () => {
    const report = introspectMigrationStatus({
      applied: ['0000_init'],
      pending: ['0074_knowledge_embedding_claims'],
      dbAheadOfBinary: false,
    });

    expect(report).toEqual({
      schemaVersion: 1,
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
      introspectMigrationStatus({
        applied: ['0000_init'],
        pending: ['0001_ordinary'],
        dbAheadOfBinary: false,
      }).pendingMigrations[0]?.requiresOfflineCutover
    ).toBe(false);
    expect(
      introspectMigrationStatus({
        applied: [],
        pending: ['0074_knowledge_embedding_claims'],
        dbAheadOfBinary: false,
      }).requiresOfflineCutover
    ).toBe(false);
  });

  it('uses an explicit conservative representation for absent impact metadata', () => {
    expect(getMigrationImpact('9999_unregistered')).toEqual({
      classification: 'unknown',
      userAction: 'unknown',
      rollbackCompatibility: 'unknown',
      summary: 'Migration impact metadata is unavailable.',
    });
  });

  it('keeps impact summaries within the public bound', () => {
    for (const name of [
      '0074_knowledge_embedding_claims',
      '0078_mcp_oauth_pending_flows',
      '0082_github_install_state',
      '0083_transcript_hydration_keysets',
      'unregistered',
    ]) {
      expect(getMigrationImpact(name).summary.length).toBeLessThanOrEqual(
        MIGRATION_IMPACT_SUMMARY_MAX_LENGTH
      );
    }
  });
});
