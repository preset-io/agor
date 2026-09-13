import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type postgres from 'postgres';
import { expect, it } from 'vitest';
import { WorkspaceInventory } from './inventory';

it('persists ordered inventory updates across restarts and keeps tenants separate', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'inventory-'));
  try {
    const inventory = new WorkspaceInventory(root, {} as postgres.Sql, 'one');
    inventory.touch('a', 'branch', 'repo', 'session');
    const first = inventory.save();
    inventory.touch('b', 'branch', 'repo', 'private');
    const second = inventory.save();
    inventory.tenantEntries('a')[0].resident = true;
    const third = inventory.save();
    await Promise.all([first, second, third]);
    const restored = new WorkspaceInventory(root, {} as postgres.Sql, 'one');
    await restored.load();
    expect(restored.tenantEntries('a')).toMatchObject([{ sessions: ['session'], resident: true }]);
    expect(restored.tenantEntries('b')).toMatchObject([{ sessions: ['private'] }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('registers known legacy replicas on lookup without following symlinks', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'legacy-inventory-'));
  try {
    const inventory = new WorkspaceInventory(
      path.join(root, 'inventory'),
      {} as postgres.Sql,
      'one'
    );
    const branch = path.join(root, 'branch');
    await mkdir(path.join(branch, 'replicas/session/workspace'), { recursive: true });
    await inventory.registerExisting('tenant', 'branch', 'repo', branch, 2);
    expect(inventory.tenantEntries('tenant')).toMatchObject([
      { resident: true, sessions: ['session'], revision: 2 },
    ]);
    const shadow = path.join(root, 'shadow');
    await mkdir(shadow);
    await symlink(path.join(branch, 'replicas'), path.join(shadow, 'replicas'));
    await inventory.registerExisting('tenant', 'shadow', 'repo', shadow, 2);
    expect(inventory.tenantEntries('tenant')).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
