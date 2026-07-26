import { describe, expect, it } from 'vitest';
import { ArtifactsService } from './artifacts.js';
import { GatewayChannelsService } from './gateway-channels.js';

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
});
