import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { OpsHold } from './ops-hold.js';

it('persists holds across restarts and rejects another operation', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ops-hold-'));
  try {
    const a = new OpsHold(path.join(dir, 'hold'));
    await expect(a.acquire('first', false)).rejects.toThrow('Worker active');
    expect(a.id).toBeNull();
    await a.acquire('first', true);
    const b = new OpsHold(path.join(dir, 'hold'));
    await b.load();
    expect(b.id).toBe('first');
    await expect(b.acquire('other', true)).rejects.toThrow('another operation');
    await expect(b.release('other')).rejects.toThrow('Matching');
    await b.run('first', async () => {
      await expect(b.release('first')).rejects.toThrow('still running');
      await expect(b.run('first', async () => {})).rejects.toThrow('already running');
    });
    await b.release('first');
    const c = new OpsHold(path.join(dir, 'hold'));
    await c.load();
    expect(c.id).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
