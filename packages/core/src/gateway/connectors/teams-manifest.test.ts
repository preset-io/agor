import { describe, expect, it } from 'vitest';
import { buildTeamsSetupManifest, teamsGatewayCallbackUrl } from './teams-manifest';

describe('Teams setup artifact', () => {
  it('uses the shared callback and bot scopes without claiming live verification', () => {
    const options = {
      appId: 'app-123',
      gatewayChannelId: 'channel-123',
      callbackOrigin: 'https://agor.example/',
    };
    const manifest = buildTeamsSetupManifest(options);
    expect(teamsGatewayCallbackUrl(options)).toBe(
      'https://agor.example/gateway/teams/channel-123/activities'
    );
    expect(manifest.bots).toEqual([
      expect.objectContaining({ botId: 'app-123', scopes: ['personal', 'team', 'groupchat'] }),
    ]);
    expect(manifest).not.toHaveProperty('authorization');
    expect(manifest).not.toHaveProperty('agor');
  });

  it('rejects non-HTTPS callback origins instead of producing an unusable artifact', () => {
    expect(() =>
      teamsGatewayCallbackUrl({
        appId: 'app-123',
        gatewayChannelId: 'channel-123',
        callbackOrigin: 'http://localhost:3030',
      })
    ).toThrow('valid HTTPS origin');
  });
});
