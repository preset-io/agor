import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const branchRoot = vi.hoisted(() => ({ path: '' }));

vi.mock('../services/feathers-client.js', () => ({
  createExecutorClient: async () => ({ io: { disconnect: () => {} } }),
}));

vi.mock('./branch-filesystem.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./branch-filesystem.js')>()),
  resolveExecutorBranch: async () => ({ path: branchRoot.path }),
}));

import { handleBranchSlackFileUpload } from './gateway.js';

describe('handleBranchSlackFileUpload', () => {
  it.each([
    {
      status: 400,
      body: JSON.stringify({ error: 'Slack API error: not_in_channel' }),
      message: 'Slack upload failed with HTTP 400: Slack API error: not_in_channel',
    },
    { status: 502, body: '<html>Bad gateway</html>', message: 'Slack upload failed with HTTP 502' },
    {
      status: 403,
      body: JSON.stringify({ error: { code: 'denied' } }),
      message: 'Slack upload failed with HTTP 403',
    },
    { status: 400, body: 'null', message: 'Slack upload failed with HTTP 400' },
    {
      status: 200,
      body: JSON.stringify({ uploaded: { id: 'F123', permalink: null, name: 'chart.png' } }),
      message: null,
    },
  ])('handles upload HTTP $status with body $body', async ({ status, body, message }) => {
    branchRoot.path = await mkdtemp(join(tmpdir(), '141421-executor-'));
    await writeFile(join(branchRoot.path, 'chart.png'), 'png-bytes');
    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const result = await handleBranchSlackFileUpload(
        {
          command: 'branch.gateway.slack-file-upload',
          sessionToken: 'executor-token',
          daemonUrl: `http://127.0.0.1:${port}`,
          params: {
            branchId: '01a2134b-a3f4-7213-bbc2-7234c1e0b552',
            filePath: 'chart.png',
            gatewayChannelId: '01a2134b-a3f4-7213-bbc2-7234c1e0b553',
            channel: 'C123',
            maxBytes: 1024,
          },
        } as Parameters<typeof handleBranchSlackFileUpload>[0],
        {} as Parameters<typeof handleBranchSlackFileUpload>[1]
      );

      expect(result).toEqual(
        message === null
          ? {
              success: true,
              data: { uploaded: { id: 'F123', permalink: null, name: 'chart.png' } },
            }
          : {
              success: false,
              error: {
                code: 'BRANCH_SLACK_FILE_UPLOAD_FAILED',
                message,
              },
            }
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(branchRoot.path, { recursive: true, force: true });
    }
  });
});
