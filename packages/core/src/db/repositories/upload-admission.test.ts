import { expect } from 'vitest';
import type { UploadMetadata, UploadOwner, UploadRef } from '../../types';
import { ownedDbTest as test } from '../test-helpers';
import { BranchMaintenanceRepository } from './branch-maintenance';
import { seedEnvironmentCommandBranch } from './environment-commands.test-support';
import { SessionRepository } from './sessions';
import { UploadRepository } from './uploads';

test('durable upload staging blocks deletion and deletion fences new upload reservations', async ({
  db,
}) => {
  const { branch, user } = await seedEnvironmentCommandBranch(db);
  const session = await new SessionRepository(db).create({
    branch_id: branch.branch_id,
    created_by: user.user_id,
    agentic_tool: 'codex',
  });
  const owner = {
    tenantId: 'default',
    branchId: branch.branch_id,
    sessionId: session.session_id,
    createdBy: user.user_id,
  } as UploadOwner;
  const metadata: UploadMetadata = {
    ref: 'upl_00000000-0000-4000-8000-000000000001' as UploadRef,
    name: 'fixture.txt',
    mimeType: 'text/plain',
    size: 4,
    createdAt: new Date().toISOString(),
    expiresAt: null,
    provenance: 'browser',
  };
  const uploads = new UploadRepository(db);
  await uploads.reserve(owner, metadata);
  expect((await uploads.findOwned(owner.tenantId, metadata.ref))?.status).toBe('pending');
  const maintenance = new BranchMaintenanceRepository(db);
  await expect(maintenance.claim(branch.branch_id, 'delete')).rejects.toThrow('upload staging');
  await uploads.complete(owner, metadata);
  expect((await uploads.findOwned(owner.tenantId, metadata.ref))?.status).toBe('active');
  await maintenance.claim(branch.branch_id, 'delete');
  await expect(
    uploads.reserve(owner, {
      ...metadata,
      ref: 'upl_00000000-0000-4000-8000-000000000002' as UploadRef,
    })
  ).rejects.toThrow('deletion');
  expect(await uploads.findExpired(owner.tenantId, new Date('2099-01-01'))).toHaveLength(0);
});
