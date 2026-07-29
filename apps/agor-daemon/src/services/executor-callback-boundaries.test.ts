import { describe, expect, it, vi } from 'vitest';
import { ArtifactsService } from './artifacts.js';
import { GatewayChannelsService } from './gateway-channels.js';

vi.mock('../utils/upload.js', () => ({ MAX_UPLOAD_FILE_SIZE: 4 }));

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
    user_id: 'executor-service',
    email: 'executor@agor.internal',
    role: 'service',
    _isServiceAccount: true,
  },
  authentication: {
    payload: {
      executor_action: 'gateway.slack-file-upload',
      executor_gateway_channel_id: gatewayChannel.id,
      executor_slack_channel_id: 'C123',
      executor_branch_id: gatewayChannel.target_branch_id,
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
    ).rejects.toThrow('Only an executor service account');
  });

  it('rejects Slack uploads from a normal member', async () => {
    const service = new GatewayChannelsService(null as never);

    await expect(
      service.uploadFileFromExecutor(
        {
          gatewayChannelId: '019fa073-fbd5-74a4-ad28-b37a6bf037ce',
          channel: 'C123',
          fileBase64: 'aGVsbG8=',
          filename: 'hello.txt',
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
    ).rejects.toThrow('Only an executor service account');
  });

  it.each([
    [{ enabled: false }, 'Gateway channel is disabled'],
    [{ channel_type: 'github' }, 'not configured for Slack'],
    [{ config: { ...gatewayChannel.config, allowed_channel_ids: ['C999'] } }, 'not an allowed'],
  ])('revalidates mutable Slack policy: %j', async (patch, message) => {
    const service = new GatewayChannelsService(null as never);
    vi.spyOn(service, 'get').mockResolvedValue({ ...gatewayChannel, ...patch } as never);

    await expect(
      service.uploadFileFromExecutor(
        {
          gatewayChannelId: gatewayChannel.id,
          channel: 'C123',
          fileBase64: 'aGk=',
          filename: 'hello.txt',
        },
        executorParams
      )
    ).rejects.toThrow(message);
  });

  it('enforces the upload limit again at the daemon callback', async () => {
    const service = new GatewayChannelsService(null as never);
    vi.spyOn(service, 'get').mockResolvedValue(gatewayChannel as never);

    await expect(
      service.uploadFileFromExecutor(
        {
          gatewayChannelId: gatewayChannel.id,
          channel: 'C123',
          fileBase64: Buffer.from('12345').toString('base64'),
          filename: 'large.txt',
        },
        executorParams
      )
    ).rejects.toThrow('4-byte upload limit');
  });

  it.each([
    ['executor_action', 'artifact.validate'],
    ['executor_gateway_channel_id', '019fa080-5573-7960-a851-2b03286d2a00'],
    ['executor_slack_channel_id', 'C999'],
    ['executor_branch_id', '019fa07c-b353-7a6b-abd9-9adf1017b990'],
  ])('rejects a Slack callback with a mismatched %s claim', async (claim, value) => {
    const service = new GatewayChannelsService(null as never);
    vi.spyOn(service, 'get').mockResolvedValue(gatewayChannel as never);

    await expect(
      service.uploadFileFromExecutor(
        {
          gatewayChannelId: gatewayChannel.id,
          channel: 'C123',
          fileBase64: 'aGk=',
          filename: 'hello.txt',
        },
        {
          ...executorParams,
          authentication: {
            payload: { ...executorParams.authentication.payload, [claim]: value },
          },
        }
      )
    ).rejects.toThrow(/not scoped|branch does not match/);
  });

  it('rejects whitespace-bearing non-canonical Base64', async () => {
    const service = new GatewayChannelsService(null as never);
    vi.spyOn(service, 'get').mockResolvedValue(gatewayChannel as never);

    await expect(
      service.uploadFileFromExecutor(
        {
          gatewayChannelId: gatewayChannel.id,
          channel: 'C123',
          fileBase64: 'a Gk=',
          filename: 'hello.txt',
        },
        executorParams
      )
    ).rejects.toThrow('valid Base64');
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
          ...executorParams,
          authentication: {
            payload: {
              executor_action: 'artifact.validate',
              executor_user_id: '019f9ffb-89e3-7129-83fb-28c6967d1b18',
              executor_branch_id: gatewayChannel.target_branch_id,
            },
          },
        }
      )
    ).rejects.toThrow('not scoped to this artifact operation');
  });
});
