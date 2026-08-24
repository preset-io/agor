import { describe, expect, it } from 'vitest';
import { MAX_TENANT_ID_LENGTH } from '../types/tenant';
import {
  isRealtimeRelayEnvelope,
  REALTIME_RELAY_VERSION,
  type RealtimeRelayEnvelope,
} from './relay-contract';

function envelope(tenantId: string): RealtimeRelayEnvelope {
  return {
    version: REALTIME_RELAY_VERSION,
    tenantId: tenantId as RealtimeRelayEnvelope['tenantId'],
    path: 'tasks',
    event: 'patched',
    data: {},
  };
}

describe('realtime relay tenant contract', () => {
  it('uses the same tenant ID bound as trusted tenant resolution', () => {
    expect(isRealtimeRelayEnvelope(envelope('t'.repeat(MAX_TENANT_ID_LENGTH)))).toBe(true);
    expect(isRealtimeRelayEnvelope(envelope('t'.repeat(MAX_TENANT_ID_LENGTH + 1)))).toBe(false);
  });
});
