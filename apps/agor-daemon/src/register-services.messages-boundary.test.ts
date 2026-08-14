import { describe, expect, it } from 'vitest';
import { MESSAGES_SERVICE_TRANSPORT_METHODS } from './services/messages';

describe('Messages service transport boundary', () => {
  it('exposes only the canonical Message CRUD boundary', () => {
    expect(MESSAGES_SERVICE_TRANSPORT_METHODS).not.toContain('update');
    expect(MESSAGES_SERVICE_TRANSPORT_METHODS).not.toContain('createMany');
    expect(MESSAGES_SERVICE_TRANSPORT_METHODS).not.toContain('findBySession');
    expect(MESSAGES_SERVICE_TRANSPORT_METHODS).not.toContain('findByTask');
    expect(MESSAGES_SERVICE_TRANSPORT_METHODS).not.toContain('findByRange');
    expect(MESSAGES_SERVICE_TRANSPORT_METHODS).toEqual(
      expect.arrayContaining(['find', 'get', 'create', 'patch', 'remove'])
    );
  });
});
