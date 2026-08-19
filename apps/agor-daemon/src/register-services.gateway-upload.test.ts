import { describe, expect, it } from 'vitest';
import {
  GATEWAY_CHANNELS_SERVICE_TRANSPORT_METHODS,
  GatewayChannelsService,
} from './services/gateway-channels.js';

describe('gateway channel executor upload registration', () => {
  it('exposes the implemented streaming callback method', () => {
    expect(typeof GatewayChannelsService.prototype.uploadFileStreamFromExecutor).toBe('function');
    expect(GATEWAY_CHANNELS_SERVICE_TRANSPORT_METHODS).toContain('uploadFileStreamFromExecutor');
    expect(GATEWAY_CHANNELS_SERVICE_TRANSPORT_METHODS).not.toContain('uploadFileFromExecutor');
  });
});
