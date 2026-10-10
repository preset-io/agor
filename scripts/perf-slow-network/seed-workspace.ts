#!/usr/bin/env tsx
/**
 * Seed a synthetic, realistically sized Agor workspace for the slow-network
 * benchmark (see ./README.md). Every row is generated — no real data.
 *
 * Shape (defaults match a large single-tenant workspace):
 *   ~1,200 sessions (~400 active), ~70 active branches (+ ~460 archived ones
 *   still placed on boards), ~700 board placements, ~180 cards, 12 boards,
 *   board comments, and a handful of sessions with very large transcripts and
 *   heavy `custom_context` (scheduled_run / slash_commands / skills).
 *
 * Usage (HOME must point at a throwaway Agor home that is already migrated and
 * has an admin user):
 *   HOME=/tmp/x NODE_OPTIONS=--conditions=source \
 *     pnpm --filter @agor/daemon exec tsx ../../scripts/perf-slow-network/seed-workspace.ts \
 *     --out /tmp/x/bench-manifest.json
 */

import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfigSync, resolveBootstrapTenantId } from '@agor/core/config';
import {
  BoardCommentsRepository,
  BoardObjectRepository,
  BoardRepository,
  BranchRepository,
  CardRepository,
  CardTypeRepository,
  createDatabase,
  createTenantScopedDatabaseProxy,
  MessagesRepository,
  RepoRepository,
  runWithTenantDatabaseScope,
  SessionRepository,
  TaskRepository,
  UsersRepository,
} from '@agor/core/db';

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const SCALE = Number(arg('scale', '1'));
const N = (n: number) => Math.max(1, Math.round(n * SCALE));
const ACTIVE_BRANCHES = N(70);
const ARCHIVED_PLACED_BRANCHES = N(460);
const TOTAL_SESSIONS = N(1200);
const ACTIVE_SESSIONS = N(400);
const CARDS = N(180);
const BOARDS = 12;
const COMMENTS = N(150);
const BIG_SESSIONS = 6;
const BIG_SESSION_TASKS = 120;
const OUT = arg('out', path.join(os.homedir(), 'bench-manifest.json'))!;

// Deterministic PRNG so every run of the seed produces the same shape.
let seed = 0x2887;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x100000000;
};
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

const WORDS =
  'agent branch board session daemon socket render hydrate payload transcript cache query index tenant policy review commit merge rebase deploy migrate schema service handler realtime stream patch event queue worker scheduler prompt model token context window latency bandwidth compression frame bundle chunk lazy virtualize selector reducer store component hook effect layout canvas zone card comment genealogy fork spawn report artifact terminal environment health logs'.split(
    ' '
  );
const sentence = (n: number) => `${Array.from({ length: n }, () => pick(WORDS)).join(' ')}.`;
const paragraph = (sentences: number) =>
  Array.from({ length: sentences }, () => sentence(int(6, 18))).join(' ');
// Text of roughly `bytes` bytes. Mixed code/prose so it compresses like real
// tool output (3–8×), not like a repeated string.
const blob = (bytes: number) => {
  const parts: string[] = [];
  let size = 0;
  while (size < bytes) {
    const line =
      rand() < 0.4
        ? `  ${pick(['const', 'let', 'await', 'return', 'if'])} ${pick(WORDS)}${int(0, 999)} = ${pick(WORDS)}.${pick(WORDS)}(${int(0, 99999)}); // ${sentence(int(3, 8))}`
        : paragraph(1);
    parts.push(line);
    size += line.length + 1;
  }
  return parts.join('\n');
};
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();

const slashCommands = () =>
  Array.from({ length: int(25, 45) }, (_, i) => ({
    name: `${pick(WORDS)}-${pick(WORDS)}-${i}`,
    description: sentence(int(6, 14)),
    argumentHint: rand() < 0.3 ? `<${pick(WORDS)}>` : undefined,
  }));
const skills = () =>
  Array.from({ length: int(6, 14) }, () => ({
    name: `${pick(WORDS)}-${pick(WORDS)}`,
    description: sentence(int(8, 16)),
  }));

async function main() {
  const dbPath = path.join(os.homedir(), '.agor', 'agor.db');
  const db = createTenantScopedDatabaseProxy(
    createDatabase({ url: process.env.DATABASE_URL || `file:${dbPath}` })
  );
  const tenantId = resolveBootstrapTenantId(loadConfigSync());

  await runWithTenantDatabaseScope(db, tenantId, async () => {
    const usersRepo = new UsersRepository(db);
    const repoRepo = new RepoRepository(db);
    const boardRepo = new BoardRepository(db);
    const branchRepo = new BranchRepository(db);
    const boardObjectRepo = new BoardObjectRepository(db);
    const cardTypeRepo = new CardTypeRepository(db);
    const cardRepo = new CardRepository(db);
    const commentRepo = new BoardCommentsRepository(db);
    const sessionRepo = new SessionRepository(db);
    const taskRepo = new TaskRepository(db);
    const messageRepo = new MessagesRepository(db);

    const users = await usersRepo.findAll();
    const admin = users.find((u) => u.role === 'superadmin' || u.role === 'admin') ?? users[0];
    if (!admin) throw new Error('No admin user — run `agor local create-admin` first');
    const adminId = admin.user_id;
    // A long-lived account, not a first run: no onboarding wizard (which would
    // also try to clone the framework repo from GitHub).
    await usersRepo.update(adminId, { onboarding_completed: true } as never);
    console.log(`admin ${admin.email} (${adminId})`);

    // ── Repos ────────────────────────────────────────────────────────────
    const repos = [];
    for (let i = 0; i < 6; i++) {
      const slug = `synthetic-repo-${i}`;
      repos.push(
        await repoRepo.create({
          slug,
          name: `Synthetic Repo ${i}`,
          repo_type: 'remote',
          remote_url: `https://example.invalid/synthetic/${slug}.git`,
          local_path: `/tmp/agor-bench-nonexistent/repos/${slug}`,
          default_branch: 'main',
        })
      );
    }

    // ── Boards (with zones + text annotations + a bit of custom CSS) ─────
    const boards = [];
    for (let b = 0; b < BOARDS; b++) {
      const objects: Record<string, unknown> = {};
      for (let z = 0; z < int(3, 7); z++) {
        objects[`zone-${b}-${z}`] = {
          type: 'zone',
          x: z * 900,
          y: 0,
          width: 850,
          height: 1400,
          label: `${pick(WORDS)} ${pick(WORDS)}`,
          borderColor: '#4096ff',
          trigger:
            rand() < 0.5
              ? {
                  behavior: 'show_picker',
                  template: `${paragraph(4)}\n{{branch.name}} {{session.title}}`,
                }
              : undefined,
        };
      }
      for (let t = 0; t < int(2, 6); t++) {
        objects[`md-${b}-${t}`] = {
          type: 'markdown',
          x: t * 400,
          y: -600,
          width: 380,
          height: 300,
          content: `## ${sentence(4)}\n\n${paragraph(int(3, 8))}`,
        };
      }
      boards.push(
        await boardRepo.create({
          name: b === 0 ? 'Platform' : `Board ${b} ${pick(WORDS)}`,
          slug: b === 0 ? 'platform' : undefined,
          description: sentence(10),
          created_by: adminId,
          objects: objects as never,
          custom_css:
            b % 3 === 0 ? `.board-${b} { --accent: #${b}0${b}0ff; }\n${blob(600)}` : undefined,
          color: '#1677ff',
          icon: pick(['⭐', '🚀', '🧪', '📦', '🛠️']),
        })
      );
    }
    // Board 0 ("Platform") is the heavy one the benchmark opens.
    const boardFor = (i: number) => (i % 3 === 0 ? boards[0]! : boards[1 + (i % (BOARDS - 1))]!);

    // ── Branches: active + archived-but-still-placed ─────────────────────
    const activeBranches = [];
    const archivedBranches = [];
    let uniqueId = 100;
    const mkBranch = async (i: number, archived: boolean) => {
      const repo = pick(repos);
      const name = `${archived ? 'old' : 'feat'}-${pick(WORDS)}-${pick(WORDS)}-${i}`;
      const board = boardFor(i);
      const branch = await branchRepo.create({
        repo_id: repo.repo_id,
        name,
        ref: name,
        path: `/tmp/agor-bench-nonexistent/worktrees/${repo.slug}/${name}`,
        base_ref: 'main',
        new_branch: true,
        branch_unique_id: uniqueId++,
        created_by: adminId,
        board_id: board.board_id,
        needs_attention: rand() < 0.1,
        notes: rand() < 0.5 ? paragraph(int(2, 6)) : undefined,
        issue_url: rand() < 0.4 ? `https://example.invalid/issues/${int(1, 9999)}` : undefined,
        pull_request_url: rand() < 0.5 ? `https://example.invalid/pull/${int(1, 9999)}` : undefined,
        custom_context: { owner_note: paragraph(int(3, 10)), labels: [pick(WORDS), pick(WORDS)] },
        ...(archived ? { archived: true, archived_at: iso(int(10, 200)) } : {}),
      } as never);
      await boardObjectRepo.create({
        board_id: board.board_id,
        branch_id: branch.branch_id,
        position: { x: int(-4000, 4000), y: int(-3000, 3000) },
      });
      return branch;
    };
    for (let i = 0; i < ACTIVE_BRANCHES; i++) activeBranches.push(await mkBranch(i, false));
    for (let i = 0; i < ARCHIVED_PLACED_BRANCHES; i++)
      archivedBranches.push(await mkBranch(ACTIVE_BRANCHES + i, true));
    console.log(`branches: ${activeBranches.length} active, ${archivedBranches.length} archived`);

    // ── Cards ─────────────────────────────────────────────────────────────
    const cardTypes = [];
    for (const name of ['Incident', 'Idea', 'Customer', 'Release']) {
      cardTypes.push(
        await cardTypeRepo.create({
          name,
          emoji: '🗂️',
          color: '#722ed1',
          created_by: adminId,
          json_schema: {
            type: 'object',
            properties: Object.fromEntries(
              Array.from({ length: 8 }, () => [pick(WORDS), { type: 'string' }])
            ),
          },
        })
      );
    }
    for (let i = 0; i < CARDS; i++) {
      const board = boardFor(i);
      const card = await cardRepo.create({
        board_id: board.board_id,
        card_type_id: pick(cardTypes).card_type_id,
        title: sentence(int(3, 7)),
        description: paragraph(int(1, 4)),
        note: rand() < 0.5 ? paragraph(int(1, 3)) : undefined,
        data: Object.fromEntries(Array.from({ length: 6 }, () => [pick(WORDS), sentence(5)])),
        created_by: adminId,
      });
      await boardObjectRepo.create({
        board_id: board.board_id,
        card_id: card.card_id,
        position: { x: int(-4000, 4000), y: int(-3000, 3000) },
      });
    }

    // ── Sessions ──────────────────────────────────────────────────────────
    // Active sessions live on active branches; archived sessions spread over
    // archived branches (and some on active ones).
    const sessionIds: { id: string; branchId: string; boardId: string | null; big: boolean }[] = [];
    for (let i = 0; i < TOTAL_SESSIONS; i++) {
      const active = i < ACTIVE_SESSIONS;
      const branch = active || rand() < 0.2 ? pick(activeBranches) : pick(archivedBranches);
      const big = i < BIG_SESSIONS;
      const scheduled = rand() < 0.3;
      const custom_context: Record<string, unknown> = {};
      if (rand() < 0.6) custom_context.slash_commands = slashCommands();
      if (rand() < 0.5) custom_context.skills = skills();
      if (scheduled) {
        custom_context.scheduled_run = {
          rendered_prompt: `${paragraph(int(8, 30))}\n\n${blob(int(800, 4000))}`,
          run_index: int(1, 400),
          triggered_manually: rand() < 0.1,
        };
      }
      const session = await sessionRepo.create({
        agentic_tool: pick(['claude-code', 'claude-code', 'codex']) as never,
        status: pick(['idle', 'idle', 'idle', 'completed']) as never,
        created_by: adminId,
        branch_id: branch.branch_id,
        title: sentence(int(4, 9)).slice(0, 120),
        description: rand() < 0.5 ? paragraph(2) : undefined,
        contextFiles: [],
        genealogy: { children: [] },
        tasks: [],
        custom_context,
        model_config: {
          mode: 'alias',
          model: pick(['sonnet', 'opus']),
          updated_at: iso(3),
          effort: 'high',
        },
        scheduled_from_branch: scheduled,
        ready_for_prompt: true,
        archived: !active,
        ...(active ? {} : { archived_reason: 'manual' }),
        created_at: iso(int(0, 120)),
        last_updated: iso(int(0, 30)),
      } as never);
      sessionIds.push({
        id: session.session_id,
        branchId: branch.branch_id,
        boardId: branch.board_id ?? null,
        big,
      });
    }
    console.log(`sessions: ${sessionIds.length}`);

    // ── Tasks + messages ──────────────────────────────────────────────────
    let messageCount = 0;
    const writeTranscript = async (sessionId: string, turns: number, heavy: boolean) => {
      let index = 0;
      const taskIds: string[] = [];
      for (let t = 0; t < turns; t++) {
        const start = index;
        const task = await taskRepo.create({
          session_id: sessionId as never,
          created_by: adminId,
          full_prompt: paragraph(int(1, heavy ? 6 : 3)),
          status: 'completed' as never,
          message_range: { start_index: start, end_index: start, start_timestamp: iso(1) },
          git_state: { ref_at_start: 'main', sha_at_start: 'deadbeef'.repeat(5) },
          model: 'claude-sonnet-synthetic',
          normalized_sdk_response: {
            tokenUsage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
            costUsd: 0.01,
          },
        } as never);
        taskIds.push(task.task_id);
        const push = async (role: 'user' | 'assistant', content: unknown, preview: string) => {
          await messageRepo.create({
            session_id: sessionId as never,
            task_id: task.task_id,
            type: role as never,
            role: role as never,
            index: index++,
            timestamp: iso(1),
            content_preview: preview.slice(0, 200),
            content: content as never,
          });
          messageCount++;
        };
        await push('user', task.full_prompt, task.full_prompt);
        const steps = heavy ? int(3, 7) : int(1, 3);
        for (let s = 0; s < steps; s++) {
          const toolId = `toolu_${sessionId.slice(0, 8)}_${t}_${s}`;
          const text = paragraph(int(2, 6));
          await push(
            'assistant',
            [
              { type: 'text', text },
              {
                type: 'tool_use',
                id: toolId,
                name: pick(['Bash', 'Read', 'Edit', 'Grep']),
                input: { command: sentence(8), file_path: `/src/${pick(WORDS)}.ts` },
              },
            ],
            text
          );
          await push(
            'user',
            [
              {
                type: 'tool_result',
                tool_use_id: toolId,
                content: blob(heavy ? int(4_000, 16_000) : int(300, 1_500)),
              },
            ],
            'tool result'
          );
        }
        const summary = paragraph(int(2, heavy ? 10 : 4));
        await push('assistant', [{ type: 'text', text: summary }], summary);
        await taskRepo.update(task.task_id, {
          message_range: {
            start_index: start,
            end_index: index - 1,
            start_timestamp: iso(1),
            end_timestamp: iso(1),
          },
        } as never);
      }
      await sessionRepo.update(sessionId, { tasks: taskIds } as never);
    };

    for (const [i, s] of sessionIds.entries()) {
      if (s.big) await writeTranscript(s.id, BIG_SESSION_TASKS, true);
      else if (i < ACTIVE_SESSIONS) await writeTranscript(s.id, int(1, 5), false);
      else if (rand() < 0.25) await writeTranscript(s.id, int(1, 3), false);
      if (i % 100 === 0)
        console.log(`  transcripts ${i}/${sessionIds.length} (${messageCount} msgs)`);
    }

    // ── Comments ──────────────────────────────────────────────────────────
    for (let i = 0; i < COMMENTS; i++) {
      const board = boardFor(i);
      const content = paragraph(int(1, 4));
      await commentRepo.create({
        board_id: board.board_id,
        created_by: adminId,
        content,
        content_preview: content.slice(0, 200),
        resolved: rand() < 0.3,
        reactions: [],
      } as never);
    }

    // Open target: the first big session lives on a board-0 branch? Prefer one
    // whose branch is on the Platform board so both scenarios share a board.
    const platform = boards[0]!;
    const open =
      sessionIds.find((s) => s.big && s.boardId === platform.board_id) ??
      sessionIds.find((s) => s.big)!;
    // The session you open is usually one you're working on: make it the most
    // recently updated (it then arrives in the UI's recent-sessions slice).
    await sessionRepo.update(open.id, { title: 'Benchmark: large transcript' } as never);
    const openTasks = await taskRepo.findAll({ sessionId: open.id as never });
    const latestTask = openTasks.sort((a, b) =>
      a.message_range.start_index < b.message_range.start_index ? -1 : 1
    )[openTasks.length - 1];
    const manifest = {
      generatedAt: new Date().toISOString(),
      scale: SCALE,
      adminEmail: admin.email,
      openSessionId: open.id,
      // The benchmark's "transcript painted" mark: the newest turn's prompt.
      latestPromptSnippet: latestTask?.full_prompt.slice(0, 48),
      boardId: platform.board_id,
      boardSlug: platform.slug,
      counts: {
        activeBranches: activeBranches.length,
        archivedPlacedBranches: archivedBranches.length,
        sessions: sessionIds.length,
        activeSessions: ACTIVE_SESSIONS,
        cards: CARDS,
        boards: BOARDS,
        comments: COMMENTS,
        messages: messageCount,
      },
    };
    writeFileSync(OUT, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(JSON.stringify(manifest, null, 2));
  });
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
