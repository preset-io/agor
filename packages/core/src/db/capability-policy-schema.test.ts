import { getTableConfig as getPgTableConfig } from 'drizzle-orm/pg-core';
import { getTableConfig as getSqliteTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import {
  boardAccessEntries as pgBoardAccessEntries,
  boardAccessPolicies as pgBoardAccessPolicies,
  branchPermissionConfigs as pgBranchPermissionConfigs,
  branchPermissionEntries as pgBranchPermissionEntries,
} from './schema.postgres';
import {
  boardAccessEntries as sqliteBoardAccessEntries,
  boardAccessPolicies as sqliteBoardAccessPolicies,
  branchPermissionConfigs as sqliteBranchPermissionConfigs,
  branchPermissionEntries as sqliteBranchPermissionEntries,
} from './schema.sqlite';

const policyTables = [
  {
    sqlite: sqliteBoardAccessPolicies,
    postgres: pgBoardAccessPolicies,
    checks: ['board_access_policies_sharing_mode_check', 'board_access_policies_others_role_check'],
  },
  {
    sqlite: sqliteBoardAccessEntries,
    postgres: pgBoardAccessEntries,
    checks: ['board_access_entries_role_check', 'board_access_entries_principal_check'],
  },
  {
    sqlite: sqliteBranchPermissionConfigs,
    postgres: pgBranchPermissionConfigs,
    checks: [
      'branch_permission_configs_sharing_mode_check',
      'branch_permission_configs_others_role_check',
      'branch_permission_configs_others_fs_access_check',
      'branch_permission_configs_target_check',
    ],
  },
  {
    sqlite: sqliteBranchPermissionEntries,
    postgres: pgBranchPermissionEntries,
    checks: [
      'branch_permission_entries_role_check',
      'branch_permission_entries_fs_access_check',
      'branch_permission_entries_principal_check',
    ],
  },
] as const;

describe('capability-policy schema constraints', () => {
  it('declares every normalized authority check in SQLite', () => {
    for (const table of policyTables) {
      const actual = new Set(
        getSqliteTableConfig(table.sqlite).checks.map((constraint) => constraint.name)
      );
      for (const name of table.checks) expect(actual).toContain(name);
    }
  });

  it('declares every normalized authority check in PostgreSQL', () => {
    for (const table of policyTables) {
      const actual = new Set(
        getPgTableConfig(table.postgres).checks.map((constraint) => constraint.name)
      );
      for (const name of table.checks) expect(actual).toContain(name);
    }
  });

  it('stores the shared-session opt-in on the complete permission package', () => {
    expect(sqliteBranchPermissionConfigs.allow_shared_session_prompts).toBeDefined();
    expect(pgBranchPermissionConfigs.allow_shared_session_prompts).toBeDefined();
  });
});
