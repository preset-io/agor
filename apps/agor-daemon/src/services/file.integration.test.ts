/**
 * Actual-layer regression for a real HTTP 500 observed on nested branch-file
 * paths (e.g. `qa-evidence/pr-ready/screenshot.png`).
 *
 * Root cause: `@feathersjs/rest-client` percent-encodes the id
 * (`encodeURIComponent(id)`), but `@feathersjs/transport-commons`'s Router
 * splits the request path on literal `/` *before* any decoding — so a
 * nested id's encoded slash reaches `FileService.get()` completely
 * undecoded (`qa-evidence%2Fpr-ready%2Fscreenshot.png`), and the executor
 * then fails to find a file literally named with percent-encoded slashes.
 * Unit tests that call `service.get(id, params)` directly bypass this
 * transport layer entirely and cannot catch it — this test boots a real
 * Express + Feathers app and issues a genuine HTTP GET to prove the fix
 * (`resolveRestFilePath` in ./file.ts) actually closes the gap.
 */
import { feathers, feathersExpress, rest } from '@agor/core/feathers';
import type { HookContext } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runExecutorCommand } from '../utils/spawn-executor.js';
import { createTenantDatabaseScopeAroundHook } from '../utils/tenant-db-scope.js';
import { FileService } from './file.js';

const impersonationMocks = vi.hoisted(() => ({
  resolveExecutorReadAsUser: vi.fn(),
}));

vi.mock('../utils/executor-read-impersonation.js', () => ({
  resolveExecutorReadAsUser: impersonationMocks.resolveExecutorReadAsUser,
}));

vi.mock('../utils/spawn-executor.js', () => ({
  generateScopedServiceToken: vi.fn(() => 'service-token'),
  getDaemonUrl: vi.fn(() => 'http://daemon.test'),
  runExecutorCommand: vi.fn(),
}));

describe('GET /file/:path over the real REST transport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    impersonationMocks.resolveExecutorReadAsUser.mockResolvedValue(undefined);
  });

  it('retrieves a nested evidence path instead of 500ing on its percent-encoded slash', async () => {
    const nestedPath = 'qa-evidence/pr-ready/screenshot.png';
    vi.mocked(runExecutorCommand).mockResolvedValue({
      success: true,
      data: {
        file: {
          path: nestedPath,
          title: 'screenshot.png',
          size: 3,
          lastModified: '2026-07-30T00:00:00.000Z',
          isText: false,
          mimeType: 'image/png',
          content: 'AAEC',
          encoding: 'base64',
        },
      },
    });

    const service = new FileService(
      { findById: vi.fn().mockResolvedValue({ branch_id: 'branch-1' }) } as never,
      { run: vi.fn() } as never,
      { get: () => ({}), settings: { authentication: { secret: 'test' } } } as never
    );

    // Mirrors the daemon's real registration for 'file': RBAC/tenant identity
    // via an around hook (see register-hooks.ts TENANT_IDENTITY_ONLY_SERVICE_PATHS),
    // plus a stand-in for the requireAuth hook that normally populates params.user.
    const app = feathersExpress(feathers());
    app.configure(rest());
    app.use('/file', service);
    app.service('file').hooks({
      around: {
        all: [
          createTenantDatabaseScopeAroundHook({
            db: {} as never,
            config: {} as never,
            jwtSecret: 'test-secret',
            transaction: false,
          }),
        ],
      },
      before: {
        all: [
          (context: HookContext) => {
            context.params.user = {
              user_id: 'user-1',
              email: 'member@example.com',
              role: 'member',
            };
            return context;
          },
        ],
      },
    });

    const server = await app.listen(0);
    const { port } = server.address() as { port: number };

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/file/${encodeURIComponent(nestedPath)}?branch_id=branch-1`
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        path: nestedPath,
        encoding: 'base64',
      });
      // Proves the executor received the real nested path, not the raw
      // percent-encoded id the transport handed the service.
      expect(runExecutorCommand).toHaveBeenCalledWith(
        expect.objectContaining({ params: expect.objectContaining({ filePath: nestedPath }) }),
        expect.anything()
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
