import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { gatewaySlackUploadExecutorCommandId } from '../auth/executor-command-ids.js';
import { ArtifactsService } from './artifacts.js';
import { GatewayChannelsService } from './gateway-channels.js';

vi.mock('../utils/upload.js', () => ({
  getUploadLimits: () => ({ maxFileBytes: 4, maxTotalBytes: 8, maxFiles: 10 }),
}));

const gatewayChannel = {
  id: '019fa073-fbd5-74a4-ad28-b37a6bf037ce',
  target_branch_id: '019f9ffa-8310-72dd-b8da-422fe1b2634a',
  channel_type: 'slack',
  enabled: true,
  config: {
    bot_token: 'xoxb-secret',
    agent_tools: { file_upload: true },
    allowed_channel_ids: ['C123'],
  },
};

const executorParams = {
  provider: 'socketio',
  user: {
    user_id: '019f9ffb-89e3-7129-83fb-28c6967d1b18',
    email: 'member@example.com',
    role: 'member',
  },
  authentication: {
    strategy: 'jwt',
    payload: {
      type: 'executor-session',
      purpose: 'executor-command',
      session_id: gatewaySlackUploadExecutorCommandId(gatewayChannel.id, 'C123'),
      branch_id: gatewayChannel.target_branch_id,
    },
  },
};

describe('executor callback boundaries', () => {
  it('rejects artifact publishing from a normal member', async () => {
    const service = new ArtifactsService(
      null as never,
      {
        settings: { authentication: { secret: 'test' } },
      } as never
    );

    await expect(
      service.publishFromExecutor(
        {
          files: { '/index.tsx': 'export default null' },
          branch_id: '019fa073-fbd5-74a4-ad28-b37a6bf037ce',
          board_id: '019f9ffa-8310-72dd-b8da-422fe1b2634a',
          name: 'Injected artifact',
        },
        {
          provider: 'rest',
          user: {
            user_id: '019f9ffb-89e3-7129-83fb-28c6967d1b18',
            email: 'member@example.com',
            role: 'member',
          },
        }
      )
    ).rejects.toThrow('not scoped to this artifact operation');
  });

  it('rejects Slack uploads from a normal member', async () => {
    const service = new GatewayChannelsService(null as never);

    await expect(
      service.uploadFileStreamFromExecutor(
        {
          gatewayChannelId: '019fa073-fbd5-74a4-ad28-b37a6bf037ce',
          channel: 'C123',
          filename: 'hello.txt',
          size: 5,
        },
        Readable.from('hello'),
        {
          provider: 'rest',
          user: {
            user_id: '019f9ffb-89e3-7129-83fb-28c6967d1b18',
            email: 'member@example.com',
            role: 'member',
          },
        }
      )
    ).rejects.toThrow('not scoped to this Slack upload');
  });

  it.each([
    [{ enabled: false }, 'Gateway channel is disabled'],
    [{ channel_type: 'github' }, 'not configured for Slack'],
    [{ config: { ...gatewayChannel.config, allowed_channel_ids: ['C999'] } }, 'not an allowed'],
  ])('revalidates mutable Slack policy: %j', async (patch, message) => {
    const service = new GatewayChannelsService(null as never);
    vi.spyOn(service, 'get').mockResolvedValue({ ...gatewayChannel, ...patch } as never);

    await expect(
      service.uploadFileStreamFromExecutor(
        {
          gatewayChannelId: gatewayChannel.id,
          channel: 'C123',
          filename: 'hello.txt',
          size: 2,
        },
        Readable.from('hi'),
        executorParams
      )
    ).rejects.toThrow(message);
  });

  it('enforces the upload limit again at the daemon callback', async () => {
    const service = new GatewayChannelsService(null as never);
    vi.spyOn(service, 'get').mockResolvedValue(gatewayChannel as never);

    await expect(
      service.uploadFileStreamFromExecutor(
        {
          gatewayChannelId: gatewayChannel.id,
          channel: 'C123',
          filename: 'large.txt',
          size: 5,
        },
        Readable.from('12345'),
        executorParams
      )
    ).rejects.toThrow('4-byte upload limit');
  });

  it.each([
    ['session_id', 'gateway.slack-file-upload:wrong:scope'],
    ['branch_id', '019fa07c-b353-7a6b-abd9-9adf1017b990'],
  ])('rejects a Slack callback with a mismatched %s claim', async (claim, value) => {
    const service = new GatewayChannelsService(null as never);
    vi.spyOn(service, 'get').mockResolvedValue(gatewayChannel as never);

    await expect(
      service.uploadFileStreamFromExecutor(
        {
          gatewayChannelId: gatewayChannel.id,
          channel: 'C123',
          filename: 'hello.txt',
          size: 2,
        },
        Readable.from('hi'),
        {
          ...executorParams,
          authentication: {
            payload: { ...executorParams.authentication.payload, [claim]: value },
          },
        }
      )
    ).rejects.toThrow(/not scoped|branch does not match/);
  });

  it('rejects artifact callbacks with the wrong scoped action', async () => {
    const service = new ArtifactsService(
      null as never,
      {
        settings: { authentication: { secret: 'test' } },
      } as never
    );

    await expect(
      service.publishFromExecutor(
        {
          files: { '/index.tsx': 'export default null' },
          branch_id: gatewayChannel.target_branch_id,
          board_id: '019fa07c-b353-7a6b-abd9-9adf1017b990',
          name: 'Injected artifact',
        },
        {
          provider: 'socketio',
          user: {
            user_id: '019f9ffb-89e3-7129-83fb-28c6967d1b18',
            email: 'member@example.com',
            role: 'member',
          },
          authentication: {
            strategy: 'jwt',
            payload: {
              type: 'executor-session',
              purpose: 'executor-command',
              session_id: 'artifact.validate',
              branch_id: gatewayChannel.target_branch_id,
            },
          },
        }
      )
    ).rejects.toThrow('not scoped to this artifact operation');
  });

  it('accepts an exact delegated-user artifact validation callback', async () => {
    const service = new ArtifactsService(null as never, {} as never);
    const userId = '019f9ffb-89e3-7129-83fb-28c6967d1b18';

    await expect(
      service.validateFromExecutor(
        {
          files: { '/index.js': 'console.log("ok")' },
          branch_id: gatewayChannel.target_branch_id,
        },
        {
          provider: 'socketio',
          user: { user_id: userId, email: 'member@example.com', role: 'member' },
          authentication: {
            strategy: 'jwt',
            payload: {
              type: 'executor-session',
              purpose: 'executor-command',
              session_id: 'artifact.validate',
              branch_id: gatewayChannel.target_branch_id,
              sub: userId,
            },
          },
        }
      )
    ).resolves.toMatchObject({ status: 'success', errors: [] });
  });
});
