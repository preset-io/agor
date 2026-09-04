import { runWithTenantContext, type TenantScopeAwareDatabase } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { Branch, BranchID, User } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  BranchFilesystemStatusService,
  parseBranchFilesystemObservation,
} from './branch-filesystem-status.js';

const TENANT_ID = '01991b7c-5000-7000-8000-000000000001';
const BRANCH_ID = '01991b7c-5000-7000-8000-000000000002' as BranchID;
const USER_ID = '01991b7c-5000-7000-8000-000000000003';
const PATH = '/server/owned/branch-path';
const NOW = new Date('2026-09-03T03:04:05.000Z');

function params(overrides: Record<string, unknown> = {}) {
  return {
    route: { id: BRANCH_ID },
    user: { user_id: USER_ID, role: 'member' } as User,
    ...overrides,
  };
}

function fixture(options: { branch?: Branch | null; access?: Record<string, unknown> } = {}) {
  const branch =
    options.branch === undefined
      ? ({
          branch_id: BRANCH_ID,
          created_by: USER_ID,
          primary_owner_user_id: USER_ID,
          path: PATH,
        } as Branch)
      : options.branch;
  const branchRepo = {
    findById: vi.fn().mockResolvedValue(branch),
    resolveUserAccess: vi.fn().mockResolvedValue(
      options.access ?? {
        can: 'all',
        fs_access: 'write',
        is_owner: true,
      }
    ),
  };
  const request = vi.fn().mockResolvedValue({
    success: true,
    data: { branchId: BRANCH_ID, exists: true, kind: 'directory' },
  });
  const issueToken = vi.fn().mockResolvedValue('token');
  const app = {
    get: vi.fn().mockReturnValue({ execution: { unix_user_mode: 'simple' } }),
  } as unknown as Application;
  const scopedDb = { execute: vi.fn().mockResolvedValue(undefined) };
  const db = {
    transaction: vi.fn(async (work: (value: typeof scopedDb) => Promise<unknown>) =>
      work(scopedDb)
    ),
  } as unknown as TenantScopeAwareDatabase;
  const service = new BranchFilesystemStatusService(branchRepo as never, db, app, {
    issueToken,
    now: () => NOW,
    request,
  });
  const find = (value = params()) =>
    runWithTenantContext(TENANT_ID, () => service.find(value as never));
  return { branchRepo, find, issueToken, request };
}

describe('BranchFilesystemStatusService', () => {
  it.each([
    ['directory', true],
    ['file', true],
    ['other', true],
    ['missing', false],
  ] as const)('returns an exact, path-free %s observation', async (kind, exists) => {
    const subject = fixture();
    subject.request.mockResolvedValue({
      success: true,
      data: { branchId: BRANCH_ID, exists, kind },
    });

    await expect(subject.find()).resolves.toEqual({
      branch_id: BRANCH_ID,
      exists,
      kind,
      observed_at: NOW.toISOString(),
    });
    expect(subject.issueToken).toHaveBeenCalledWith(
      expect.anything(),
      'branch.filesystem.status',
      USER_ID,
      BRANCH_ID
    );
    const [payload] = subject.request.mock.calls[0];
    expect(payload).toMatchObject({
      command: 'branch.filesystem.status',
      params: { branchId: BRANCH_ID },
    });
    expect(payload.params).toEqual({ branchId: BRANCH_ID });
    expect(JSON.stringify(payload)).not.toContain(PATH);
  });

  it('observes an archived Branch while its metadata still exists', async () => {
    const archived = {
      branch_id: BRANCH_ID,
      created_by: USER_ID,
      primary_owner_user_id: USER_ID,
      path: PATH,
      archived: true,
    } as Branch;
    const subject = fixture({ branch: archived });

    await expect(subject.find()).resolves.toMatchObject({ branch_id: BRANCH_ID });
    expect(subject.request).toHaveBeenCalledOnce();
  });

  it.each([
    ['executor rejection', { success: false, error: { code: 'TIMEOUT', message: 'timed out' } }],
    ['missing data', { success: true }],
    [
      'mismatched Branch',
      {
        success: true,
        data: { branchId: '01991b7c-5000-7000-8000-000000000099', exists: false, kind: 'missing' },
      },
    ],
    [
      'extra fields',
      {
        success: true,
        data: { branchId: BRANCH_ID, exists: false, kind: 'missing', path: PATH },
      },
    ],
    [
      'inconsistent missing state',
      { success: true, data: { branchId: BRANCH_ID, exists: true, kind: 'missing' } },
    ],
  ])('never turns %s into a missing observation', async (_label, result) => {
    const subject = fixture();
    subject.request.mockResolvedValue(result);

    await expect(subject.find()).rejects.toMatchObject({
      code: 503,
      data: { code: 'BRANCH_FILESYSTEM_OBSERVATION_UNAVAILABLE' },
    });
  });

  it('rejects executor transport failures with the same stable error', async () => {
    const subject = fixture();
    subject.request.mockRejectedValue(new Error(`failed at ${PATH}`));

    await expect(subject.find()).rejects.toMatchObject({
      code: 503,
      message: 'Branch filesystem observation is temporarily unavailable',
    });
  });

  it('rejects unknown query parameters before authorization or executor work', async () => {
    const subject = fixture();

    await expect(subject.find(params({ query: { path: PATH } }))).rejects.toMatchObject({
      code: 400,
    });
    expect(subject.branchRepo.findById).not.toHaveBeenCalled();
    expect(subject.issueToken).not.toHaveBeenCalled();
    expect(subject.request).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated and unknown Branch requests before executor work', async () => {
    const unauthenticated = fixture();
    await expect(unauthenticated.find(params({ user: undefined }))).rejects.toMatchObject({
      code: 401,
    });
    expect(unauthenticated.issueToken).not.toHaveBeenCalled();

    const unknown = fixture({ branch: null });
    await expect(unknown.find()).rejects.toMatchObject({ code: 403 });
    expect(unknown.issueToken).not.toHaveBeenCalled();
    expect(unknown.request).not.toHaveBeenCalled();
  });

  it('rejects a user without Branch filesystem read access before executor work', async () => {
    const subject = fixture({
      access: { can: 'view', fs_access: 'none', is_owner: false },
    });

    await expect(subject.find()).rejects.toMatchObject({ code: 403 });
    expect(subject.issueToken).not.toHaveBeenCalled();
    expect(subject.request).not.toHaveBeenCalled();
  });
});

describe('parseBranchFilesystemObservation', () => {
  it('rejects non-ISO clock values rather than emitting an ambiguous result', () => {
    expect(() =>
      parseBranchFilesystemObservation(
        { branchId: BRANCH_ID, exists: true, kind: 'directory' },
        BRANCH_ID,
        new Date(Number.NaN)
      )
    ).toThrow();
  });
});
