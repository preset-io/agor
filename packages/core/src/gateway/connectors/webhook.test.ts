import { describe, expect, it } from 'vitest';
import { getConnector } from '../connector-registry';
import { WebhookConnector } from './webhook';

describe('WebhookConnector', () => {
  it('is registered as the stateless webhook connector', () => {
    const connector = getConnector('webhook', {});

    expect(connector).toBeInstanceOf(WebhookConnector);
    expect(connector.channelType).toBe('webhook');
    expect(connector.sessionEnv?.()).toEqual([]);
    expect(connector.startListening).toBeUndefined();
    expect(connector.stopListening).toBeUndefined();
  });

  it('clearly rejects outbound delivery', async () => {
    const connector = new WebhookConnector();

    await expect(connector.sendMessage()).rejects.toThrow(
      'Webhook gateway channels are inbound-only; outbound delivery is unsupported'
    );
  });
});
