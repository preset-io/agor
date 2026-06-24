/**
 * Demo Fixtures
 *
 * Lightweight, opt-in seeder that populates the database with a rich set of
 * hardcoded FAKE data — users, card types, repos, a board with zones, branches,
 * sessions with conversation transcripts, tasks, cards, and an artifact — so a
 * fresh dev/test Agor environment is immediately usable for end-to-end testing.
 *
 * Unlike {@link seedDevFixtures} (`SEED=true`), this seeder performs PURE DB
 * inserts: no git clones, no network, no executor. It is gated by the
 * `LOAD_FIXTURES=true` switch and is orthogonal/composable with `SEED`.
 *
 * Everything is prefixed `demo-` / `demo.` so it never collides with the real
 * `agor` repo (or its `test-branch`) created by {@link seedDevFixtures}.
 *
 * Idempotency / crash-safety: the entire load runs inside a SINGLE database
 * transaction, so it is strictly all-or-nothing. A mid-run failure (or kill)
 * rolls back every insert, leaving the DB exactly as it was. Because of that
 * atomicity, the demo admin user (`demo.alice@agor.live`) is a valid TERMINAL
 * sentinel: if it exists, the whole load committed, so re-running is a no-op.
 *
 * Demo users are loginable — passwords are bcrypt-hashed via the same path as
 * real users (see {@link DEMO_USER_CREDENTIALS}); the cleartext is printed in
 * the seed log so operators can sign in during E2E testing.
 *
 * ── PERF-TESTING TOOLING (opt-in scale knobs) ──────────────────────────────
 * Two env vars let you stand up a LARGE workspace to measure frontend perf.
 * BOTH default to NO behavior change — with the defaults the resulting DB
 * state is byte-identical to the original single demo workspace.
 *
 *   FIXTURE_SCALE          (int, default 1)
 *     Create N copies of the demo workspace: N boards, each with the full set
 *     of demo branches / sessions / tasks / messages / cards / artifact, with
 *     unique names/ids per copy. Scales GLOBAL collection counts (≈N boards,
 *     N×branches, N×sessions) to stress the initial-load bootstrap, which
 *     fetches global collections. Shared global singletons (demo users, card
 *     types, repos) are created ONCE regardless of scale.
 *
 *   FIXTURE_BIG_BOARD_NODES (int, default 0)
 *     If >0, create ONE extra board ("Perf Big Board") populated with that many
 *     board-object NODES — a mix of markdown notes and branch cards laid out on
 *     a grid — so the canvas has hundreds of nodes to stress pan/drag
 *     (`onNodesChange`).
 *
 * Usage:
 *   import { loadDemoFixtures } from '@agor/core/seed/demo-fixtures';
 *   await loadDemoFixtures({ skipIfExists: true });
 */

import os from 'node:os';
import path from 'node:path';
import type {
  Artifact,
  BoardID,
  BoardObject,
  Branch,
  Card,
  CardType,
  Message,
  Task,
  User,
  UUID,
} from '@agor/core/types';
import { MessageRole, SessionStatus, TaskStatus } from '@agor/core/types';
import bcrypt from 'bcryptjs';
import type { Database } from '../db/client';
import { txAsDb } from '../db/database-wrapper';
import {
  ArtifactRepository,
  BoardObjectRepository,
  BoardRepository,
  BranchRepository,
  CardRepository,
  CardTypeRepository,
  MessagesRepository,
  RepoRepository,
  SessionRepository,
  TaskRepository,
  UsersRepository,
} from '../db/repositories';
import { generateId } from '../lib/ids';

/**
 * Options for {@link loadDemoFixtures}.
 *
 * Mirrors {@link import('./dev-fixtures').SeedOptions} but `userId` is optional:
 * demo fixtures create and own their own demo users, so no pre-existing admin
 * is required. When `userId` IS provided (e.g. the bootstrapped admin passed by
 * the docker entrypoint) that user is added as an owner of the demo board and
 * branches so they show up immediately for the real operator too.
 */
export interface DemoFixturesOptions {
  /**
   * Optional real user to also grant ownership of the demo board/branches.
   * Demo entities are still attributed to the demo users regardless.
   */
  userId?: UUID;

  /**
   * Skip if demo data already exists (idempotent). Re-running is a no-op.
   */
  skipIfExists?: boolean;

  /**
   * Inject a database instance (used by tests). When omitted, the database is
   * resolved from `DATABASE_URL` / `AGOR_DB_DIALECT` like {@link seedDevFixtures}.
   */
  db?: Database;
}

export interface DemoFixturesResult {
  skipped: boolean;
  counts: {
    users: number;
    card_types: number;
    repos: number;
    boards: number;
    branches: number;
    sessions: number;
    tasks: number;
    messages: number;
    cards: number;
    artifacts: number;
  };
}

/**
 * Known cleartext credentials for the demo users (dev-only, LOAD_FIXTURES-gated).
 * Stored hashed with bcrypt so the users are loginable for E2E testing.
 */
export const DEMO_USER_CREDENTIALS: ReadonlyArray<{
  email: string;
  password: string;
  name: string;
  emoji: string;
  role: User['role'];
}> = [
  {
    email: 'demo.alice@agor.live',
    password: 'demo-password-alice',
    name: 'Alice Demo',
    emoji: '👩‍💻',
    role: 'admin',
  },
  {
    email: 'demo.bob@agor.live',
    password: 'demo-password-bob',
    name: 'Bob Demo',
    emoji: '🧑‍🔧',
    role: 'member',
  },
  {
    email: 'demo.carol@agor.live',
    password: 'demo-password-carol',
    name: 'Carol Demo',
    emoji: '👩‍🎨',
    role: 'member',
  },
  {
    email: 'demo.dave@agor.live',
    password: 'demo-password-dave',
    name: 'Dave Demo',
    emoji: '🧑‍🚀',
    role: 'viewer',
  },
];

/** Demo admin email — used as the terminal idempotency sentinel (see file docstring). */
const SENTINEL_EMAIL = DEMO_USER_CREDENTIALS[0].email;

/** bcrypt cost factor — matches `createUser` in db/user-utils.ts. */
const BCRYPT_ROUNDS = 12;

/**
 * Parse a non-negative integer env var, falling back to `fallback` on missing /
 * empty / non-numeric / out-of-range input. Used for the opt-in scale knobs so
 * a malformed value never changes default behavior.
 */
function parseIntEnv(raw: string | undefined, fallback: number, min: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min) return fallback;
  return n;
}

/**
 * Resolve the database the same way {@link seedDevFixtures} does, honoring
 * `DATABASE_URL` and `AGOR_DB_DIALECT`. Tests inject `options.db` to bypass this.
 */
async function resolveDatabase(options: DemoFixturesOptions): Promise<Database> {
  if (options.db) return options.db;

  let databaseUrl: string;
  const dialect = process.env.AGOR_DB_DIALECT;
  if (dialect === 'postgresql') {
    databaseUrl = process.env.DATABASE_URL || 'postgresql://localhost:5432/agor';
  } else {
    const dbPath = path.join(os.homedir(), '.agor', 'agor.db');
    databaseUrl = process.env.DATABASE_URL || `file:${dbPath}`;
  }

  const { createDatabase } = await import('../db/client');
  return createDatabase({ url: databaseUrl });
}

/**
 * Load hardcoded demo fixtures into the database.
 */
export async function loadDemoFixtures(
  options: DemoFixturesOptions = {}
): Promise<DemoFixturesResult> {
  const db = await resolveDatabase(options);

  // ── PERF-TESTING SCALE KNOBS (opt-in; defaults reproduce the original load) ──
  // FIXTURE_SCALE: number of demo-workspace copies (default 1 → unchanged).
  // FIXTURE_BIG_BOARD_NODES: nodes on an extra "Perf Big Board" (default 0 → none).
  const scale = parseIntEnv(process.env.FIXTURE_SCALE, 1, 1);
  const bigBoardNodes = parseIntEnv(process.env.FIXTURE_BIG_BOARD_NODES, 0, 0);

  const emptyCounts: DemoFixturesResult['counts'] = {
    users: 0,
    card_types: 0,
    repos: 0,
    boards: 0,
    branches: 0,
    sessions: 0,
    tasks: 0,
    messages: 0,
    cards: 0,
    artifacts: 0,
  };

  // Terminal idempotency sentinel. Because the load is atomic (single
  // transaction below), the demo admin existing means the WHOLE load committed
  // — so re-running is a safe no-op. A partial/crashed run leaves no sentinel.
  // NOTE: the sentinel is scale-agnostic. On a fresh volume, run once with the
  // desired FIXTURE_SCALE / FIXTURE_BIG_BOARD_NODES; a later re-run with
  // different values is skipped (wipe the DB to re-seed at a new scale).
  const sentinelCheck = new UsersRepository(db);
  if (await sentinelCheck.findByEmail(SENTINEL_EMAIL)) {
    console.log('✓ Demo fixtures already exist, skipping...');
    return { skipped: true, counts: emptyCounts };
  }

  console.log('🎭 Loading demo fixtures (hardcoded fake data, no git/network)...');
  if (scale > 1 || bigBoardNodes > 0) {
    console.log(
      `   ⚙️  perf scale: FIXTURE_SCALE=${scale}, FIXTURE_BIG_BOARD_NODES=${bigBoardNodes}`
    );
  }

  // Pre-hash demo passwords OUTSIDE the transaction (bcrypt is CPU-bound; no
  // reason to hold the DB transaction open while hashing).
  const hashedPasswords = await Promise.all(
    DEMO_USER_CREDENTIALS.map((c) => bcrypt.hash(c.password, BCRYPT_ROUNDS))
  );

  // Everything below runs in ONE transaction → all-or-nothing. Repos are bound
  // to the transaction handle via `txAsDb(tx)`. We use pre-generated IDs and
  // create-only writes (no repo.update calls) so we never open a NESTED
  // transaction inside this one.
  const counts = await db.transaction(async (tx) => {
    const t = txAsDb(tx);
    const usersRepo = new UsersRepository(t);
    const cardTypeRepo = new CardTypeRepository(t);
    const repoRepo = new RepoRepository(t);
    const boardRepo = new BoardRepository(t);
    const branchRepo = new BranchRepository(t);
    const boardObjectRepo = new BoardObjectRepository(t);
    const sessionRepo = new SessionRepository(t);
    const taskRepo = new TaskRepository(t);
    const messagesRepo = new MessagesRepository(t);
    const cardRepo = new CardRepository(t);
    const artifactRepo = new ArtifactRepository(t);

    // ── STEP 1: Users (bcrypt-hashed → loginable) ───────────────────────────
    // Global singletons — created ONCE regardless of FIXTURE_SCALE (the email
    // unique constraint makes per-copy duplication impossible anyway).
    console.log('1️⃣  Creating demo users...');
    const users = await Promise.all(
      DEMO_USER_CREDENTIALS.map((cred, i) =>
        usersRepo.create({
          email: cred.email,
          name: cred.name,
          emoji: cred.emoji,
          role: cred.role,
          onboarding_completed: true,
          // usersRepo.create stores `password` verbatim; we pass a bcrypt hash so
          // the auth layer's bcrypt.compare succeeds. Cast to surface `password`,
          // which is intentionally absent from the public User type.
          password: hashedPasswords[i],
        } as Partial<User>)
      )
    );
    const [alice, bob, carol] = users;

    // ── STEP 2: Card types (global) ─────────────────────────────────────────
    console.log('2️⃣  Creating demo card types...');
    const cardTypeSpecs: Array<Partial<CardType>> = [
      { name: 'Demo Bug', emoji: '🐛', color: '#ff4d4f', created_by: alice.user_id },
      { name: 'Demo Feature', emoji: '✨', color: '#1677ff', created_by: alice.user_id },
      { name: 'Demo Task', emoji: '✅', color: '#52c41a', created_by: alice.user_id },
    ];
    const cardTypes = await Promise.all(cardTypeSpecs.map((spec) => cardTypeRepo.create(spec)));
    const [bugType, featureType, taskType] = cardTypes;

    // ── STEP 3: Repos (demo-* slugs, placeholder paths, no git) ─────────────
    // Global singletons — created ONCE; scaled workspaces all reference these.
    console.log('3️⃣  Creating demo repos...');
    const webappRepo = await repoRepo.create({
      slug: 'demo-webapp',
      name: 'Demo Webapp',
      repo_type: 'local',
      local_path: '/tmp/demo-fixtures/demo-webapp',
      default_branch: 'main',
    });
    const apiRepo = await repoRepo.create({
      slug: 'demo-api',
      name: 'Demo API',
      repo_type: 'remote',
      remote_url: 'https://github.com/demo-org/demo-api.git',
      local_path: '/tmp/demo-fixtures/demo-api',
      default_branch: 'main',
    });
    const repos = [webappRepo, apiRepo];

    // ── Per-copy accumulators (scaled by FIXTURE_SCALE) ─────────────────────
    let boardsCount = 0;
    let branchesCount = 0;
    let sessionsCount = 0;
    let tasksCount = 0;
    let messagesCount = 0;
    let cardsCount = 0;
    let artifactsCount = 0;
    let firstBoardName = '';
    let firstBoardId = '';

    // Each iteration builds one COMPLETE demo workspace (board + branches +
    // sessions + tasks + messages + cards + artifact). For copy 0 the suffix is
    // empty, so all names/slugs/ids are byte-identical to the original fixture.
    for (let copy = 0; copy < scale; copy++) {
      // '' for the first copy → identical names/slugs to the original fixture.
      const suffix = copy === 0 ? '' : `-${copy + 1}`;
      // branch_unique_id offset keeps the high (9001+) range collision-free
      // across copies (copy 0 → 9001-9005, copy 1 → 9101-9105, ...).
      const uidOffset = copy * 100;
      // Suppress the noisy per-step logs for copies after the first; print one
      // concise progress line instead so scale=1 output stays identical.
      const verbose = copy === 0;
      if (!verbose) {
        console.log(`   ↳ workspace copy ${copy + 1}/${scale}...`);
      }

      // ── STEP 4: Board with zones ──────────────────────────────────────────
      if (verbose) console.log('4️⃣  Creating demo board with zones...');
      // Zones are `type: "zone"` entries in the board's `data.objects` map.
      const ZONE_W = 420;
      const ZONE_H = 960;
      const ZONE_GAP = 40;
      // Vertical layout for items stacked inside a zone. Branch cards render
      // ~280px tall, so use a generous stride to keep stacked branch/kanban cards
      // from overlapping. Rows resolve to y = 60, 400, 740 — all within ZONE_H.
      const ROW_Y0 = 60;
      const ITEM_STRIDE = 340;
      const rowY = (row: number) => ROW_Y0 + row * ITEM_STRIDE;
      const zoneIds = {
        todo: 'demo-zone-todo',
        inProgress: 'demo-zone-in-progress',
        review: 'demo-zone-review',
        done: 'demo-zone-done',
      };
      const zoneDefs: Array<{ id: string; label: string; color: string }> = [
        { id: zoneIds.todo, label: 'To Do', color: '#8c8c8c' },
        { id: zoneIds.inProgress, label: 'In Progress', color: '#1677ff' },
        { id: zoneIds.review, label: 'Review', color: '#faad14' },
        { id: zoneIds.done, label: 'Done', color: '#52c41a' },
      ];
      const initialObjects: Record<string, BoardObject> = {};
      zoneDefs.forEach((zone, i) => {
        initialObjects[zone.id] = {
          type: 'zone',
          x: i * (ZONE_W + ZONE_GAP),
          y: 0,
          width: ZONE_W,
          height: ZONE_H,
          label: zone.label,
          borderColor: zone.color,
          backgroundColor: `${zone.color}1a`,
        };
      });

      const board = await boardRepo.create({
        name: `Demo Board${suffix ? ` ${copy + 1}` : ''}`,
        slug: `demo-board${suffix}`,
        description: 'Demo board populated by LOAD_FIXTURES',
        icon: '🎭',
        color: '#722ed1',
        created_by: alice.user_id,
        objects: initialObjects,
      });
      const boardId = board.board_id as BoardID;
      await boardRepo.addOwner(boardId, alice.user_id);
      if (options.userId) {
        await boardRepo.addOwner(boardId, options.userId);
      }

      // ── STEP 5: Branches (no git ops) ───────────────────────────────────────
      if (verbose) console.log('5️⃣  Creating demo branches...');
      // High, fixed branch_unique_id range so port allocation never collides with
      // the real seeded branch (which uses a random 1..1000 id).
      const branchSpecs: Array<{
        name: string;
        repoId: UUID;
        creator: UUID;
        zoneId: string;
        rel: { x: number; y: number };
        uniqueId: number;
      }> = [
        {
          name: 'demo-feature-login',
          repoId: webappRepo.repo_id,
          creator: alice.user_id,
          zoneId: zoneIds.inProgress,
          rel: { x: 20, y: rowY(0) },
          uniqueId: 9001,
        },
        {
          name: 'demo-fix-navbar',
          repoId: webappRepo.repo_id,
          creator: bob.user_id,
          zoneId: zoneIds.todo,
          rel: { x: 20, y: rowY(0) },
          uniqueId: 9002,
        },
        {
          name: 'demo-refactor-api',
          repoId: apiRepo.repo_id,
          creator: carol.user_id,
          zoneId: zoneIds.review,
          rel: { x: 20, y: rowY(0) },
          uniqueId: 9003,
        },
        {
          name: 'demo-docs-update',
          repoId: webappRepo.repo_id,
          creator: bob.user_id,
          zoneId: zoneIds.done,
          rel: { x: 20, y: rowY(0) },
          uniqueId: 9004,
        },
        {
          name: 'demo-assistant',
          repoId: webappRepo.repo_id,
          creator: alice.user_id,
          zoneId: zoneIds.todo,
          rel: { x: 20, y: rowY(1) },
          uniqueId: 9005,
        },
      ];

      const branches: Branch[] = [];
      for (const spec of branchSpecs) {
        const branchName = `${spec.name}${suffix}`;
        const branch = await branchRepo.create({
          repo_id: spec.repoId,
          name: branchName,
          ref: branchName,
          path: `/tmp/demo-fixtures/worktrees/${branchName}`,
          base_ref: 'main',
          branch_unique_id: spec.uniqueId + uidOffset,
          created_by: spec.creator,
          board_id: boardId,
          needs_attention: false,
        });
        await branchRepo.addOwner(branch.branch_id, spec.creator);
        if (options.userId) {
          await branchRepo.addOwner(branch.branch_id, options.userId);
        }

        // ── STEP 6: Branch placement (board_objects row, pinned to a zone) ────
        await boardObjectRepo.create({
          board_id: boardId,
          branch_id: branch.branch_id,
          position: spec.rel,
          zone_id: spec.zoneId,
        });
        branches.push(branch);
      }
      const branchByName = new Map(branches.map((b) => [b.name, b]));
      const loginBranch = branchByName.get(`demo-feature-login${suffix}`)!;
      const navbarBranch = branchByName.get(`demo-fix-navbar${suffix}`)!;
      const refactorBranch = branchByName.get(`demo-refactor-api${suffix}`)!;
      const docsBranch = branchByName.get(`demo-docs-update${suffix}`)!;

      // ── STEP 7: Sessions (terminal status + genealogy) ──────────────────────
      if (verbose) console.log('7️⃣  Creating demo sessions with genealogy...');
      // Pre-generate session + task IDs so genealogy (parent/child, fork/spawn
      // points) and each session's `data.tasks` are fully consistent at insert
      // time — no follow-up updates (which would open a nested transaction).
      const rootSessionId = generateId() as UUID;
      const spawnedSessionId = generateId() as UUID;
      const forkedSessionId = generateId() as UUID;
      const soloSessionId = generateId() as UUID;
      const rootTaskId = generateId() as UUID;
      const spawnedTaskId = generateId() as UUID;
      const forkedTaskId = generateId() as UUID;
      const soloTaskId = generateId() as UUID;

      const now = Date.now();
      const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();

      // Root — completed; parent of the spawned child AND source of the forked
      // sibling. fork/spawn point fields live on the CHILDREN, not here.
      const rootSession = await sessionRepo.create({
        session_id: rootSessionId,
        branch_id: loginBranch.branch_id as UUID,
        created_by: alice.user_id,
        status: SessionStatus.COMPLETED,
        agentic_tool: 'claude-code',
        title: 'Implement login form',
        description: 'Add a login form with validation to the demo webapp',
        tasks: [rootTaskId],
        genealogy: { children: [spawnedSessionId, forkedSessionId] },
      });

      // Spawned child — fresh context window, child of root.
      const spawnedSession = await sessionRepo.create({
        session_id: spawnedSessionId,
        branch_id: navbarBranch.branch_id as UUID,
        created_by: alice.user_id,
        status: SessionStatus.IDLE,
        agentic_tool: 'claude-code',
        title: 'Fix navbar layout (spawned)',
        description: 'Spawned child of the login session',
        tasks: [spawnedTaskId],
        genealogy: {
          children: [],
          parent_session_id: rootSessionId,
          spawn_point_task_id: rootTaskId,
          spawn_point_message_index: 3,
        },
      });

      // Forked sibling — copies parent context at a fork point.
      const forkedSession = await sessionRepo.create({
        session_id: forkedSessionId,
        branch_id: refactorBranch.branch_id as UUID,
        created_by: carol.user_id,
        status: SessionStatus.COMPLETED,
        agentic_tool: 'codex',
        title: 'Refactor API client (forked)',
        description: 'Forked sibling of the login session',
        tasks: [forkedTaskId],
        genealogy: {
          children: [],
          forked_from_session_id: rootSessionId,
          fork_point_task_id: rootTaskId,
          fork_point_message_index: 3,
        },
      });

      // Independent root session on another branch.
      const soloSession = await sessionRepo.create({
        session_id: soloSessionId,
        branch_id: docsBranch.branch_id as UUID,
        created_by: bob.user_id,
        status: SessionStatus.IDLE,
        agentic_tool: 'gemini',
        title: 'Update documentation',
        description: 'Standalone documentation session',
        tasks: [soloTaskId],
        genealogy: { children: [] },
      });
      const sessions = [rootSession, spawnedSession, forkedSession, soloSession];

      // ── STEP 8: Tasks (one per session, matching each session's data.tasks) ──
      if (verbose) console.log('8️⃣  Creating demo tasks...');
      const taskSpecs: Array<Partial<Task>> = [
        {
          task_id: rootTaskId,
          session_id: rootSessionId,
          created_by: alice.user_id,
          status: TaskStatus.COMPLETED,
          full_prompt: 'Add a login form with email + password validation.',
          message_range: { start_index: 0, end_index: 3, start_timestamp: iso(0) },
          git_state: { ref_at_start: loginBranch.name, sha_at_start: 'demo000001' },
          completed_at: iso(60_000),
          tool_use_count: 1,
        },
        {
          task_id: spawnedTaskId,
          session_id: spawnedSessionId,
          created_by: alice.user_id,
          status: TaskStatus.COMPLETED,
          full_prompt: 'Fix the navbar so it stays pinned on scroll.',
          message_range: { start_index: 0, end_index: 3, start_timestamp: iso(120_000) },
          git_state: { ref_at_start: navbarBranch.name, sha_at_start: 'demo000002' },
          completed_at: iso(180_000),
          tool_use_count: 1,
        },
        {
          task_id: forkedTaskId,
          session_id: forkedSessionId,
          created_by: carol.user_id,
          status: TaskStatus.COMPLETED,
          full_prompt: 'Refactor the API client to use async/await.',
          message_range: { start_index: 0, end_index: 3, start_timestamp: iso(240_000) },
          git_state: { ref_at_start: refactorBranch.name, sha_at_start: 'demo000003' },
          completed_at: iso(300_000),
          tool_use_count: 1,
        },
        {
          task_id: soloTaskId,
          session_id: soloSessionId,
          created_by: bob.user_id,
          status: TaskStatus.COMPLETED,
          full_prompt: 'Update the README with setup instructions.',
          message_range: { start_index: 0, end_index: 3, start_timestamp: iso(360_000) },
          git_state: { ref_at_start: docsBranch.name, sha_at_start: 'demo000004' },
          completed_at: iso(420_000),
          tool_use_count: 1,
        },
      ];
      const createdTasks = await Promise.all(taskSpecs.map((spec) => taskRepo.create(spec)));

      // ── STEP 9: Messages (readable transcript per session) ──────────────────
      if (verbose) console.log('9️⃣  Creating demo message transcripts...');
      const allMessages: Message[] = [];
      for (const task of createdTasks) {
        const sessionId = task.session_id as UUID;
        const taskId = task.task_id as UUID;
        const toolUseId = `demo-tool-${generateId()}`;
        const taskBase = new Date(task.message_range?.start_timestamp ?? iso(0)).getTime();
        const ts = (i: number) => new Date(taskBase + i * 1000).toISOString();

        allMessages.push(
          {
            message_id: generateId() as UUID,
            session_id: sessionId,
            task_id: taskId,
            type: 'user',
            role: MessageRole.USER,
            index: 0,
            timestamp: ts(0),
            content_preview: task.full_prompt ?? '',
            content: task.full_prompt ?? '',
            metadata: { source: 'agor' },
          },
          {
            message_id: generateId() as UUID,
            session_id: sessionId,
            task_id: taskId,
            type: 'assistant',
            role: MessageRole.ASSISTANT,
            index: 1,
            timestamp: ts(1),
            content_preview: "I'll make that change now.",
            content: [
              { type: 'text', text: "Sure — I'll make that change now." },
              {
                type: 'tool_use',
                id: toolUseId,
                name: 'Write',
                input: { file_path: 'src/App.tsx', content: '// demo change\n' },
              },
            ],
            tool_uses: [
              {
                id: toolUseId,
                name: 'Write',
                input: { file_path: 'src/App.tsx', content: '// demo change\n' },
              },
            ],
            metadata: { model: 'claude-demo', tokens: { input: 120, output: 45 } },
          },
          {
            message_id: generateId() as UUID,
            session_id: sessionId,
            task_id: taskId,
            type: 'user',
            role: MessageRole.USER,
            index: 2,
            timestamp: ts(2),
            content_preview: 'File written successfully.',
            content: [
              {
                type: 'tool_result',
                tool_use_id: toolUseId,
                content: 'File written successfully (1 file changed).',
              },
            ],
            parent_tool_use_id: toolUseId,
          },
          {
            message_id: generateId() as UUID,
            session_id: sessionId,
            task_id: taskId,
            type: 'assistant',
            role: MessageRole.ASSISTANT,
            index: 3,
            timestamp: ts(3),
            content_preview: 'Done! The change is in place.',
            content: 'Done! The change is in place and ready for review.',
            metadata: { model: 'claude-demo', tokens: { input: 130, output: 30 } },
          }
        );
      }
      await messagesRepo.createMany(allMessages);

      // ── STEP 10: Cards (placed via board_objects rows) ──────────────────────
      if (verbose) console.log('🔟 Creating demo cards...');
      const cardSpecs: Array<{
        title: string;
        type: CardType;
        description: string;
        zoneId: string;
        rel: { x: number; y: number };
        creator: UUID;
      }> = [
        {
          title: 'Login button misaligned on mobile',
          type: bugType,
          description: 'The login button overflows on small viewports.',
          zoneId: zoneIds.todo,
          rel: { x: 20, y: rowY(2) },
          creator: bob.user_id,
        },
        {
          title: 'Add dark mode toggle',
          type: featureType,
          description: 'Users want a dark mode switch in settings.',
          zoneId: zoneIds.inProgress,
          rel: { x: 20, y: rowY(1) },
          creator: carol.user_id,
        },
        {
          title: 'Write integration tests',
          type: taskType,
          description: 'Cover the checkout flow with integration tests.',
          zoneId: zoneIds.review,
          rel: { x: 20, y: rowY(1) },
          creator: alice.user_id,
        },
        {
          title: 'Ship v1.0 release notes',
          type: taskType,
          description: 'Draft and publish the v1.0 release notes.',
          zoneId: zoneIds.done,
          rel: { x: 20, y: rowY(1) },
          creator: alice.user_id,
        },
      ];
      const cards: Card[] = [];
      for (const spec of cardSpecs) {
        const card = await cardRepo.create({
          board_id: boardId,
          card_type_id: spec.type.card_type_id,
          title: spec.title,
          description: spec.description,
          created_by: spec.creator,
        });
        await boardObjectRepo.create({
          board_id: boardId,
          card_id: card.card_id as UUID,
          position: spec.rel,
          zone_id: spec.zoneId,
        });
        cards.push(card);
      }

      // ── STEP 11: Artifact (placed via a board.data.objects entry) ───────────
      if (verbose) console.log('🎨 Creating demo artifact...');
      // A public, self-owned artifact needs no artifact_trust_grants row.
      const artifact: Artifact = await artifactRepo.create({
        board_id: boardId,
        name: 'Demo Counter App',
        description: 'A tiny React counter rendered via Sandpack',
        template: 'react',
        public: true,
        created_by: alice.user_id,
        entry: '/index.js',
        files: {
          '/package.json': JSON.stringify(
            {
              name: 'demo-counter',
              version: '1.0.0',
              dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' },
              main: '/index.js',
            },
            null,
            2
          ),
          '/index.js': [
            "import React from 'react';",
            "import { createRoot } from 'react-dom/client';",
            "import App from './App';",
            "createRoot(document.getElementById('root')).render(<App />);",
            '',
          ].join('\n'),
          '/App.js': [
            "import React, { useState } from 'react';",
            '',
            'export default function App() {',
            '  const [count, setCount] = useState(0);',
            '  return (',
            "    <div style={{ fontFamily: 'sans-serif', padding: 24 }}>",
            '      <h1>Demo Counter</h1>',
            '      <p>Count: {count}</p>',
            '      <button onClick={() => setCount((c) => c + 1)}>Increment</button>',
            '    </div>',
            '  );',
            '}',
            '',
          ].join('\n'),
        },
      });

      // Artifact layout lives as an entry in board.data.objects, keyed
      // `artifact-<artifactId>`, with type 'artifact' + x/y/width/height + artifact_id.
      const artifactObjectKey = `artifact-${artifact.artifact_id}`;
      const artifactsRightEdge = zoneDefs.length * (ZONE_W + ZONE_GAP);
      await boardRepo.upsertBoardObject(boardId, artifactObjectKey, {
        type: 'artifact',
        artifact_id: artifact.artifact_id as UUID,
        x: artifactsRightEdge,
        y: 0,
        width: 600,
        height: 400,
      });

      // Tally this workspace copy.
      boardsCount += 1;
      branchesCount += branches.length;
      sessionsCount += sessions.length;
      tasksCount += createdTasks.length;
      messagesCount += allMessages.length;
      cardsCount += cards.length;
      artifactsCount += 1;
      if (copy === 0) {
        firstBoardName = board.name;
        firstBoardId = board.board_id;
      }
    }

    // ── PERF BIG BOARD (opt-in via FIXTURE_BIG_BOARD_NODES) ─────────────────
    // One extra board crammed with `bigBoardNodes` canvas nodes — a mix of
    // markdown notes (pure board.data.objects entries) and branch cards
    // (board_objects rows). Laid out on a square grid. Exercises the heavy
    // (branch card) and light (markdown) node renderers plus `onNodesChange`
    // during pan/drag.
    if (bigBoardNodes > 0) {
      console.log(`🧱 Creating "Perf Big Board" with ${bigBoardNodes} nodes...`);
      const cols = Math.max(1, Math.ceil(Math.sqrt(bigBoardNodes)));
      const CELL_W = 360;
      const CELL_H = 320;
      const gridPos = (i: number) => ({
        x: (i % cols) * CELL_W,
        y: Math.floor(i / cols) * CELL_H,
      });

      // Markdown notes are seeded directly into the board's initial objects map
      // (no FK dependencies). Even indices → markdown, odd → branch card.
      const bigObjects: Record<string, BoardObject> = {};
      let noteCount = 0;
      let branchCardCount = 0;
      for (let i = 0; i < bigBoardNodes; i++) {
        if (i % 2 === 0) {
          const pos = gridPos(i);
          bigObjects[`perf-note-${i}`] = {
            type: 'markdown',
            x: pos.x,
            y: pos.y,
            width: 300,
            content: `### Perf note ${i}\n\nFiller markdown node for canvas stress testing.`,
          };
          noteCount++;
        }
      }

      const bigBoard = await boardRepo.create({
        name: 'Perf Big Board',
        slug: 'perf-big-board',
        description: `Perf-testing canvas board with ${bigBoardNodes} nodes`,
        icon: '🧱',
        color: '#eb2f96',
        created_by: alice.user_id,
        objects: bigObjects,
      });
      const bigBoardId = bigBoard.board_id as BoardID;
      await boardRepo.addOwner(bigBoardId, alice.user_id);
      if (options.userId) {
        await boardRepo.addOwner(bigBoardId, options.userId);
      }

      // Odd indices → branch cards (branch row + board_objects placement). High
      // branch_unique_id base (20000+) stays clear of the scaled workspace range.
      for (let i = 0; i < bigBoardNodes; i++) {
        if (i % 2 === 1) {
          const pos = gridPos(i);
          const branchName = `perf-big-node-${i}`;
          const branch = await branchRepo.create({
            repo_id: webappRepo.repo_id,
            name: branchName,
            ref: branchName,
            path: `/tmp/demo-fixtures/worktrees/${branchName}`,
            base_ref: 'main',
            branch_unique_id: 20000 + i,
            created_by: alice.user_id,
            board_id: bigBoardId,
            needs_attention: false,
          });
          await branchRepo.addOwner(branch.branch_id, alice.user_id);
          if (options.userId) {
            await branchRepo.addOwner(branch.branch_id, options.userId);
          }
          await boardObjectRepo.create({
            board_id: bigBoardId,
            branch_id: branch.branch_id,
            position: pos,
          });
          branchCardCount++;
        }
      }

      boardsCount += 1;
      branchesCount += branchCardCount;
      console.log(
        `   Perf Big Board: ${noteCount} markdown notes + ${branchCardCount} branch cards`
      );
    }

    console.log('✅ Demo fixtures loaded successfully!');
    if (scale === 1) {
      console.log(`   Board:    ${firstBoardName} (${firstBoardId})`);
    } else {
      console.log(`   Boards:   ${scale} workspace copies (first: ${firstBoardName})`);
    }
    console.log(
      `   Totals:   branches=${branchesCount}, sessions=${sessionsCount}, ` +
        `tasks=${tasksCount}, messages=${messagesCount}, cards=${cardsCount}`
    );
    console.log('   Demo login credentials (dev-only):');
    for (const cred of DEMO_USER_CREDENTIALS) {
      console.log(`     • ${cred.email} / ${cred.password}  (${cred.role})`);
    }

    return {
      users: users.length,
      card_types: cardTypes.length,
      repos: repos.length,
      boards: boardsCount,
      branches: branchesCount,
      sessions: sessionsCount,
      tasks: tasksCount,
      messages: messagesCount,
      cards: cardsCount,
      artifacts: artifactsCount,
    } satisfies DemoFixturesResult['counts'];
  });

  return { skipped: false, counts };
}
