import { LIST_SYNC_HASH_LENGTH } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findAllVersioned, type LiveRowLookup, resetListSyncVersions } from './listSync';

type Card = { card_id: string; title: string };

const v = (char: string) => char.repeat(LIST_SYNC_HASH_LENGTH);

/**
 * A fake daemon that versions rows by title (a stand-in for the server hash)
 * and a fake store whose rows the test controls.
 */
function setup(serverRows: Card[]) {
  const store = new Map<string, Card>();
  const live: LiveRowLookup = (_path, id) => store.get(id);
  const versionOf = (row: Card) => v(row.title[0]);
  const find = vi.fn(async ({ query }: { query: Record<string, unknown> }) => {
    const known = String((query.$sync as { known: string }).known);
    const slots = new Map<string, number>();
    for (let i = 0; i * LIST_SYNC_HASH_LENGTH < known.length; i += 1) {
      slots.set(known.slice(i * LIST_SYNC_HASH_LENGTH, (i + 1) * LIST_SYNC_HASH_LENGTH), i);
    }
    const skip = Number(query.$skip ?? 0);
    const limit = Number(query.$limit ?? 100);
    const pageRows = serverRows.slice(skip, skip + limit);
    let versions = '';
    const data = pageRows.map((row) => {
      const slot = slots.get(versionOf(row));
      if (slot !== undefined) return slot;
      versions += versionOf(row);
      return { ...row };
    });
    return { total: serverRows.length, limit, skip, data, $sync: { versions } };
  });
  const findAll = vi.fn(async () => serverRows.map((row) => ({ ...row })));
  const client = { service: () => ({ find, findAll }) };
  const read = async () => {
    const rows = await findAllVersioned<Card>(client, 'cards', { $limit: 100 }, live);
    // Apply like the store does: the returned rows become the live rows.
    store.clear();
    for (const row of rows) store.set(row.card_id, row);
    return rows;
  };
  const sentKnown = () => {
    const last = find.mock.calls.at(-1);
    if (!last) throw new Error('no versioned read yet');
    return String((last[0].query.$sync as { known: string }).known);
  };
  return { store, find, findAll, read, sentKnown, client, live, serverRows };
}

describe('findAllVersioned', () => {
  beforeEach(() => resetListSyncVersions());

  it('reads everything cold, then only what changed', async () => {
    const t = setup([
      { card_id: 'c1', title: 'alpha' },
      { card_id: 'c2', title: 'beta' },
    ]);
    const cold = await t.read();
    expect(t.sentKnown()).toBe('');
    expect(cold).toEqual(t.serverRows);

    const c1 = t.store.get('c1');
    t.serverRows[1] = { card_id: 'c2', title: 'gamma' };
    const warm = await t.read();
    expect(t.sentKnown()).toBe(v('a') + v('b'));
    // c1 comes from the store (same object), c2 is the new server row.
    expect(warm[0]).toBe(c1);
    expect(warm[1]).toEqual({ card_id: 'c2', title: 'gamma' });
  });

  it('holds versions per read scope, ignoring paging', async () => {
    const t = setup([{ card_id: 'c1', title: 'alpha' }]);
    const readScope = (query: Record<string, unknown>) =>
      findAllVersioned<Card>(t.client, 'cards', query, t.live);
    const rows = await readScope({ board_id: 'board-a', $limit: 100 });
    t.store.set('c1', rows[0]);
    // Another board's read neither offers nor forgets board-a's versions.
    await readScope({ $limit: 100, board_id: 'board-b' });
    expect(t.sentKnown()).toBe('');
    // Same scope, different key order and page size: offered again.
    await readScope({ $limit: 5, board_id: 'board-a' });
    expect(t.sentKnown()).toBe(v('a'));
  });

  it('only claims versions whose live row is unchanged', async () => {
    const t = setup([
      { card_id: 'c1', title: 'alpha' },
      { card_id: 'c2', title: 'beta' },
    ]);
    await t.read();
    // A realtime patch replaced c2 locally; a content-equal copy of c1 is fine.
    t.store.set('c1', { ...t.store.get('c1')! });
    t.store.set('c2', { card_id: 'c2', title: 'bravo' });
    await t.read();
    expect(t.sentKnown()).toBe(v('a'));
  });

  it('drops rows the scoped read no longer returns', async () => {
    const t = setup([
      { card_id: 'c1', title: 'alpha' },
      { card_id: 'c2', title: 'beta' },
    ]);
    await t.read();
    t.serverRows.splice(0, 1); // deleted, archived or no longer visible
    expect(await t.read()).toEqual([{ card_id: 'c2', title: 'beta' }]);
  });

  it('uses the live row for a slot if a realtime event replaced it mid-read', async () => {
    const t = setup([{ card_id: 'c1', title: 'alpha' }]);
    await t.read();
    const newer = { card_id: 'c1', title: 'alpha, edited live' };
    t.find.mockImplementationOnce(async () => {
      t.store.set('c1', newer); // lands while the read is in flight
      return { total: 1, limit: 100, skip: 0, data: [0], $sync: { versions: '' } };
    });
    const rows = await findAllVersioned<Card>(t.client, 'cards', { $limit: 100 }, t.live);
    expect(rows).toEqual([newer]);
    // Its version is unknown now, so the next read asks for it in full.
    await t.read();
    expect(t.sentKnown()).toBe('');
  });

  it('skips a slot whose row was removed locally mid-read', async () => {
    const t = setup([{ card_id: 'c1', title: 'alpha' }]);
    await t.read();
    t.find.mockImplementationOnce(async () => {
      t.store.delete('c1');
      return { total: 1, limit: 100, skip: 0, data: [0], $sync: { versions: '' } };
    });
    expect(await findAllVersioned<Card>(t.client, 'cards', { $limit: 100 }, t.live)).toEqual([]);
  });

  it('walks pages and rejects a set that changes between them', async () => {
    const t = setup([
      { card_id: 'c1', title: 'alpha' },
      { card_id: 'c2', title: 'beta' },
      { card_id: 'c3', title: 'delta' },
    ]);
    const rows = await findAllVersioned<Card>(t.client, 'cards', { $limit: 2 }, t.live);
    expect(rows.map((row) => row.card_id)).toEqual(['c1', 'c2', 'c3']);
    expect(t.find).toHaveBeenCalledTimes(2);

    t.find.mockImplementationOnce(async () => ({
      total: 3,
      limit: 2,
      skip: 0,
      data: [
        { card_id: 'c1', title: 'alpha' },
        { card_id: 'c2', title: 'beta' },
      ],
      $sync: { versions: v('a') + v('b') },
    }));
    t.find.mockImplementationOnce(async () => ({
      total: 4,
      limit: 2,
      skip: 2,
      data: [{ card_id: 'c3', title: 'delta' }],
      $sync: { versions: v('d') },
    }));
    await expect(findAllVersioned<Card>(t.client, 'cards', { $limit: 2 }, t.live)).rejects.toThrow(
      /changed while pages were being read/
    );
  });

  it('falls back to a plain read against a daemon that rejects $sync', async () => {
    const t = setup([{ card_id: 'c1', title: 'alpha' }]);
    t.find.mockRejectedValueOnce(Object.assign(new Error('bad'), { name: 'BadRequest' }));
    expect(await findAllVersioned<Card>(t.client, 'cards', {}, t.live)).toEqual(t.serverRows);
    expect(t.findAll).toHaveBeenCalledTimes(1);
    // Remembered until reset: no more versioned attempts.
    await findAllVersioned<Card>(t.client, 'cards', {}, t.live);
    expect(t.find).toHaveBeenCalledTimes(1);
    resetListSyncVersions();
    await findAllVersioned<Card>(t.client, 'cards', {}, t.live);
    expect(t.find).toHaveBeenCalledTimes(2);
  });

  it('accepts plain rows from a daemon that ignores $sync', async () => {
    const t = setup([{ card_id: 'c1', title: 'alpha' }]);
    t.find.mockResolvedValueOnce([{ card_id: 'c1', title: 'alpha' }] as never);
    expect(await findAllVersioned<Card>(t.client, 'cards', {}, t.live)).toEqual(t.serverRows);
  });

  it('propagates other errors', async () => {
    const t = setup([]);
    t.find.mockRejectedValueOnce(new Error('socket closed'));
    await expect(findAllVersioned<Card>(t.client, 'cards', {}, t.live)).rejects.toThrow(
      'socket closed'
    );
    expect(t.findAll).not.toHaveBeenCalled();
  });
});
