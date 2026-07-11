import {
  type BoardID,
  type BranchID,
  type MessageID,
  MessageRole,
  type SessionID,
  type UUID,
} from '@agor/core/types';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { BoardRepository } from './boards';
import { BranchRepository } from './branches';
import { MessagesRepository } from './messages';
import { RepoRepository } from './repos';
import { SessionRepository } from './sessions';
import { UsersRepository } from './users';

export async function seedLinkBoard(db: Database, boardId = generateId() as BoardID) {
  return new BoardRepository(db).create({
    board_id: boardId,
    name: `Links Board ${boardId}`,
    created_by: 'owner' as UUID,
  });
}

export async function seedLinkUser(db: Database, userId: UUID, email = `${userId}@example.com`) {
  await new UsersRepository(db).create({ user_id: userId, email, name: email });
}

export async function seedLinkBranch(
  db: Database,
  options?: {
    boardId?: BoardID;
    createdBy?: UUID;
    othersCan?: 'none' | 'view' | 'session' | 'prompt' | 'all';
    archived?: boolean;
    createBoard?: boolean;
    teammate?: boolean;
  }
) {
  const boardId =
    options?.boardId ?? (options?.createBoard ? (await seedLinkBoard(db)).board_id : undefined);
  const repo = await new RepoRepository(db).create({
    repo_id: generateId() as UUID,
    slug: `links-repo-${generateId()}`,
    name: 'Links Repo',
    repo_type: 'remote',
    remote_url: 'https://github.com/example/repo.git',
    local_path: `/tmp/${generateId()}`,
    default_branch: 'main',
  });
  return new BranchRepository(db).create({
    branch_id: generateId() as BranchID,
    repo_id: repo.repo_id,
    name: `links-branch-${generateId()}`,
    ref: 'refs/heads/test',
    branch_unique_id: 1,
    path: `/tmp/${generateId()}`,
    board_id: boardId,
    created_by: options?.createdBy ?? ('owner' as UUID),
    permission_source: 'override',
    others_can: options?.othersCan ?? 'view',
    archived: options?.archived,
    custom_context: options?.teammate ? { teammate: { kind: 'teammate' } } : undefined,
  });
}

export async function seedLinkSession(
  db: Database,
  branchId: BranchID,
  createdBy = 'owner' as UUID
) {
  return new SessionRepository(db).create({
    session_id: generateId() as SessionID,
    branch_id: branchId,
    created_by: createdBy,
    tasks: [],
    genealogy: { children: [] },
  });
}

export async function seedLinkMessage(db: Database, sessionId: SessionID) {
  return new MessagesRepository(db).create({
    message_id: generateId() as MessageID,
    session_id: sessionId,
    type: 'user',
    role: MessageRole.USER,
    index: 0,
    timestamp: new Date().toISOString(),
    content_preview: 'link source',
    content: 'link source',
  });
}
