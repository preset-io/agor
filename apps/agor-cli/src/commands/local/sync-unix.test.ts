import { describe, expect, it } from 'vitest';
import {
  buildBranchGroupAuthorizationIndex,
  buildExplicitFsAuthorizationIndex,
  canVerifyGlobalUnixState,
} from './sync-unix.js';

describe('canVerifyGlobalUnixState', () => {
  it('accepts a host-local SQLite file', () => {
    expect(canVerifyGlobalUnixState('file:/home/operator/.agor/agor.db')).toBe(true);
  });

  it.each([
    'postgresql://db.example/agor',
    'postgres://db.example/agor',
    'libsql://db.example/agor',
    'https://db.example/agor',
  ])('rejects a remote or tenant-scoped DB view: %s', (databaseUrl) => {
    expect(canVerifyGlobalUnixState(databaseUrl)).toBe(false);
  });
});

describe('buildExplicitFsAuthorizationIndex', () => {
  it('indexes every user returned by the canonical branch authorization expansion', async () => {
    const directBranch = {
      branch_id: 'branch-direct',
      name: 'direct',
      unix_group: 'agor_wt_019ffd3d2cef79d1a1c64073',
      repo_id: 'repo-a',
    };
    const boardAlignedBranch = {
      branch_id: 'branch-board',
      name: 'board-aligned',
      unix_group: 'agor_wt_019ffd3d2cef79d1a1c64074',
      repo_id: 'repo-a',
    };
    const authorizationByBranch = new Map([
      [directBranch.branch_id, ['direct-owner', 'branch-group-member']],
      [boardAlignedBranch.branch_id, ['board-owner', 'board-group-member']],
    ]);

    const index = await buildExplicitFsAuthorizationIndex([directBranch, boardAlignedBranch], {
      findExplicitFsAccessUserIds: async (branchId) => authorizationByBranch.get(branchId) ?? [],
    });

    expect(index.userIdsByBranchId.get(directBranch.branch_id)).toEqual(
      new Set(['direct-owner', 'branch-group-member'])
    );
    expect(index.userIdsByBranchId.get(boardAlignedBranch.branch_id)).toEqual(
      new Set(['board-owner', 'board-group-member'])
    );
    expect(index.branchesByUserId.get('branch-group-member')).toEqual([directBranch]);
    expect(index.branchesByUserId.get('board-owner')).toEqual([boardAlignedBranch]);
  });
});

describe('buildBranchGroupAuthorizationIndex', () => {
  it('unions authorization across a shared legacy collision cohort', () => {
    const legacyGroup = 'agor_wt_019ffd3d';
    const first = {
      branch_id: '019ffd3d-0000-7000-8000-000000000001',
      name: 'first',
      unix_group: legacyGroup,
      repo_id: 'repo-a',
    };
    const second = {
      branch_id: '019ffd3d-0000-7000-8000-000000000002',
      name: 'second',
      unix_group: legacyGroup,
      repo_id: 'repo-b',
    };

    const index = buildBranchGroupAuthorizationIndex(
      [first, second],
      new Map([
        [first.branch_id, new Set(['first-user'])],
        [second.branch_id, new Set(['second-user'])],
      ])
    );

    expect(index.userIdsByGroup.get(legacyGroup)).toEqual(new Set(['first-user', 'second-user']));
  });
});
