import { describe, expect, it } from 'vitest';
import { createClient } from './index';

// Use the actual Feathers/socket client, not the mock in index.test.ts.
describe('managed OpenCode socket client', () => {
  it('exposes every native-state RPC before connecting', () => {
    const client = createClient('http://127.0.0.1:1', false);
    try {
      const service = client.service('opencode-native-state');
      for (const method of [
        'begin',
        'closeRead',
        'seal',
        'abandon',
        'prepareCleanup',
        'observe',
        'acknowledgeDelete',
      ]) {
        expect(service[method as keyof typeof service]).toEqual(expect.any(Function));
      }
    } finally {
      client.io.disconnect();
    }
  });
});
