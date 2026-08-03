import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GatewayChannelsService } from './services/gateway-channels.js';

describe('gateway channel executor upload registration', () => {
  it('exposes the implemented streaming callback method', () => {
    const source = readFileSync(new URL('./register-services.ts', import.meta.url), 'utf8');

    expect(typeof GatewayChannelsService.prototype.uploadFileStreamFromExecutor).toBe('function');
    expect(source).toContain("'uploadFileStreamFromExecutor'");
    expect(source).not.toContain("'uploadFileFromExecutor'");
  });
});
