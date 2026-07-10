import { describe, expect, it } from 'vitest';
import {
  boardObjectQueryValidator,
  branchQueryValidator,
  mcpServerQueryValidator,
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

describe('mcpServerQueryValidator', () => {
  it('preserves forUserId for executor per-user OAuth token injection', async () => {
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
      forUserId: '019e8e1c',
    });
  });
});
