/**
 * ArtifactRepository Tests
 *
 * Focused on the find filters that back the SQL pushdown on ArtifactsService.find.
 */

import type { BoardID, BranchID, UUID } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { dbTest } from '../test-helpers';
import { ArtifactRepository } from './artifacts';
import { BoardRepository } from './boards';
import { BranchRepository } from './branches';
import { RepoRepository } from './repos';
import { UsersRepository } from './users';

async function createBoard(db: Database): Promise<BoardID> {
  const board = await new BoardRepository(db).create({
    board_id: generateId(),
    name: `Board ${generateId()}`,
    created_by: 'test-user',
  });
  return board.board_id as BoardID;
}

async function createBranch(
  db: Database,
  overrides?: { created_by?: UUID; others_can?: 'none' | 'view' | 'session' | 'prompt' | 'all' }
): Promise<BranchID> {
  const repo = await new RepoRepository(db).create({
    repo_id: generateId() as UUID,
    slug: `repo-${generateId()}`,
    name: 'Repo',
    repo_type: 'remote',
    remote_url: 'https://github.com/test/repo.git',
    local_path: `/tmp/${generateId()}`,
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    branch_id: generateId() as BranchID,
    repo_id: repo.repo_id,
    name: `branch-${generateId()}`,
    ref: 'refs/heads/feature',
    branch_unique_id: 1,
    path: `/tmp/${generateId()}`,
    created_by: overrides?.created_by ?? ('test-user' as UUID),
    permission_source: 'override',
    others_can: overrides?.others_can,
  });
  return branch.branch_id as BranchID;
}

describe('ArtifactRepository.findAll', () => {
  dbTest('filters by board_id', async ({ db }) => {
    const repo = new ArtifactRepository(db);
    const boardA = await createBoard(db);
    const boardB = await createBoard(db);

    await repo.create({ artifact_id: generateId(), board_id: boardA, name: 'a1' });
    await repo.create({ artifact_id: generateId(), board_id: boardA, name: 'a2' });
    await repo.create({ artifact_id: generateId(), board_id: boardB, name: 'b1' });

    const onBoardA = await repo.findAll({ board_id: boardA });
    expect(onBoardA.map((a) => a.name).sort()).toEqual(['a1', 'a2']);
  });

  dbTest('filters by exact archived state', async ({ db }) => {
    const repo = new ArtifactRepository(db);
    const board = await createBoard(db);

    const active = await repo.create({
      artifact_id: generateId(),
      board_id: board,
      name: 'active',
    });
    const archived = await repo.create({
      artifact_id: generateId(),
      board_id: board,
      name: 'archived',
    });
    await repo.update(archived.artifact_id, { archived: true });

    const activeOnly = await repo.findAll({ archived: false });
    expect(activeOnly.map((a) => a.artifact_id)).toEqual([active.artifact_id]);
  });

  dbTest('restricts to a branchIds set and excludes null-branch orphans', async ({ db }) => {
    const repo = new ArtifactRepository(db);
    const board = await createBoard(db);
    const branch1 = await createBranch(db);
    const branch2 = await createBranch(db);

    const onBranch1 = await repo.create({
      artifact_id: generateId(),
      board_id: board,
      branch_id: branch1,
      name: 'on-branch1',
    });
    await repo.create({
      artifact_id: generateId(),
      board_id: board,
      branch_id: branch2,
      name: 'on-branch2',
    });
    await repo.create({
      artifact_id: generateId(),
      board_id: board,
      branch_id: null,
      name: 'orphan',
    });

    const scoped = await repo.findAll({ branchIds: [branch1] });
    expect(scoped.map((a) => a.artifact_id)).toEqual([onBranch1.artifact_id]);
  });

  dbTest('returns no rows for an empty branchIds set', async ({ db }) => {
    const repo = new ArtifactRepository(db);
    const board = await createBoard(db);
    await repo.create({ artifact_id: generateId(), board_id: board, name: 'a1' });

    expect(await repo.findAll({ branchIds: [] })).toEqual([]);
  });

  dbTest('pushes branch visibility directly into findAll SQL', async ({ db }) => {
    const repo = new ArtifactRepository(db);
    const branchRepo = new BranchRepository(db);
    const usersRepo = new UsersRepository(db);
    const board = await createBoard(db);
    const viewerId = generateId() as UUID;
    await usersRepo.create({
      user_id: viewerId,
      email: 'artifact-visible-branch@example.com',
      name: 'Artifact Viewer',
    });
    const visibleBranch = await createBranch(db, { others_can: 'none' });
    const hiddenBranch = await createBranch(db, { others_can: 'none' });
    await branchRepo.addOwner(visibleBranch, viewerId);

    const visibleArtifact = await repo.create({
      artifact_id: generateId(),
      board_id: board,
      branch_id: visibleBranch,
      name: 'visible',
    });
    await repo.create({
      artifact_id: generateId(),
      board_id: board,
      branch_id: hiddenBranch,
      name: 'hidden',
    });
    await repo.create({
      artifact_id: generateId(),
      board_id: board,
      branch_id: null,
      name: 'orphan',
    });

    const visible = await repo.findAll({ visibleToUserId: viewerId });
    expect(visible.map((a) => a.artifact_id)).toEqual([visibleArtifact.artifact_id]);
  });
});
