/**
 * Seeds the read-only example board from {@link EXAMPLE_BOARD_FIXTURE}.
 *
 * Pure DB inserts in one transaction: no git, network or executor. Everything is
 * owned by the non-loginable "Agor examples" user, which is also the terminal
 * idempotency sentinel. Others get viewer access, schedules are disabled and
 * every session is finished, so nothing on the board can run.
 */

import type { Database } from '../../db/client';
import { runDatabaseTransaction } from '../../db/database-wrapper';
import {
  ArtifactRepository,
  BoardObjectRepository,
  BoardRepository,
  BranchRepository,
  CardRepository,
  MessagesRepository,
  RepoRepository,
  ScheduleRepository,
  SessionRepository,
  TaskRepository,
  UsersRepository,
} from '../../db/repositories';
import { autoAssignBranchUniqueId } from '../../environment/variable-resolver';
import { generateId } from '../../lib/ids';
import type {
  BoardID,
  BranchID,
  ContentBlock,
  Message,
  ScheduleID,
  SessionID,
  TaskID,
  UserID,
  UUID,
} from '../../types';
import {
  EXAMPLE_BOARD_OWNER_EMAIL,
  EXAMPLE_BOARD_OWNER_NAME,
  MessageRole,
  SessionStatus,
  TaskStatus,
} from '../../types';
import { EXAMPLE_BOARD_FIXTURE, type ExampleBoardFixture, type ExampleTurn } from './fixture';

/** Workspace paths that can never exist, so no git or filesystem job can act on them. */
const EXAMPLE_PATH_ROOT = '/dev/null/agor-example';

export interface ExampleBoardSeedResult {
  seeded: boolean;
  board_id?: BoardID;
}

export async function seedExampleBoard(
  db: Database,
  fixture: ExampleBoardFixture = EXAMPLE_BOARD_FIXTURE
): Promise<ExampleBoardSeedResult> {
  return runDatabaseTransaction(db, (tx) => seedExampleBoardInTransaction(tx, fixture), {
    sqliteImmediate: true,
  });
}

export async function seedExampleBoardInTransaction(
  tx: Database,
  fixture: ExampleBoardFixture = EXAMPLE_BOARD_FIXTURE
): Promise<ExampleBoardSeedResult> {
  const usersRepo = new UsersRepository(tx);
  if (await usersRepo.findByEmail(EXAMPLE_BOARD_OWNER_EMAIL)) return { seeded: false };

  // Repository-created users have no local credential, so this one can never log in.
  const owner = await usersRepo.create({
    email: EXAMPLE_BOARD_OWNER_EMAIL,
    name: EXAMPLE_BOARD_OWNER_NAME,
    emoji: '🧪',
    role: 'viewer',
    onboarding_completed: true,
  });
  const ownerId = owner.user_id as UserID;
  const now = Date.now();
  const at = (minutesAgo: number, plusSeconds = 0) =>
    new Date(now - minutesAgo * 60_000 + plusSeconds * 1000).toISOString();

  const repo = await new RepoRepository(tx).create({
    slug: fixture.repo.slug,
    name: fixture.repo.name,
    repo_type: 'remote',
    remote_url: fixture.repo.remote_url,
    local_path: `${EXAMPLE_PATH_ROOT}/${fixture.repo.slug}`,
    default_branch: 'main',
  });

  const boardRepo = new BoardRepository(tx);
  const board = await boardRepo.create({
    ...fixture.board,
    slug: fixture.board.slug,
    created_by: ownerId,
  });
  const boardId = board.board_id as BoardID;

  const branchRepo = new BranchRepository(tx);
  const boardObjects = new BoardObjectRepository(tx);
  const branchIds = new Map<string, BranchID>();
  const usedUniqueIds = await branchRepo.getAllUsedUniqueIds();
  for (const spec of fixture.branches) {
    const uniqueId = autoAssignBranchUniqueId(usedUniqueIds);
    usedUniqueIds.push(uniqueId);
    const branch = await branchRepo.create({
      branch_unique_id: uniqueId,
      repo_id: repo.repo_id,
      name: spec.name,
      ref: spec.name,
      path: `${EXAMPLE_PATH_ROOT}/${fixture.repo.slug}/${spec.name}`,
      base_ref: 'main',
      created_by: ownerId,
      board_id: boardId,
      needs_attention: false,
      others_can: 'view',
      others_fs_access: 'none',
      notes: spec.notes,
      ...(spec.teammate
        ? { custom_context: { teammate: { kind: 'teammate', ...spec.teammate } } }
        : {}),
    });
    branchIds.set(spec.key, branch.branch_id as BranchID);
    await boardObjects.create({
      board_id: boardId,
      branch_id: branch.branch_id,
      position: spec.position,
      zone_id: spec.zone,
    });
  }
  const branchId = (key: string) => {
    const id = branchIds.get(key);
    if (!id) throw new Error(`Example fixture references unknown branch "${key}"`);
    return id;
  };

  const scheduleRepo = new ScheduleRepository(tx);
  const scheduleIds = new Map<string, ScheduleID>();
  for (const spec of fixture.schedules) {
    const schedule = await scheduleRepo.create({
      branch_id: branchId(spec.branch),
      name: spec.name,
      cron_expression: spec.cron_expression,
      timezone_mode: 'utc',
      prompt: spec.prompt,
      agentic_tool_config: { agentic_tool: 'claude-code' },
      enabled: false,
      created_by: ownerId,
    });
    scheduleIds.set(spec.key, schedule.schedule_id);
  }

  // Pre-generate IDs so genealogy is consistent at insert time.
  const sessionIds = new Map(fixture.sessions.map((s) => [s.key, generateId() as SessionID]));
  const taskIds = new Map(fixture.sessions.map((s) => [s.key, generateId() as TaskID]));
  const sessionId = (key: string) => {
    const id = sessionIds.get(key);
    if (!id) throw new Error(`Example fixture references unknown session "${key}"`);
    return id;
  };

  const sessionRepo = new SessionRepository(tx);
  const taskRepo = new TaskRepository(tx);
  const messagesRepo = new MessagesRepository(tx);
  for (const spec of fixture.sessions) {
    const id = sessionId(spec.key);
    const taskId = taskIds.get(spec.key) as TaskID;
    const parentKey = spec.spawnedFrom ?? spec.forkedFrom;
    const parentTask = parentKey ? taskIds.get(parentKey) : undefined;
    const children = fixture.sessions
      .filter((s) => s.spawnedFrom === spec.key || s.forkedFrom === spec.key)
      .map((s) => sessionId(s.key));
    const messages = buildMessages(id, taskId, spec.turns, at(spec.minutesAgo));
    const prompt = spec.turns.find((t): t is { user: string } => 'user' in t)?.user ?? '';

    await sessionRepo.create({
      session_id: id,
      branch_id: branchId(spec.branch),
      created_by: ownerId,
      status: SessionStatus.COMPLETED,
      agentic_tool: 'claude-code',
      title: spec.title,
      description: prompt,
      tasks: [taskId],
      created_at: at(spec.minutesAgo),
      last_updated: at(spec.minutesAgo, spec.durationSeconds),
      genealogy: {
        children,
        ...(spec.spawnedFrom
          ? { parent_session_id: sessionId(spec.spawnedFrom), spawn_point_task_id: parentTask }
          : {}),
        ...(spec.forkedFrom
          ? { forked_from_session_id: sessionId(spec.forkedFrom), fork_point_task_id: parentTask }
          : {}),
      },
      ...(spec.schedule
        ? {
            schedule_id: scheduleIds.get(spec.schedule),
            scheduled_from_branch: true,
            scheduled_run_at: new Date(at(spec.minutesAgo)).getTime(),
          }
        : {}),
      ...(spec.gateway
        ? {
            custom_context: {
              gateway_source: {
                channel_id: `example-${spec.gateway.channel_name}`,
                channel_name: spec.gateway.channel_name,
                channel_type: spec.gateway.channel_type,
                thread_id: `example-${spec.key}`,
              },
            },
          }
        : {}),
    });
    await taskRepo.create({
      task_id: taskId,
      session_id: id,
      created_by: ownerId,
      status: TaskStatus.COMPLETED,
      full_prompt: prompt,
      message_range: {
        start_index: 0,
        end_index: messages.length - 1,
        start_timestamp: at(spec.minutesAgo),
        end_timestamp: at(spec.minutesAgo, spec.durationSeconds),
      },
      git_state: { ref_at_start: 'main', sha_at_start: 'example' },
      created_at: at(spec.minutesAgo),
      started_at: at(spec.minutesAgo),
      completed_at: at(spec.minutesAgo, spec.durationSeconds),
      duration_ms: spec.durationSeconds * 1000,
    });
    for (const message of messages) await messagesRepo.create(message);
  }

  const cardRepo = new CardRepository(tx);
  for (const spec of fixture.cards) {
    const card = await cardRepo.create({
      board_id: boardId,
      title: spec.title,
      description: spec.description,
      note: spec.note,
      emoji_override: spec.emoji,
      color_override: spec.color,
      created_by: ownerId,
    });
    await boardObjects.create({
      board_id: boardId,
      card_id: card.card_id as UUID,
      position: spec.position,
      zone_id: spec.zone,
    });
  }

  const artifactRepo = new ArtifactRepository(tx);
  for (const spec of fixture.artifacts) {
    const artifact = await artifactRepo.create({
      board_id: boardId,
      branch_id: branchId(spec.branch),
      source_session_id: sessionId(spec.session),
      name: spec.name,
      description: spec.description,
      template: 'static',
      files: { '/index.html': spec.html },
      public: true,
      created_by: ownerId,
    });
    await boardRepo.upsertBoardObject(boardId, `artifact-${artifact.artifact_id}`, {
      type: 'artifact',
      artifact_id: artifact.artifact_id,
      locked: true,
      ...spec.position,
    });
  }

  return { seeded: true, board_id: boardId };
}

function buildMessages(
  sessionId: SessionID,
  taskId: TaskID,
  turns: ExampleTurn[],
  startedAt: string
): Message[] {
  const start = new Date(startedAt).getTime();
  const messages: Message[] = [];
  const push = (message: Omit<Message, 'message_id' | 'session_id' | 'task_id' | 'index'>) =>
    messages.push({
      message_id: generateId() as Message['message_id'],
      session_id: sessionId,
      task_id: taskId,
      index: messages.length,
      ...message,
      timestamp: new Date(start + messages.length * 2000).toISOString(),
    });

  for (const turn of turns) {
    if ('user' in turn) {
      push({
        type: 'user',
        role: MessageRole.USER,
        timestamp: '',
        content: turn.user,
        content_preview: turn.user.slice(0, 200),
      });
    } else if ('text' in turn) {
      push({
        type: 'assistant',
        role: MessageRole.ASSISTANT,
        timestamp: '',
        content: [{ type: 'text', text: turn.text }],
        content_preview: turn.text.slice(0, 200),
      });
    } else {
      const toolUseId = `example-${generateId()}`;
      const toolUse: ContentBlock = {
        type: 'tool_use',
        id: toolUseId,
        name: turn.tool,
        input: turn.input,
      };
      push({
        type: 'assistant',
        role: MessageRole.ASSISTANT,
        timestamp: '',
        content: [toolUse],
        content_preview: turn.tool,
        tool_uses: [{ id: toolUseId, name: turn.tool, input: turn.input }],
      });
      push({
        type: 'user',
        role: MessageRole.USER,
        timestamp: '',
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content: turn.output }],
        content_preview: turn.output,
        parent_tool_use_id: toolUseId,
      });
    }
  }
  return messages;
}
