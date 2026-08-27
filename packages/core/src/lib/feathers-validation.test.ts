import { describe, expect, it } from 'vitest';
import {
  boardObjectQueryValidator,
  branchQueryValidator,
  mcpCatalogQueryValidator,
  mcpServerQueryValidator,
  messageQueryValidator,
  sessionQueryValidator,
  taskQueryValidator,
  typedValidateQuery,
  userQueryValidator,
} from './feathers-validation';

describe('boardObjectQueryValidator', () => {
  it('preserves supported board-object filters through Feathers query validation', async () => {
    const context = {
      params: {
        query: {
          board_id: '019e8e1c',
          branch_id: '019e8e1d',
          card_id: '019e8e1e',
          zone_id: 'zone-review',
          entity_type: 'branch',
          $limit: 25,
          $skip: 5,
          unknown: 'removed',
        },
      },
    };

    await typedValidateQuery(boardObjectQueryValidator)(context);

    expect(context.params.query).toEqual({
      board_id: '019e8e1c',
      branch_id: '019e8e1d',
      card_id: '019e8e1e',
      zone_id: 'zone-review',
      entity_type: 'branch',
      $limit: 25,
      $skip: 5,
    });
  });
});

describe('branchQueryValidator', () => {
  it('preserves zone_id for service-level virtual zone filtering', async () => {
    const context = {
      params: {
        query: {
          repo_id: '019e8e1c',
          zone_id: 'zone-review',
          archived: 'false',
          unknown: 'removed',
        },
      },
    };

    await typedValidateQuery(branchQueryValidator)(context);

    expect(context.params.query).toEqual({
      repo_id: '019e8e1c',
      zone_id: 'zone-review',
      archived: false,
    });
  });
});

describe('userQueryValidator', () => {
  it('preserves user search and pagination aliases used by MCP tools', async () => {
    const context = {
      params: {
        query: {
          search: 'reed',
          query: 'preset',
          q: 'unix',
          limit: '10',
          skip: '2',
          offset: '3',
          $limit: '50',
          $skip: '5',
          unknown: 'removed',
        },
      },
    };

    await typedValidateQuery(userQueryValidator)(context);

    expect(context.params.query).toEqual({
      search: 'reed',
      query: 'preset',
      q: 'unix',
      limit: 10,
      skip: 2,
      offset: 3,
      $limit: 50,
      $skip: 5,
    });
  });
});

describe('sessionQueryValidator', () => {
  it('preserves the _swapReplace marker so the switch-tool guard can see it', async () => {
    // Regression: `removeAdditional: 'all'` silently stripped `_swapReplace`
    // before it reached SessionsService.remove, making the swap-safety guard
    // dead on the external client path. It must now survive validation (and
    // coerce the REST string form) while genuinely unknown props are dropped.
    const context = {
      params: {
        query: {
          session_id: '019e8e1c',
          _swapReplace: 'true',
          unknown: 'removed',
        },
      },
    };

    await typedValidateQuery(sessionQueryValidator)(context);

    expect(context.params.query).toEqual({
      session_id: '019e8e1c',
      _swapReplace: true,
    });
  });
});

describe('messageQueryValidator', () => {
  it('coerces supported pagination and preserves a bounded session set', async () => {
    const context = {
      params: {
        query: {
          session_id: { $in: ['019e8e1c', '019e8e1d'] },
          message_id: { $gt: '019e8e1a', $lte: '019e8e1f' },
          task_id: '019e8e1e',
          role: 'assistant',
          $limit: '1000',
          $skip: '12000',
          $sort: { index: '-1' },
          $select: ['message_id', 'content'],
        },
      },
    };

    await typedValidateQuery(messageQueryValidator)(context);

    expect(context.params.query).toEqual({
      session_id: { $in: ['019e8e1c', '019e8e1d'] },
      message_id: { $gt: '019e8e1a', $lte: '019e8e1f' },
      task_id: '019e8e1e',
      role: 'assistant',
      $limit: 1000,
      $skip: 12000,
      $sort: { index: -1 },
      $select: ['message_id', 'content'],
    });
  });

  it('rejects unknown filters instead of broadening the query', async () => {
    const context = { params: { query: { task: '019e8e1e' } } };
    await expect(typedValidateQuery(messageQueryValidator)(context)).rejects.toThrow();
  });
});

describe('taskQueryValidator', () => {
  it('preserves bounded hydration cursors and rejects unsupported fields', async () => {
    const valid = {
      params: {
        query: {
          session_id: '019e8e1c',
          task_id: { $gt: '019e8e1d', $lte: '019e8e1f' },
          created_by: '019e8e1b',
          $limit: '1000',
        },
      },
    };
    await typedValidateQuery(taskQueryValidator)(valid);
    expect(valid.params.query).toEqual({
      session_id: '019e8e1c',
      task_id: { $gt: '019e8e1d', $lte: '019e8e1f' },
      created_by: '019e8e1b',
      $limit: 1000,
    });

    await expect(
      typedValidateQuery(taskQueryValidator)({
        params: { query: { session_id: '019e8e1c', updated_at: 123 } },
      })
    ).rejects.toThrow();
  });
});

describe('mcpServerQueryValidator', () => {
  it('strips internal identity hints from public server reads', async () => {
    const context = {
      params: {
        query: {
          scope: 'global',
          enabled: 'true',
          forUserId: '019e8e1c',
          unknown: 'removed',
        },
      },
    };

    await typedValidateQuery(mcpServerQueryValidator)(context);

    expect(context.params.query).toEqual({
      scope: 'global',
      enabled: true,
    });
  });
});

describe('mcpCatalogQueryValidator', () => {
  it('strips every filter, because the catalog read takes no parameters', async () => {
    // `find` returns the whole catalog and the browser narrows it. A tab left
    // open across the deploy that removed these still sends them; stripping
    // here is what stops them reaching a method that would ignore them
    // silently, which is how a filter ends up looking like it works.
    const context = {
      params: {
        query: {
          search: 'linear',
          category: 'dev-tools',
          capability: 'issues',
          auth_types: ['none', 'unknown'],
          sort: 'name',
          $limit: 24,
          $skip: 48,
          unknown: 'removed',
        },
      },
    };

    await typedValidateQuery(mcpCatalogQueryValidator)(context);

    expect(context.params.query).toEqual({});
  });

  it('accepts an empty query rather than rejecting the only call there is', async () => {
    const context = { params: { query: {} } };

    await expect(typedValidateQuery(mcpCatalogQueryValidator)(context)).resolves.not.toThrow();
    expect(context.params.query).toEqual({});
  });
});
