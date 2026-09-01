import { BranchRepository, generateId, RepoRepository, UsersRepository } from '@agor/core/db';
import type { Application, BranchID } from '@agor/core/types';
import { describe, expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { BranchesService } from './branches';

describe('BranchesService environment variant lifecycle race', () => {
  dbTest('never starts one variant while persisting another variant', async ({ db }) => {
    const owner = await new UsersRepository(db).create({
      email: `${generateId()}@example.test`,
      name: 'Variant race owner',
      role: 'member',
    });
    const repo = await new RepoRepository(db).create({
      name: 'variant-race-repo',
      slug: `variant-race-${generateId()}`,
      repo_type: 'local',
      local_path: `/tmp/${generateId()}`,
      default_branch: 'main',
      environment: {
        version: 2,
        default: 'dev',
        variants: {
          dev: { start: 'echo dev', stop: 'echo stop-dev' },
          e2e: { start: 'echo e2e', stop: 'echo stop-e2e' },
        },
      },
    });
    const branchRepo = new BranchRepository(db);
    const initial = await branchRepo.create({
      branch_id: generateId() as BranchID,
      repo_id: repo.repo_id,
      name: 'variant-race',
      ref: 'variant-race',
      path: `/tmp/${generateId()}`,
      created_by: owner.user_id,
      branch_unique_id: 91_001,
      environment_variant: 'dev',
      start_command: 'echo dev',
      stop_command: 'echo stop-dev',
      environment_instance: { status: 'stopped' },
    });
    const branchesEvents = { emit: vi.fn() };
    const app = {
      get: () => ({}),
      service(path: string) {
        if (path === 'branches') return branchesEvents;
        if (path === 'repos') return { get: vi.fn(async () => repo) };
        throw new Error(`Unknown service: ${path}`);
      },
    } as unknown as Application;
    const service = new BranchesService(db, app);
    vi.spyOn(service, 'get').mockImplementation(async (id) => {
      const current = await branchRepo.findById(id);
      if (!current) throw new Error('branch disappeared');
      return current as never;
    });
    vi.spyOn(
      service as unknown as { loadEnvironmentForAction: (id: BranchID) => Promise<unknown> },
      'loadEnvironmentForAction'
    ).mockImplementation(async (id) => {
      const current = await branchRepo.findById(id);
      if (!current) throw new Error('branch disappeared');
      return current;
    });
    vi.spyOn(service, 'patch').mockImplementation(async (id, updates) => {
      return (await branchRepo.update(id, updates)) as never;
    });
    vi.spyOn(service as never, 'resolveEnvironmentCommand').mockImplementation(
      async (command: string) => ({ kind: 'shell', command }) as never
    );
    const dispatch = vi
      .spyOn(service as never, 'dispatchEnvironmentExecutor')
      .mockResolvedValue(undefined as never);

    let renderReachedValidation!: () => void;
    let releaseRender!: () => void;
    const atValidation = new Promise<void>((resolve) => {
      renderReachedValidation = resolve;
    });
    const renderMayContinue = new Promise<void>((resolve) => {
      releaseRender = resolve;
    });
    vi.spyOn(service as never, 'validateRenderedEnvironmentActions').mockImplementation(
      async () => {
        renderReachedValidation();
        await renderMayContinue;
      }
    );

    // Render reads `stopped` and passes its guard, then pauses. Start claims
    // the old variant before Render performs its writes.
    const renderPromise = service.renderEnvironment(initial.branch_id, { variant: 'e2e' });
    await atValidation;
    const startResult = await Promise.allSettled([service.startEnvironment(initial.branch_id)]);
    releaseRender();
    const renderResult = await Promise.allSettled([renderPromise]);

    const final = await branchRepo.findById(initial.branch_id);
    const dispatchedBranch = dispatch.mock.calls[0]?.[0]?.branch as
      | { environment_variant?: string; start_command?: string }
      | undefined;
    const renderError =
      renderResult[0]?.status === 'rejected' ? String(renderResult[0].reason) : undefined;

    expect({
      startStatus: startResult[0]?.status,
      dispatchCount: dispatch.mock.calls.length,
      dispatchedVariant: dispatchedBranch?.environment_variant,
      dispatchedStartCommand: dispatchedBranch?.start_command,
      renderStatus: renderResult[0]?.status,
      renderError,
      finalVariant: final?.environment_variant,
      finalStartCommand: final?.start_command,
      finalStatus: final?.environment_instance?.status,
    }).toEqual({
      startStatus: 'fulfilled',
      dispatchCount: 1,
      dispatchedVariant: 'dev',
      dispatchedStartCommand: 'echo dev',
      renderStatus: 'rejected',
      renderError: expect.stringMatching(/conflict|superseded|starting/i),
      finalVariant: 'dev',
      finalStartCommand: 'echo dev',
      finalStatus: 'starting',
    });
  });
});
