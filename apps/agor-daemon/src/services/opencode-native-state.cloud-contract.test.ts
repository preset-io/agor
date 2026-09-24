/** Opt-in cross-repo contract: shipped Cloud launcher stdout through the runtime's exact parser. */
import { generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runObserverProcess } from './opencode-native-state.js';

const helperPath = process.env.AGOR_CLOUD_LAUNCH_HELPER_PATH;

describe.skipIf(!helperPath || !existsSync(helperPath))(
  'shipped Cloud observer parser contract',
  () => {
    afterEach(() => vi.unstubAllEnvs());

    it('accepts real launcher resolve and observe responses with no HTTP-only fields', async () => {
      const expected = {
        tenantId: 'tenant-contract',
        ownerUserId: 'user-contract',
        sessionId: 'session-contract',
        taskId: 'task-contract',
        storeId: 'store-contract',
        holderInstanceId: 'holder-contract',
      };
      const inputLocator = {
        runId: 'run-contract',
        cellId: 'cell-contract',
        namespace: 'namespace-contract',
        podName: 'pod-contract',
        podUid: 'pod-uid-contract',
        containerName: 'executor' as const,
      };
      const outputLocator = {
        ...inputLocator,
        tenantId: expected.tenantId,
        ownerRuntimeUserId: expected.ownerUserId,
        sessionId: expected.sessionId,
        taskId: expected.taskId,
        storeId: expected.storeId,
        holderInstanceId: expected.holderInstanceId,
        jobName: 'job-contract',
        jobUid: 'job-uid-contract',
        containerId: 'containerd://container-contract',
        restartCount: 0 as const,
        imageIdentity: `sha256:${'a'.repeat(64)}`,
      };
      const paths: string[] = [];
      const server = createServer((request, response) => {
        paths.push(request.url ?? '');
        request.resume();
        request.on('end', () => {
          response.setHeader('Content-Type', 'application/json');
          response.end(
            JSON.stringify(
              request.url?.endsWith('/resolve')
                ? { version: 1, action: 'resolve', locator: outputLocator }
                : { version: 1, action: 'observe', outcome: 'unknown' }
            )
          );
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const port = (server.address() as AddressInfo).port;
        const { privateKey } = generateKeyPairSync('rsa', {
          modulusLength: 2048,
          privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
          publicKeyEncoding: { type: 'spki', format: 'pem' },
        });
        vi.stubEnv('AGOR_CLOUD_API_BASE_URL', `http://127.0.0.1:${port}`);
        vi.stubEnv('AGOR_CLOUD_CELL_ID', 'cell-contract');
        vi.stubEnv('AGOR_CLOUD_RUNTIME_CREDENTIAL_ID', 'credential-contract');
        vi.stubEnv('AGOR_CLOUD_RUNTIME_KEY_ID', 'key-contract');
        vi.stubEnv('AGOR_CLOUD_RUNTIME_SIGNING_KEY', privateKey);
        const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(helperPath)} opencode-native-state`;
        const resolved = await runObserverProcess(command, 3_000, {
          version: 1,
          action: 'resolve',
          expected,
          locator: inputLocator,
        });
        expect(resolved).toEqual({ version: 1, action: 'resolve', locator: outputLocator });
        const observed = await runObserverProcess(command, 3_000, {
          version: 1,
          action: 'observe',
          binding: {
            protocol: 3,
            tenantId: expected.tenantId,
            ownerUserId: expected.ownerUserId,
            sessionId: expected.sessionId,
            taskId: expected.taskId,
            storeId: expected.storeId,
            holderInstanceId: expected.holderInstanceId,
            locator: outputLocator,
          },
        });
        expect(observed).toEqual({ version: 1, action: 'observe', outcome: 'unknown' });
        // The cross-repo contract is stdout shape, not the private router's
        // path vocabulary (asserted in the companion repository).
        expect(paths).toHaveLength(2);
        expect(paths[0]).not.toBe(paths[1]);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }, 15_000);
  }
);
