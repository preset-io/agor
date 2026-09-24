import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { select, update } from './database-wrapper';
import { BranchRepository } from './repositories/branches';
import { seedEnvironmentCommandBranch } from './repositories/environment-commands.test-support';
import { SessionRepository } from './repositories/sessions';
import { sessions } from './schema';
import type { TenantArchiveManifest } from './tenant-archive';
import { TenantNativeStateHandoffRequiredError } from './tenant-deletion';
import {
  assertArchiveNativeStateAbsent,
  assertTenantNativeStateHandoffClear,
} from './tenant-native-state-guard';
import { dbTest } from './test-helpers';

dbTest(
  'preserves clean SQLite handoffs but blocks a home with native-state identity',
  async ({ db }) => {
    await expect(assertTenantNativeStateHandoffClear(db, 'default')).resolves.toBeUndefined();

    const { branch, user } = await seedEnvironmentCommandBranch(db);
    const session = await new SessionRepository(db).create({
      branch_id: branch.branch_id,
      created_by: user.user_id,
      agentic_tool: 'opencode',
    });
    await expect(assertTenantNativeStateHandoffClear(db, 'default')).resolves.toBeUndefined();
    const row = await select(db)
      .from(sessions)
      .where(eq(sessions.session_id, session.session_id))
      .one();
    if (!row) throw new Error('Session fixture is missing');

    await update(db, sessions)
      .set({ data: { ...row.data, sdk_native_state_store_id: 'native-store' } })
      .where(eq(sessions.session_id, session.session_id))
      .run();

    await expect(assertTenantNativeStateHandoffClear(db, 'default')).rejects.toBeInstanceOf(
      TenantNativeStateHandoffRequiredError
    );
    expect(await new BranchRepository(db).findById(branch.branch_id)).not.toBeNull();
  }
);

it('blocks a files-only native-state archive before reading session rows', async () => {
  const manifest = {
    database: { tables: [] },
    filesystem: {
      included: true,
      entries: [
        {
          path: 'homes/owner-1/.local/share/agor/opencode/stores/orphan/state.json',
          type: 'file',
          size: 18,
          sha256: '0'.repeat(64),
          mode: 0o600,
        },
      ],
      skippedSpecialCount: 0,
      unsafeSymlinkCount: 0,
    },
  } as unknown as TenantArchiveManifest;

  await expect(assertArchiveNativeStateAbsent('/not-read', manifest)).rejects.toBeInstanceOf(
    TenantNativeStateHandoffRequiredError
  );
});
