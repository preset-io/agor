import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ connect: vi.fn(), sign: vi.fn(), options: vi.fn() }));
vi.mock('postgres', () => ({ default: mocks.connect }));
vi.mock('@aws-sdk/rds-signer', () => ({
  Signer: class {
    constructor(options: unknown) {
      mocks.options(options);
    }
    getAuthToken = mocks.sign;
  },
}));

import { connectWorkspaceAuthority } from './connection';

it('generates a fresh role-based token for each connection and verifies TLS', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worker-iam-'));
  try {
    const ca = path.join(root, 'ca.pem');
    await writeFile(ca, 'fixture CA');
    mocks.sign
      .mockResolvedValueOnce('first-short-lived-token')
      .mockResolvedValueOnce('second-short-lived-token');
    await connectWorkspaceAuthority({
      databaseUrl: 'postgres://agor_worker@db.example:5432/agor_workspace',
      sslCaPath: ca,
      databaseIamAuth: true,
    });
    expect(mocks.options).toHaveBeenCalledWith({
      hostname: 'db.example',
      port: 5432,
      username: 'agor_worker',
      region: 'ap-southeast-2',
    });
    const options = mocks.connect.mock.calls[0][1];
    expect(options.ssl).toEqual({ ca: 'fixture CA', rejectUnauthorized: true });
    expect(await options.password()).toBe('first-short-lived-token');
    expect(await options.password()).toBe('second-short-lived-token');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
