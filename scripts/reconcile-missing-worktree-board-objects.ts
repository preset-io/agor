#!/usr/bin/env tsx

/**
 * Reconcile Missing Worktree Board Objects
 *
 * Backfills board_objects rows for active worktrees that have board_id set
 * but are missing positioned board entities.
 *
 * Usage:
 *   pnpm tsx scripts/reconcile-missing-worktree-board-objects.ts
 *   pnpm tsx scripts/reconcile-missing-worktree-board-objects.ts --execute
 *
 * Notes:
 * - Default mode is dry-run.
 * - Placement uses the same smart board positioning utilities as worktree creation.
 */

import os from 'node:os';
import path from 'node:path';
import {
  BoardObjectRepository,
  BoardRepository,
  createDatabase,
  WorktreeRepository,
} from '@agor/core/db';
import type { BoardEntityObject, BoardID, WorktreeID, ZoneBoardObject } from '@agor/core/types';
import {
  computeDefaultBoardPosition,
  resolveEntityAbsolutePositions,
} from '@agor/core/utils/board-placement';

function resolveDatabaseUrl(): string {
  const dialect = process.env.AGOR_DB_DIALECT;
  if (dialect === 'postgresql') {
    return process.env.DATABASE_URL || 'postgresql://localhost:5432/agor';
  }

  const dbPath = path.join(os.homedir(), '.agor', 'agor.db');
  return process.env.DATABASE_URL || `file:${dbPath}`;
}

async function computePlacement(
  boardId: string,
  worktreeId: string,
  boardRepo: BoardRepository,
  boardObjectRepo: BoardObjectRepository,
  worktreeRepo: WorktreeRepository
): Promise<{ x: number; y: number }> {
  try {
    const board = await boardRepo.findById(boardId);
    const existing = await boardObjectRepo.findByBoardId(boardId as BoardID);
    const boardWorktrees = await worktreeRepo.findAll();
    const activeIds = new Set(
      boardWorktrees
        .filter((wt) => wt.board_id === boardId && wt.archived !== true)
        .map((wt) => wt.worktree_id)
    );

    const activeEntities = existing.filter((obj) => {
      if (!obj.worktree_id) return true;
      if (obj.worktree_id === worktreeId) return false;
      return activeIds.has(obj.worktree_id);
    });

    const zones = board?.objects
      ? Object.entries(board.objects)
          .filter(([, o]) => (o as { type?: string }).type === 'zone')
          .map(([id, o]) => ({ id, ...(o as ZoneBoardObject) }))
      : [];

    const absolute = resolveEntityAbsolutePositions(activeEntities as BoardEntityObject[], zones);
    return computeDefaultBoardPosition(absolute, zones);
  } catch {
    return { x: 100 + Math.random() * 200, y: 100 + Math.random() * 200 };
  }
}

async function main() {
  const execute = process.argv.includes('--execute');
  const db = createDatabase({ url: resolveDatabaseUrl() });

  const worktreeRepo = new WorktreeRepository(db);
  const boardObjectRepo = new BoardObjectRepository(db);
  const boardRepo = new BoardRepository(db);

  const worktrees = await worktreeRepo.findAll();
  const activeWithBoard = worktrees.filter((wt) => wt.archived !== true && wt.board_id);

  const missing: typeof activeWithBoard = [];
  for (const wt of activeWithBoard) {
    const boardObject = await boardObjectRepo.findByWorktreeId(wt.worktree_id);
    if (!boardObject) {
      missing.push(wt);
    }
  }

  console.log(`\n📋 Reconcile Missing Worktree Board Objects`);
  console.log(`   Mode: ${execute ? '🔴 EXECUTE' : '🟡 DRY RUN'}`);
  console.log(`   Active worktrees with board_id: ${activeWithBoard.length}`);
  console.log(`   Missing board_objects: ${missing.length}`);
  console.log('');

  if (missing.length === 0) {
    console.log('✅ Nothing to reconcile.');
    return;
  }

  console.log('Worktrees missing board placement:');
  for (const wt of missing) {
    console.log(`  ${wt.worktree_id.substring(0, 8)} | ${wt.name} | board=${wt.board_id}`);
  }
  console.log('');

  if (!execute) {
    console.log('🟡 DRY RUN complete. Re-run with --execute to create missing board objects.');
    return;
  }

  let created = 0;
  let failed = 0;
  for (const wt of missing) {
    try {
      const boardId = wt.board_id!;
      const position = await computePlacement(
        boardId,
        wt.worktree_id,
        boardRepo,
        boardObjectRepo,
        worktreeRepo
      );
      await boardObjectRepo.create({
        board_id: boardId as BoardID,
        worktree_id: wt.worktree_id as WorktreeID,
        position,
      });
      created++;
    } catch (error) {
      failed++;
      console.error(
        `   ❌ Failed for ${wt.worktree_id.substring(0, 8)} (${wt.name}): ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  console.log('');
  console.log(`✅ Done. Created: ${created}, Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
