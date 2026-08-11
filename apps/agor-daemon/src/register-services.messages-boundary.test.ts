import { describe, expect, it } from 'vitest';
import { MESSAGES_SERVICE_TRANSPORT_METHODS } from './services/messages';

describe('Messages service transport boundary', () => {
  it('does not expose replacement or raw bulk insertion around widget hooks', () => {
    expect(MESSAGES_SERVICE_TRANSPORT_METHODS).not.toContain('update');
    expect(MESSAGES_SERVICE_TRANSPORT_METHODS).not.toContain('createMany');
    expect(MESSAGES_SERVICE_TRANSPORT_METHODS).toEqual(
      expect.arrayContaining(['find', 'get', 'create', 'patch', 'remove'])
    );
  });
});
