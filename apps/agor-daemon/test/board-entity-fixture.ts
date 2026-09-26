import {
  BoardObjectRepository,
  BoardRepository,
  BranchRepository,
  CardRepository,
  type Database,
  RepoRepository,
  UsersRepository,
} from '@agor/core/db';

export async function seedBoardEntities(db: Database, role: 'member' | 'admin' = 'member') {
  const owner = await new UsersRepository(db).create({ email: `owner-${role}@example.test`, role });
  const other = await new UsersRepository(db).create({
    email: `other-${role}@example.test`,
    role: 'member',
  });
  const board = await new BoardRepository(db).create({
    name: 'Entities',
    created_by: owner.user_id,
    access_mode: 'private',
  });
  const repo = await new RepoRepository(db).create({
    repo_type: 'remote',
    remote_url: 'https://example.test/entity-fixture.git',
    slug: 'entity-fixture',
    local_path: '/tmp/entity-fixture',
    default_branch: 'main',
  });
  const objects = new BoardObjectRepository(db);
  const branches = new BranchRepository(db);
  const entities = [];
  for (const [index, name] of ['archived', 'active-a', 'active-b', 'hidden', 'outside'].entries()) {
    const createdBy = name === 'hidden' ? other.user_id : owner.user_id;
    const branch = await branches.create({
      repo_id: repo.repo_id,
      board_id: board.board_id,
      name,
      ref: name,
      branch_unique_id: index + 1,
      created_by: createdBy,
      primary_owner_user_id: createdBy,
      permission_source: 'override',
      others_can: 'none',
      archived: name === 'archived',
    });
    entities.push(
      await objects.create({
        board_id: board.board_id,
        branch_id: branch.branch_id,
        position: { x: index, y: 0 },
        zone_id: name === 'outside' ? 'zone-other' : 'zone-review',
      })
    );
  }
  const card = await new CardRepository(db).create({
    board_id: board.board_id,
    title: 'Card',
    created_by: owner.user_id,
  });
  const cardObject = await objects.create({
    board_id: board.board_id,
    card_id: card.card_id,
    position: { x: 5, y: 0 },
    zone_id: 'zone-review',
  });
  return { owner, other, board, repo, entities, cardObject };
}
