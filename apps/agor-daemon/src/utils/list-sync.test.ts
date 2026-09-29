import { feathers } from '@agor/core/feathers';
import type { HookContext, ListSyncPage } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { listSyncRowVersion, projectListSyncResult, stripListSyncQuery } from './list-sync';

type Row = { card_id: string; title: string; secret?: string };

function appWith(
  rows: Row[],
  options: { paginate?: boolean; redact?: boolean; path?: string } = {}
) {
  const { paginate = true, redact = false, path = 'cards' } = options;
  const seenQueries: unknown[] = [];
  const app = feathers();
  app.use(path, {
    async find(params: { query?: unknown }) {
      seenQueries.push(params.query);
      const data = rows.map((row) => ({ ...row }));
      return paginate ? { total: data.length, limit: 100, skip: 0, data } : data;
    },
  });
  if (redact) {
    // Like the users service: everyone else receives `dispatch`.
    app.service(path).hooks({
      after: {
        find: [
          (context: HookContext) => {
            const result = context.result as { data: Row[] };
            context.dispatch = {
              ...result,
              data: result.data.map(({ secret: _secret, ...rest }) => rest),
            };
          },
        ],
      },
    });
  }
  app.hooks({ before: { find: [stripListSyncQuery] }, after: { find: [projectListSyncResult] } });
  return { app, seenQueries };
}

const rows: Row[] = [
  { card_id: 'c1', title: 'one', secret: 's1' },
  { card_id: 'c2', title: 'two', secret: 's2' },
];

describe('list-sync hooks', () => {
  it('never lets $sync reach the service query', async () => {
    const { app, seenQueries } = appWith(rows);
    await app.service('cards').find({ provider: 'socketio', query: { $sync: { known: '' } } });
    expect(seenQueries).toEqual([{}]);
  });

  it('wraps a non-paginated result into a page', async () => {
    const { app } = appWith(rows, { paginate: false });
    const page = (await app.service('cards').find({
      provider: 'socketio',
      query: { $sync: { known: listSyncRowVersion(rows[1]) } },
    })) as ListSyncPage<Row>;
    expect(page).toMatchObject({ total: 2, skip: 0, data: [rows[0], 0] });
    expect(page.$sync.versions).toBe(listSyncRowVersion(rows[0]));
  });

  it('hashes and projects the dispatched (redacted) payload, not the raw result', async () => {
    const { app } = appWith(rows, { redact: true });
    // The transport sends `dispatch ?? result`; capture what it would send.
    const sent: unknown[] = [];
    app.hooks({ after: { find: [(context: HookContext) => void sent.push(context.dispatch)] } });
    const find = async (known: string) => {
      const internal = await app
        .service('cards')
        .find({ provider: 'socketio', query: { $sync: { known } } });
      return { internal, sent: sent.at(-1) as ListSyncPage<Row> };
    };

    const cold = await find('');
    // Internal callers still get the unredacted result; what is versioned and
    // sent is the redacted payload.
    expect((cold.internal as { data: Row[] }).data[0]).toHaveProperty('secret');
    expect(cold.sent.data).toEqual([
      { card_id: 'c1', title: 'one' },
      { card_id: 'c2', title: 'two' },
    ]);

    const warm = await find(cold.sent.$sync.versions);
    expect(warm.sent.data).toEqual([0, 1]);
  });

  it('drops $sync without projecting on paths that are not versioned', async () => {
    const { app, seenQueries } = appWith(rows, { path: 'repos' });
    const result = await app
      .service('repos')
      .find({ provider: 'socketio', query: { $sync: { known: '' } } });
    expect(seenQueries).toEqual([{}]);
    expect(result).not.toHaveProperty('$sync');
  });

  it('rejects a known list that is not whole versions', async () => {
    const { app } = appWith(rows);
    for (const known of ['abc', 'x'.repeat(11) + '!', 42]) {
      await expect(
        app.service('cards').find({ provider: 'socketio', query: { $sync: { known } } })
      ).rejects.toMatchObject({ name: 'BadRequest' });
    }
  });
});
