import * as configModule from '@agor/core/config';
import { BranchRepository } from '@agor/core/db';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerBranchTools } from './branches.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

type ToolConfig = {
  inputSchema?: {
    safeParse: (
      value: unknown
    ) =>
      | { success: true; data: unknown }
      | { success: false; error: { issues: Array<{ message: string }> } };
  };
};

function registerAndCaptureHandler(
  toolName: string,
  ctx: {
    app: unknown;
    userId: string;
    sessionId?: string;
    baseServiceParams?: Record<string, unknown>;
    authenticatedUser?: {
      user_id: string;
      role: string;
      email?: string;
      _isServiceAccount?: boolean;
    };
  }
): ToolHandler {
  let handler: ToolHandler | undefined;
  const fakeServer = {
    registerTool: (name: string, _cfg: unknown, cb: ToolHandler) => {
      if (name === toolName) handler = cb;
    },
  } as unknown as McpServer;

  registerBranchTools(fakeServer, {
    app: ctx.app as Parameters<typeof registerBranchTools>[1]['app'],
    db: {} as Parameters<typeof registerBranchTools>[1]['db'],
    userId: ctx.userId as Parameters<typeof registerBranchTools>[1]['userId'],
    sessionId: ctx.sessionId as Parameters<typeof registerBranchTools>[1]['sessionId'],
    authenticatedUser: (ctx.authenticatedUser ?? {
      user_id: ctx.userId,
      email: 'user@example.test',
      role: 'member',
    }) as Parameters<typeof registerBranchTools>[1]['authenticatedUser'],
    baseServiceParams: (ctx.baseServiceParams ?? {}) as Parameters<
      typeof registerBranchTools
    >[1]['baseServiceParams'],
  });

  if (!handler) throw new Error(`${toolName} was not registered`);
  return handler;
}

function registerAndCaptureConfig(
  toolName: string,
  ctx: {
    app: unknown;
    userId: string;
    sessionId?: string;
    baseServiceParams?: Record<string, unknown>;
    authenticatedUser?: {
      user_id: string;
      role: string;
      email?: string;
      _isServiceAccount?: boolean;
    };
  }
): ToolConfig {
  let config: ToolConfig | undefined;
  const fakeServer = {
    registerTool: (name: string, cfg: ToolConfig, _cb: ToolHandler) => {
      if (name === toolName) config = cfg;
    },
  } as unknown as McpServer;

  registerBranchTools(fakeServer, {
    app: ctx.app as Parameters<typeof registerBranchTools>[1]['app'],
    db: {} as Parameters<typeof registerBranchTools>[1]['db'],
    userId: ctx.userId as Parameters<typeof registerBranchTools>[1]['userId'],
    sessionId: ctx.sessionId as Parameters<typeof registerBranchTools>[1]['sessionId'],
    authenticatedUser: (ctx.authenticatedUser ?? {
      user_id: ctx.userId,
      email: 'user@example.test',
      role: 'member',
    }) as Parameters<typeof registerBranchTools>[1]['authenticatedUser'],
    baseServiceParams: (ctx.baseServiceParams ?? {}) as Parameters<
      typeof registerBranchTools
    >[1]['baseServiceParams'],
  });

  if (!config) throw new Error(`${toolName} was not registered`);
  return config;
}

function registerAndCaptureUpdate(ctx: {
  app: unknown;
  userId: string;
  sessionId?: string;
  baseServiceParams?: Record<string, unknown>;
}): ToolHandler {
  return registerAndCaptureHandler('agor_branches_update', ctx);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('agor_branches_update', () => {
  it('uses authenticated service params when falling back to the current session branch', async () => {
    const baseServiceParams = {
      authenticated: true,
      provider: 'mcp',
      user: { user_id: 'user-1', role: 'member' },
    };
    const sessionsGet = vi.fn(async () => ({ session_id: 'session-1', branch_id: 'branch-1' }));
    const branchesPatch = vi.fn(async () => ({ branch_id: 'branch-1', notes: 'updated' }));
    const app = {
      service(name: string) {
        if (name === 'sessions') return { get: sessionsGet };
        if (name === 'branches') return { patch: branchesPatch };
        throw new Error(`Unexpected service call: ${name}`);
      },
    };

    const update = registerAndCaptureUpdate({
      app,
      userId: 'user-1',
      sessionId: 'session-1',
      baseServiceParams,
    });

    await update({ notes: 'updated' });

    expect(sessionsGet).toHaveBeenCalledWith('session-1', baseServiceParams);
    expect(branchesPatch).toHaveBeenCalledWith('branch-1', { notes: 'updated' }, baseServiceParams);
  });

  it('returns an actionable error when branchId is omitted without session context', async () => {
    const sessionsGet = vi.fn();
    const app = {
      service(name: string) {
        if (name === 'sessions') return { get: sessionsGet };
        throw new Error(`Unexpected service call: ${name}`);
      },
    };

    const update = registerAndCaptureUpdate({ app, userId: 'user-1' });
    const result = await update({ notes: 'updated' });
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(parsed.error).toMatch(/requires current Agor session context/i);
    expect(parsed.error).toMatch(/X-Agor-Session-Id/);
    expect(sessionsGet).not.toHaveBeenCalled();
  });
});

describe('branch MCP input schemas', () => {
  it('rejects empty required IDs/names with field-specific messages', () => {
    const config = registerAndCaptureConfig('agor_branches_create', {
      app: {},
      userId: 'user-1',
    });

    const result = config.inputSchema?.safeParse({
      repoId: '',
      branchName: '',
      boardId: '',
    });

    expect(result?.success).toBe(false);
    if (result?.success === false) {
      expect(result.error.issues.map((issue) => issue.message)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/repoId cannot be empty/i),
          expect.stringMatching(/branchName cannot be empty/i),
          expect.stringMatching(/boardId cannot be empty/i),
        ])
      );
    }
  });

  it('rejects malformed pagination values before handler execution', () => {
    const config = registerAndCaptureConfig('agor_branches_cleanup_candidates', {
      app: {},
      userId: 'user-1',
    });

    expect(config.inputSchema?.safeParse({ limit: 0 }).success).toBe(false);
    expect(config.inputSchema?.safeParse({ skip: -1 }).success).toBe(false);
    expect(config.inputSchema?.safeParse({ limit: 1, skip: 0 }).success).toBe(true);
  });
});

describe('agor_branches_set_zone', () => {
  it('accepts zoneId null and clears the existing board object zone pin', async () => {
    const baseServiceParams = {
      authenticated: true,
      provider: 'mcp',
      user: { user_id: 'user-1', role: 'member' },
    };
    const branch = {
      branch_id: 'branch-1',
      board_id: 'board-1',
      name: 'Branch 1',
    };
    const branchesGet = vi.fn(async () => branch);
    const findByBranchId = vi.fn(async () => ({
      object_id: 'obj-branch-1',
      branch_id: 'branch-1',
      zone_id: 'zone-review',
    }));
    const boardObjectsPatch = vi.fn(async () => ({
      object_id: 'obj-branch-1',
      branch_id: 'branch-1',
      zone_id: undefined,
    }));
    const app = {
      service(name: string) {
        if (name === 'branches') return { get: branchesGet };
        if (name === 'board-objects') {
          return {
            findByBranchId,
            patch: boardObjectsPatch,
          };
        }
        throw new Error(`Unexpected service call: ${name}`);
      },
    };

    const setZone = registerAndCaptureHandler('agor_branches_set_zone', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const result = await setZone({ branchId: 'branch-1', zoneId: null });
    const parsed = JSON.parse(result.content[0].text);

    expect(branchesGet).toHaveBeenCalledWith('branch-1', baseServiceParams);
    expect(findByBranchId).toHaveBeenCalledWith('branch-1', baseServiceParams);
    expect(boardObjectsPatch).toHaveBeenCalledWith(
      'obj-branch-1',
      { zone_id: null },
      baseServiceParams
    );
    expect(parsed.zone_id).toBeNull();
    expect(parsed.note).toMatch(/cleared/i);
  });

  it('rejects trigger arguments when clearing the zone pin', async () => {
    const baseServiceParams = {
      authenticated: true,
      provider: 'mcp',
      user: { user_id: 'user-1', role: 'member' },
    };
    const branchesGet = vi.fn(async () => ({
      branch_id: 'branch-1',
      board_id: 'board-1',
      name: 'Branch 1',
    }));
    const findByBranchId = vi.fn();
    const app = {
      service(name: string) {
        if (name === 'branches') return { get: branchesGet };
        if (name === 'board-objects') {
          return {
            findByBranchId,
            patch: vi.fn(),
          };
        }
        throw new Error(`Unexpected service call: ${name}`);
      },
    };

    const setZone = registerAndCaptureHandler('agor_branches_set_zone', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    await expect(
      setZone({ branchId: 'branch-1', zoneId: null, triggerTemplate: true })
    ).rejects.toThrow(/cannot be used when zoneId is null/i);
    await expect(
      setZone({ branchId: 'branch-1', zoneId: null, targetSessionId: 'bad-session' })
    ).rejects.toThrow(/cannot be used when zoneId is null/i);
    expect(findByBranchId).not.toHaveBeenCalled();
  });
});

describe('agor_branches_list', () => {
  const baseServiceParams = {
    authenticated: true,
    provider: 'mcp',
    user: { user_id: 'user-1', role: 'member' },
  };

  function makeApp(findResult: unknown) {
    return {
      service(name: string) {
        if (name === 'branches') {
          return {
            find: vi.fn(async (params?: { query?: Record<string, unknown> }) => {
              const zoneId = params?.query?.zone_id;
              if (!zoneId || Array.isArray(findResult)) return findResult;

              // Simulate BranchesService-level filtering. The MCP tool should
              // forward zone_id to the service instead of filtering the current
              // page itself.
              const result = findResult as {
                data: Record<string, unknown>[];
                total: number;
                limit: number;
                skip: number;
              };
              const filtered = result.data.filter((branch) => branch.zone_id === zoneId);
              return { ...result, data: filtered, total: filtered.length };
            }),
          };
        }
        throw new Error(`Unexpected service call: ${name}`);
      },
    };
  }

  it('includes zone_id and zone_label from enriched branches', async () => {
    const enrichedBranches = {
      data: [
        {
          branch_id: 'branch-1',
          name: 'my-feature',
          archived: false,
          board_id: 'board-1',
          zone_id: 'zone-1776863814461',
          zone_label: 'in progress',
          board_object_id: 'obj-1',
        },
        {
          branch_id: 'branch-2',
          name: 'other-feature',
          archived: false,
          board_id: 'board-1',
          // No zone — branch on board but not in a zone
        },
      ],
      total: 2,
      limit: 50,
      skip: 0,
    };
    const list = registerAndCaptureHandler('agor_branches_list', {
      app: makeApp(enrichedBranches),
      userId: 'user-1',
      baseServiceParams,
    });

    const result = await list({});
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);

    const branch1 = parsed.data[0];
    expect(branch1.zone_id).toBe('zone-1776863814461');
    expect(branch1.zone_label).toBe('in progress');

    const branch2 = parsed.data[1];
    expect(branch2.zone_id).toBeUndefined();
  });

  it('passes zone_id to the service query so filtering is pagination-correct', async () => {
    const findFn = vi.fn(async () => ({
      data: [{ branch_id: 'branch-1', zone_id: 'zone-review' }],
      total: 1,
      limit: 50,
      skip: 0,
    }));
    const app = {
      service(name: string) {
        if (name === 'branches') return { find: findFn };
        throw new Error(`Unexpected service call: ${name}`);
      },
    };
    const list = registerAndCaptureHandler('agor_branches_list', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    await list({ zoneId: 'zone-review' });

    expect(findFn).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.objectContaining({ zone_id: 'zone-review' }) })
    );
  });

  it('filters by zoneId when provided', async () => {
    const enrichedBranches = {
      data: [
        {
          branch_id: 'branch-1',
          name: 'feature-a',
          archived: false,
          zone_id: 'zone-review',
          zone_label: 'Review',
        },
        {
          branch_id: 'branch-2',
          name: 'feature-b',
          archived: false,
          zone_id: 'zone-done',
          zone_label: 'Done',
        },
        {
          branch_id: 'branch-3',
          name: 'feature-c',
          archived: false,
          // no zone
        },
      ],
      total: 3,
      limit: 50,
      skip: 0,
    };
    const list = registerAndCaptureHandler('agor_branches_list', {
      app: makeApp(enrichedBranches),
      userId: 'user-1',
      baseServiceParams,
    });

    const result = await list({ zoneId: 'zone-review' });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.data).toHaveLength(1);
    expect(parsed.data[0].branch_id).toBe('branch-1');
    expect(parsed.total).toBe(1);
  });

  it('returns empty data when zoneId matches no branches', async () => {
    const enrichedBranches = {
      data: [{ branch_id: 'branch-1', name: 'feature-a', zone_id: 'zone-other' }],
      total: 1,
      limit: 50,
      skip: 0,
    };
    const list = registerAndCaptureHandler('agor_branches_list', {
      app: makeApp(enrichedBranches),
      userId: 'user-1',
      baseServiceParams,
    });

    const result = await list({ zoneId: 'zone-review' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.data).toHaveLength(0);
    expect(parsed.total).toBe(0);
  });
});

describe('agor_branches_cleanup_candidates', () => {
  const baseServiceParams = {
    authenticated: true,
    provider: 'mcp',
    user: { user_id: 'user-1', role: 'member' },
  };

  const repo = {
    repo_id: 'repo-1',
    slug: 'preset-io/agor',
    name: 'Agor',
  };

  function makeBranch(overrides: Record<string, unknown>) {
    return {
      branch_id: overrides.branch_id ?? 'branch-1',
      repo_id: overrides.repo_id ?? 'repo-1',
      name: overrides.name ?? 'old-feature',
      ref: overrides.ref ?? 'old-feature',
      archived: true,
      archived_at: overrides.archived_at ?? '2026-05-20T00:00:00.000Z',
      archived_by: 'user-1',
      last_used: '2026-05-19T00:00:00.000Z',
      filesystem_status: overrides.filesystem_status,
      storage_mode: overrides.storage_mode ?? 'worktree',
      path: overrides.path ?? process.cwd(),
      pull_request_url: overrides.pull_request_url,
      issue_url: overrides.issue_url,
      notes: overrides.notes,
      others_can: overrides.others_can ?? 'session',
      custom_context: overrides.custom_context,
      ...overrides,
    };
  }

  function makeCleanupApp(branches: unknown[], options?: { repoGetFails?: boolean }) {
    const branchesFind = vi.fn(async (params?: { query?: Record<string, unknown> }) => {
      const skip = Number(params?.query?.$skip ?? 0);
      const limit = Number(params?.query?.$limit ?? branches.length);
      return {
        data: branches.slice(skip, skip + limit),
        total: branches.length,
        limit,
        skip,
      };
    });
    const reposGet = vi.fn(async () => {
      if (options?.repoGetFails) throw new Error('repo unavailable');
      return repo;
    });

    return {
      branchesFind,
      reposGet,
      app: {
        service(name: string) {
          if (name === 'branches') return { find: branchesFind };
          if (name === 'repos') return { get: reposGet };
          throw new Error(`Unexpected service call: ${name}`);
        },
      },
    };
  }

  it('applies safe defaults: archived only, older than 7 days, not deleted, not assistant/private', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-03T00:00:00.000Z'));

    const { app, branchesFind } = makeCleanupApp([
      makeBranch({ branch_id: 'candidate-ready', filesystem_status: undefined }),
      makeBranch({ branch_id: 'candidate-preserved', filesystem_status: 'preserved' }),
      makeBranch({ branch_id: 'candidate-cleaned', filesystem_status: 'cleaned' }),
      makeBranch({
        branch_id: 'too-recent',
        archived_at: '2026-05-30T00:00:00.000Z',
        filesystem_status: 'ready',
      }),
      makeBranch({ branch_id: 'deleted', filesystem_status: 'deleted' }),
      makeBranch({
        branch_id: 'assistant',
        filesystem_status: 'ready',
        custom_context: { assistant: { kind: 'assistant', displayName: 'Helper' } },
      }),
      makeBranch({ branch_id: 'private', filesystem_status: 'ready', others_can: 'none' }),
      makeBranch({ branch_id: 'active', archived: false, filesystem_status: 'ready' }),
    ]);

    const cleanupCandidates = registerAndCaptureHandler('agor_branches_cleanup_candidates', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const result = await cleanupCandidates({});
    const parsed = JSON.parse(result.content[0].text);

    expect(branchesFind).toHaveBeenCalledWith({
      query: { archived: true, $limit: 10000, $skip: 0, $sort: { archived_at: 1 } },
      ...baseServiceParams,
    });
    expect(
      parsed.candidates.map((candidate: { branch_id: string }) => candidate.branch_id)
    ).toEqual(['candidate-ready', 'candidate-preserved', 'candidate-cleaned']);
    expect(parsed.safety).toMatchObject({
      read_only: true,
      archived_only: true,
      archived_older_than_days: 7,
      filesystem_statuses: ['ready', 'preserved', 'cleaned'],
      exclude_assistants: true,
      exclude_private: true,
    });
    expect(parsed.candidates[0]).toMatchObject({
      repo_slug: 'preset-io/agor',
      filesystem_status: 'ready',
      path_exists: true,
    });
    expect(parsed.scanned).toMatchObject({
      archived_branches: 8,
      source_pages: 1,
      source_page_limit: 10000,
    });
  });

  it('supports explicit filters and pagination after safety filtering', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-03T00:00:00.000Z'));

    const { app } = makeCleanupApp([
      makeBranch({
        branch_id: 'missing-clone-a',
        storage_mode: 'clone',
        filesystem_status: 'cleaned',
        path: '/tmp/agor-definitely-missing-a',
      }),
      makeBranch({
        branch_id: 'missing-clone-b',
        storage_mode: 'clone',
        filesystem_status: 'cleaned',
        path: '/tmp/agor-definitely-missing-b',
      }),
      makeBranch({
        branch_id: 'existing-clone',
        storage_mode: 'clone',
        filesystem_status: 'cleaned',
        path: process.cwd(),
      }),
      makeBranch({
        branch_id: 'missing-worktree',
        storage_mode: 'worktree',
        filesystem_status: 'cleaned',
        path: '/tmp/agor-definitely-missing-c',
      }),
    ]);

    const cleanupCandidates = registerAndCaptureHandler('agor_branches_cleanup_candidates', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const result = await cleanupCandidates({
      archivedOlderThanDays: 1,
      filesystemStatuses: ['cleaned'],
      storageMode: 'clone',
      pathExists: false,
      skip: 1,
      limit: 1,
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.total).toBe(2);
    expect(parsed.skip).toBe(1);
    expect(parsed.limit).toBe(1);
    expect(parsed.candidates).toHaveLength(1);
    expect(parsed.candidates[0]).toMatchObject({
      branch_id: 'missing-clone-b',
      storage_mode: 'clone',
      filesystem_status: 'cleaned',
      path_exists: false,
    });
  });

  it('scans multiple source pages before applying cleanup filters and pagination', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-03T00:00:00.000Z'));

    const nonCandidates = Array.from({ length: 10000 }, (_, index) =>
      makeBranch({
        branch_id: `deleted-${index}`,
        filesystem_status: 'deleted',
      })
    );
    const { app, branchesFind } = makeCleanupApp([
      ...nonCandidates,
      makeBranch({ branch_id: 'page-two-candidate', filesystem_status: 'ready' }),
    ]);

    const cleanupCandidates = registerAndCaptureHandler('agor_branches_cleanup_candidates', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const result = await cleanupCandidates({ limit: 1 });
    const parsed = JSON.parse(result.content[0].text);

    expect(branchesFind).toHaveBeenCalledTimes(2);
    expect(branchesFind).toHaveBeenNthCalledWith(2, {
      query: { archived: true, $limit: 10000, $skip: 10000, $sort: { archived_at: 1 } },
      ...baseServiceParams,
    });
    expect(parsed.total).toBe(1);
    expect(parsed.candidates[0].branch_id).toBe('page-two-candidate');
    expect(parsed.scanned.source_pages).toBe(2);
  });

  it('excludes malformed archived_at values instead of treating them as old', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-03T00:00:00.000Z'));

    const { app } = makeCleanupApp([
      makeBranch({ branch_id: 'bad-date', archived_at: 'not-a-date', filesystem_status: 'ready' }),
      makeBranch({ branch_id: 'good-date', filesystem_status: 'ready' }),
    ]);

    const cleanupCandidates = registerAndCaptureHandler('agor_branches_cleanup_candidates', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const result = await cleanupCandidates({});
    const parsed = JSON.parse(result.content[0].text);

    expect(
      parsed.candidates.map((candidate: { branch_id: string }) => candidate.branch_id)
    ).toEqual(['good-date']);
  });

  it('supports explicit archivedBefore and opt-in inclusion of assistant/private branches', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-03T00:00:00.000Z'));

    const { app } = makeCleanupApp([
      makeBranch({
        branch_id: 'assistant',
        filesystem_status: 'ready',
        custom_context: { assistant: { kind: 'assistant', displayName: 'Helper' } },
      }),
      makeBranch({ branch_id: 'private', filesystem_status: 'ready', others_can: 'none' }),
      makeBranch({
        branch_id: 'after-cutoff',
        archived_at: '2026-05-22T00:00:00.000Z',
        filesystem_status: 'ready',
      }),
    ]);

    const cleanupCandidates = registerAndCaptureHandler('agor_branches_cleanup_candidates', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const result = await cleanupCandidates({
      archivedBefore: '2026-05-21T00:00:00.000Z',
      excludeAssistants: false,
      excludePrivate: false,
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(
      parsed.candidates.map((candidate: { branch_id: string }) => candidate.branch_id)
    ).toEqual(['assistant', 'private']);
    expect(parsed.safety).toMatchObject({
      cutoff_source: 'archivedBefore',
      archived_older_than_days: null,
      exclude_assistants: false,
      exclude_private: false,
    });
  });

  it('falls back to null repo metadata when repo enrichment fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-03T00:00:00.000Z'));

    const { app } = makeCleanupApp(
      [makeBranch({ branch_id: 'candidate', filesystem_status: 'ready' })],
      { repoGetFails: true }
    );

    const cleanupCandidates = registerAndCaptureHandler('agor_branches_cleanup_candidates', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const result = await cleanupCandidates({});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.candidates[0]).toMatchObject({
      branch_id: 'candidate',
      repo_slug: null,
      repo_name: null,
    });
  });

  it('rejects ambiguous filesystem status inputs', async () => {
    const { app } = makeCleanupApp([]);
    const cleanupCandidates = registerAndCaptureHandler('agor_branches_cleanup_candidates', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    await expect(
      cleanupCandidates({ filesystemStatus: 'ready', filesystemStatuses: ['cleaned'] })
    ).rejects.toThrow(/either filesystemStatus or filesystemStatuses/i);
  });

  it('rejects non-old cleanup cutoffs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-03T00:00:00.000Z'));

    const { app } = makeCleanupApp([]);
    const cleanupCandidates = registerAndCaptureHandler('agor_branches_cleanup_candidates', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    await expect(cleanupCandidates({ archivedOlderThanDays: 0 })).rejects.toThrow(
      /at least 1 day/i
    );
    await expect(cleanupCandidates({ archivedBefore: '2026-06-04T00:00:00.000Z' })).rejects.toThrow(
      /must not be in the future/i
    );
  });
});

describe('agor_assistants_list', () => {
  it('delegates to the targeted assistant repository query instead of paginating branches first', async () => {
    const baseServiceParams = {
      authenticated: true,
      provider: 'mcp',
      user: { user_id: 'user-1', role: 'member' },
    };
    const hodorLikeBranch = {
      branch_id: 'assistant-branch-1',
      repo_id: 'repo-1',
      name: 'private-hodor-like',
      board_id: 'board-1',
      last_used: '2026-06-24T00:00:00.000Z',
      archived: false,
      storage_mode: 'clone',
      custom_context: {
        assistant: {
          kind: 'assistant',
          displayName: 'Hodor-like',
          emoji: '🚪',
          kb: {
            primary_namespace_id: 'namespace-1',
            primary_namespace_slug: 'team-kb',
            memory_path_template: 'memory/{{YYYY-MM-DD}}.md',
            default_visibility: 'public',
            global_access: 'write',
          },
        },
      },
    };
    const findAssistantBranches = vi
      .spyOn(BranchRepository.prototype, 'findAssistantBranches')
      .mockResolvedValue([hodorLikeBranch] as Awaited<
        ReturnType<BranchRepository['findAssistantBranches']>
      >);
    const app = {
      service(name: string) {
        throw new Error(`Unexpected service call: ${name}`);
      },
    };

    const listAssistants = registerAndCaptureHandler('agor_assistants_list', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const result = await listAssistants({ limit: 200 });
    const parsed = JSON.parse(result.content[0].text);

    expect(findAssistantBranches).toHaveBeenCalledWith({ archived: false, limit: 200 });
    expect(parsed.total).toBe(1);
    expect(parsed.assistants).toEqual([
      expect.objectContaining({
        branch_id: 'assistant-branch-1',
        name: 'private-hodor-like',
        display_name: 'Hodor-like',
        emoji: '🚪',
        board_id: 'board-1',
      }),
    ]);
  });

  it('shapes schedule-only legacy assistant backfill rows returned by the repository', async () => {
    const baseServiceParams = {
      authenticated: true,
      provider: 'mcp',
      user: { user_id: 'user-1', role: 'member' },
    };
    const scheduledLegacyBranch = {
      branch_id: 'legacy-scheduled-branch',
      repo_id: 'repo-1',
      name: 'datagor-like',
      notes: 'Legacy assistant bootstrapped before custom_context marker backfill.',
      board_id: 'board-1',
      last_used: '2026-06-24T00:00:00.000Z',
      archived: false,
      storage_mode: 'clone',
    };
    vi.spyOn(BranchRepository.prototype, 'findAssistantBranches').mockResolvedValue([
      scheduledLegacyBranch,
    ] as Awaited<ReturnType<BranchRepository['findAssistantBranches']>>);
    const app = {
      service(name: string) {
        throw new Error(`Unexpected service call: ${name}`);
      },
    };

    const listAssistants = registerAndCaptureHandler('agor_assistants_list', {
      app,
      userId: 'user-1',
      baseServiceParams,
    });

    const result = await listAssistants({});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.total).toBe(1);
    expect(parsed.assistants[0]).toEqual(
      expect.objectContaining({
        branch_id: 'legacy-scheduled-branch',
        name: 'datagor-like',
        display_name: 'datagor-like',
        description: 'Legacy assistant bootstrapped before custom_context marker backfill.',
      })
    );
  });

  it('does not scope assistant discovery for superadmins when superadmin bypass is enabled', async () => {
    vi.spyOn(configModule, 'isBranchRbacEnabled').mockReturnValue(true);
    vi.spyOn(configModule, 'loadConfig').mockResolvedValue({
      execution: { allow_superadmin: true },
    } as Awaited<ReturnType<typeof configModule.loadConfig>>);

    const findAssistantBranches = vi
      .spyOn(BranchRepository.prototype, 'findAssistantBranches')
      .mockResolvedValue([]);
    const app = {
      service(name: string) {
        throw new Error(`Unexpected service call: ${name}`);
      },
    };

    const listAssistants = registerAndCaptureHandler('agor_assistants_list', {
      app,
      userId: 'superadmin-1',
      authenticatedUser: {
        user_id: 'superadmin-1',
        email: 'superadmin@example.test',
        role: 'superadmin',
      },
    });

    await listAssistants({});

    expect(findAssistantBranches).toHaveBeenCalledWith({ archived: false, limit: 200 });
  });

  it('scopes assistant discovery for superadmins when superadmin bypass is disabled', async () => {
    vi.spyOn(configModule, 'isBranchRbacEnabled').mockReturnValue(true);
    vi.spyOn(configModule, 'loadConfig').mockResolvedValue({
      execution: { allow_superadmin: false },
    } as Awaited<ReturnType<typeof configModule.loadConfig>>);

    const findAssistantBranches = vi
      .spyOn(BranchRepository.prototype, 'findAssistantBranches')
      .mockResolvedValue([]);
    const app = {
      service(name: string) {
        throw new Error(`Unexpected service call: ${name}`);
      },
    };

    const listAssistants = registerAndCaptureHandler('agor_assistants_list', {
      app,
      userId: 'superadmin-1',
      authenticatedUser: {
        user_id: 'superadmin-1',
        email: 'superadmin@example.test',
        role: 'superadmin',
      },
    });

    await listAssistants({});

    expect(findAssistantBranches).toHaveBeenCalledWith({
      archived: false,
      userId: 'superadmin-1',
      limit: 200,
    });
  });
});
