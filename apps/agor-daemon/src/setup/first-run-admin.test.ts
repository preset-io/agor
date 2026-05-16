import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgorConfig } from '@agor/core/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  logFirstRunAdminBootstrap,
  runFirstRunAdminBootstrap,
  warnDeprecatedAnonymousConfig,
} from './first-run-admin.js';

// Mock the pure-DB layer so we can exercise the daemon-side factory
// without spinning up a real database. The factory is the only piece
// these tests care about.
vi.mock('@agor/core/db', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    bootstrapFirstRunAdmin: vi.fn(),
    createUser: vi.fn(),
  };
});

describe('warnDeprecatedAnonymousConfig', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let written: string;

  beforeEach(() => {
    written = '';
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('is silent when no daemon block exists', () => {
    warnDeprecatedAnonymousConfig({} as AgorConfig);
    expect(written).toBe('');
  });

  it('is silent when daemon block has no deprecated keys', () => {
    warnDeprecatedAnonymousConfig({ daemon: { port: 3030 } } as AgorConfig);
    expect(written).toBe('');
  });

  it('warns when allowAnonymous is present', () => {
    warnDeprecatedAnonymousConfig({
      daemon: { allowAnonymous: true },
    } as unknown as AgorConfig);
    expect(written).toContain('DEPRECATED CONFIG KEYS DETECTED');
    expect(written).toContain('daemon.allowAnonymous: true');
    expect(written).toContain('admin-credentials');
  });

  it('warns when requireAuth is present', () => {
    warnDeprecatedAnonymousConfig({
      daemon: { requireAuth: false },
    } as unknown as AgorConfig);
    expect(written).toContain('DEPRECATED CONFIG KEYS DETECTED');
    expect(written).toContain('daemon.requireAuth: false');
  });

  it('lists both keys when both are present', () => {
    warnDeprecatedAnonymousConfig({
      daemon: { allowAnonymous: true, requireAuth: false },
    } as unknown as AgorConfig);
    expect(written).toContain('daemon.allowAnonymous: true');
    expect(written).toContain('daemon.requireAuth: false');
  });

  it('fires even when the deprecated value is falsy (key presence is what matters)', () => {
    // Operators who explicitly wrote `allowAnonymous: false` still get the
    // nudge — the key is dead, regardless of its value.
    warnDeprecatedAnonymousConfig({
      daemon: { allowAnonymous: false },
    } as unknown as AgorConfig);
    expect(written).toContain('daemon.allowAnonymous: false');
  });
});

describe('logFirstRunAdminBootstrap', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let written: string;

  beforeEach(() => {
    written = '';
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('prints the credentials file path when one was written', () => {
    logFirstRunAdminBootstrap({
      createdAdmin: true,
      admin: { user_id: 'u1', email: 'admin@example.com' } as unknown as never,
      reattributedCount: 0,
      credentialsPath: '/etc/agor/admin-credentials',
    });
    expect(written).toContain('First-run admin user created');
    expect(written).toContain('see /etc/agor/admin-credentials (mode 0600)');
    expect(written).not.toContain('AGOR_ADMIN_PASSWORD');
  });

  it('points operators at AGOR_ADMIN_PASSWORD when no file was written', () => {
    logFirstRunAdminBootstrap({
      createdAdmin: true,
      admin: { user_id: 'u1', email: 'admin@example.com' } as unknown as never,
      reattributedCount: 0,
      credentialsPath: undefined,
    });
    expect(written).toContain('First-run admin user created');
    expect(written).toContain('set via the AGOR_ADMIN_PASSWORD env var');
    // SECURITY: never echo the password back to stderr.
    expect(written).not.toMatch(/Password:\s+\S{8,}/i);
  });
});

describe('runFirstRunAdminBootstrap — capability-driven password resolution', () => {
  let tempDir: string;
  let originalEnv: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-bootstrap-'));
    originalEnv = process.env.AGOR_ADMIN_PASSWORD;
    delete process.env.AGOR_ADMIN_PASSWORD;
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    if (originalEnv === undefined) {
      delete process.env.AGOR_ADMIN_PASSWORD;
    } else {
      process.env.AGOR_ADMIN_PASSWORD = originalEnv;
    }
    vi.clearAllMocks();
  });

  async function loadMocks() {
    const dbModule = (await import('@agor/core/db')) as unknown as {
      bootstrapFirstRunAdmin: ReturnType<typeof vi.fn>;
      createUser: ReturnType<typeof vi.fn>;
    };
    return dbModule;
  }

  it('uses AGOR_ADMIN_PASSWORD verbatim and does NOT write a credentials file', async () => {
    process.env.AGOR_ADMIN_PASSWORD = 'super-secret-from-secret-store';

    const { bootstrapFirstRunAdmin, createUser } = await loadMocks();
    // Invoke the factory so we can assert what it did.
    bootstrapFirstRunAdmin.mockImplementation(
      async (_db: unknown, factory: () => Promise<unknown>) => {
        const admin = await factory();
        return { createdAdmin: true, admin, reattributedCount: 0 };
      }
    );
    createUser.mockResolvedValue({ user_id: 'u1', email: 'admin@example.com' });

    const result = await runFirstRunAdminBootstrap({} as unknown as never, {
      credentialsBaseDir: tempDir,
    });

    // createUser was called with the env-var password verbatim.
    expect(createUser).toHaveBeenCalledTimes(1);
    expect(createUser).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        password: 'super-secret-from-secret-store',
        role: 'superadmin',
        unix_username: 'admin',
      })
    );
    // No credentials file was written.
    expect(result.credentialsPath).toBeUndefined();
    const credentialsPath = path.join(tempDir, 'admin-credentials');
    await expect(fs.access(credentialsPath)).rejects.toThrow();
  });

  it('falls back to file-based generation when AGOR_ADMIN_PASSWORD is absent', async () => {
    const { bootstrapFirstRunAdmin, createUser } = await loadMocks();
    bootstrapFirstRunAdmin.mockImplementation(
      async (_db: unknown, factory: () => Promise<unknown>) => {
        const admin = await factory();
        return { createdAdmin: true, admin, reattributedCount: 0 };
      }
    );
    createUser.mockResolvedValue({ user_id: 'u1', email: 'admin@example.com' });

    const result = await runFirstRunAdminBootstrap({} as unknown as never, {
      credentialsBaseDir: tempDir,
    });

    expect(createUser).toHaveBeenCalledTimes(1);
    expect(createUser).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ role: 'superadmin', unix_username: 'admin' })
    );
    expect(result.credentialsPath).toBe(path.join(tempDir, 'admin-credentials'));
    // File exists with mode 0600.
    const stat = await fs.stat(result.credentialsPath as string);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('errors with AGOR_ADMIN_PASSWORD remediation when the directory is unwritable', async () => {
    const { bootstrapFirstRunAdmin } = await loadMocks();
    bootstrapFirstRunAdmin.mockImplementation(
      async (_db: unknown, factory: () => Promise<unknown>) => factory()
    );

    // Point credentialsBaseDir at a path whose parent doesn't exist → ENOENT
    // on file create. This mirrors a read-only or absent AGOR_HOME mount.
    const unwritable = path.join(tempDir, 'does', 'not', 'exist');
    await expect(
      runFirstRunAdminBootstrap({} as unknown as never, { credentialsBaseDir: unwritable })
    ).rejects.toThrow(/AGOR_ADMIN_PASSWORD/);
  });
});
