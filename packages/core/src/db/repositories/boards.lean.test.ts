import { Buffer } from 'node:buffer';
import { performance } from 'node:perf_hooks';
import type { UserID } from '@agor/core/types';
import { eq, sql } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { update } from '../database-wrapper';
import { boards } from '../schema';
import { ownedDbTest as dbTest } from '../test-helpers';
import { BoardRepository } from './boards';

function omitAnnotations<T extends object>(board: T) {
  const {
    objects: _objects,
    custom_css: _css,
    ...rest
  } = board as T & {
    objects?: unknown;
    custom_css?: unknown;
  };
  return rest;
}

dbTest('lean lists remove only annotations before driver JSON decoding', async ({ db }) => {
  const repo = new BoardRepository(db);
  const board = await repo.create({ name: 'Projection', created_by: 'test-user' });
  const data = {
    description: 'retained',
    icon: ':rocket:',
    color: null,
    custom_context: { objects: 'nested objects stay', custom_css: 'nested CSS stays' },
    future_field: { nullable: null, list: [1, false, 'λ'] },
    objects: { note: { type: 'markdown', content: 'large'.repeat(20000) } },
    custom_css: 'css'.repeat(10000),
  };
  await update(db, boards).set({ data }).where(eq(boards.board_id, board.board_id)).run();
  const full = await repo.findById(board.board_id);
  const decoder = vi.spyOn(boards.data, 'mapFromDriverValue');
  try {
    for (const read of [
      () => repo.findAll({ lean: true }),
      async () => (await repo.findPage({ lean: true, limit: 1 })).data,
    ]) {
      decoder.mockClear();
      const result = await read();
      expect(result).toEqual([omitAnnotations(full!)]);
      const decoded = decoder.mock.calls.map(([value]) =>
        typeof value === 'string' ? JSON.parse(value) : value
      );
      expect(decoded).toEqual([omitAnnotations(data)]);
    }
    expect(await repo.findAll()).toEqual([full]);
    expect((await repo.findPage({ lean: false })).data).toEqual([full]);
  } finally {
    decoder.mockRestore();
  }
});

dbTest(
  'lean preserves missing/null fields, SQL filters, paging, sorting and RBAC',
  async ({ db }) => {
    const repo = new BoardRepository(db);
    const ids = [];
    for (const [name, data] of [
      ['A', {}],
      ['B', { objects: null, custom_css: null, description: null }],
      ['C', { objects: {}, custom_css: '', extra: false }],
    ] as const) {
      const board = await repo.create({ name, created_by: 'test-user', access_mode: 'private' });
      await update(db, boards).set({ data }).where(eq(boards.board_id, board.board_id)).run();
      ids.push(board.board_id);
    }
    await update(db, boards).set({ archived: true }).where(eq(boards.board_id, ids[2])).run();
    const options = { archived: false, sort: { name: -1 as const }, offset: 1, limit: 1 };
    const full = await repo.findPage(options);
    expect(full.total).toBe(2);
    expect(full.data.map((b) => b.name)).toEqual(['A']);
    expect(await repo.findPage({ ...options, lean: true })).toEqual({
      total: full.total,
      data: full.data.map(omitAnnotations),
    });
    expect(await repo.findAll({ lean: true })).toEqual((await repo.findAll()).map(omitAnnotations));
    expect(await repo.findAll({ lean: true, boardIds: [] })).toEqual([]);
    expect(await repo.findPage({ lean: true, boardIds: [] })).toEqual({ data: [], total: 0 });
    const stranger = 'unknown-user' as UserID;
    expect(await repo.findAll({ lean: true, visibleToUserId: stranger })).toEqual([]);
    expect(await repo.findPage({ lean: true, visibleToUserId: stranger })).toEqual({
      data: [],
      total: 0,
    });
  }
);

dbTest('lean retains legacy non-object conversion and JSON-null errors', async ({ db }) => {
  const repo = new BoardRepository(db);
  const board = await repo.create({ name: 'Legacy JSON', created_by: 'test-user' });
  for (const data of [['objects', 'custom_css'], 'legacy', 42, true]) {
    await update(db, boards).set({ data }).where(eq(boards.board_id, board.board_id)).run();
    expect(await repo.findAll({ lean: true })).toEqual((await repo.findAll()).map(omitAnnotations));
    expect((await repo.findPage({ lean: true })).data).toEqual(
      (await repo.findAll()).map(omitAnnotations)
    );
  }
  await update(db, boards)
    .set({ data: sql`'null'` })
    .where(eq(boards.board_id, board.board_id))
    .run();
  await expect(repo.findAll()).rejects.toThrow('Failed to find all boards');
  await expect(repo.findAll({ lean: true })).rejects.toThrow('Failed to find all boards');
  await expect(repo.findPage({ lean: true })).rejects.toThrow();
});

// Bounded synthetic benchmark, opt-in so CI never asserts noisy timing thresholds.
dbTest.skipIf(process.env.AGOR_BENCH_BOARD_LEAN !== '1')(
  'benchmark large annotations: previous full-fetch-and-strip versus SQL lean',
  async ({ db }) => {
    const repo = new BoardRepository(db);
    for (let i = 0; i < 24; i++) {
      await repo.create({
        name: `Benchmark ${i}`,
        created_by: 'test-user',
        objects: {
          note: {
            type: 'markdown',
            x: 0,
            y: 0,
            width: 300,
            content: 'Synthetic annotation λ '.repeat(12000),
          },
        },
        custom_css: '/* synthetic */'.repeat(4000),
        description: 'small retained metadata',
      });
    }
    const decoder = vi.spyOn(boards.data, 'mapFromDriverValue');
    const measure = async (lean: boolean) => {
      decoder.mockClear();
      const start = performance.now();
      const rows = await repo.findAll({ lean });
      const result = lean ? rows : rows.map(omitAnnotations);
      const ms = performance.now() - start;
      const bytes = decoder.mock.calls.reduce(
        (sum, [value]) =>
          sum + Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value)),
        0
      );
      return { ms, bytes, result };
    };
    try {
      await measure(false);
      await measure(true);
      const before = [],
        after = [];
      for (let i = 0; i < 9; i++) {
        const a = await measure(i % 2 === 0);
        const b = await measure(i % 2 !== 0);
        expect(a.result).toEqual(b.result);
        before.push(i % 2 === 0 ? b : a);
        after.push(i % 2 === 0 ? a : b);
      }
      const median = (values: number[]) => values.sort((a, b) => a - b)[4];
      process.stdout.write(
        'BOARD_LEAN_BENCHMARK ' +
          JSON.stringify({
            boards: 24,
            samples: 9,
            beforeBytes: before[0].bytes,
            afterBytes: after[0].bytes,
            beforeMedianMs: median(before.map((v) => v.ms)),
            afterMedianMs: median(after.map((v) => v.ms)),
          }) +
          '\n'
      );
      expect(after[0].bytes).toBeLessThan(before[0].bytes / 100);
    } finally {
      decoder.mockRestore();
    }
  },
  30000
);
