import { describe, expect, it, vi } from 'vitest';
import type { MCPServerID } from '../../types';
import type { Database } from '../client';
import { sealBoundSecret } from '../oauth-secret-envelope';
import {
  dcrRegistrationBinding,
  MCPOAuthClientRegistrationRepository,
} from './mcp-oauth-client-registrations';

describe('MCPOAuthClientRegistrationRepository.invalidateIfCurrentMatchesClientId', () => {
  const masterSecret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const tenantId = 'tenant_prod_corp';
  const serverId = 'srv_jira_cloud' as MCPServerID;
  const registrationId = 'dcr_reg_01h8';
  const bindingFingerprint = 'fp_sha256_abcdef';

  const repo = (execute: ReturnType<typeof vi.fn>) =>
    new MCPOAuthClientRegistrationRepository({ execute } as unknown as Database);

  function sealMaterial(clientId: string) {
    const binding = dcrRegistrationBinding({
      tenantId,
      mcpServerId: serverId,
      registrationId,
      bindingFingerprint,
    });
    return sealBoundSecret(JSON.stringify({ clientId }), masterSecret, 'dcr-client', binding);
  }

  it('invalidates and returns true when current registration matches target client', async () => {
    const targetClient = 'dcr_client_live_01';
    let step = 0;
    const execute = vi.fn().mockImplementation(() => {
      step++;
      if (step === 1) {
        return Promise.resolve([
          {
            registration_id: registrationId,
            binding_fingerprint: bindingFingerprint,
            sealed_material: sealMaterial(targetClient),
          },
        ]);
      }
      return Promise.resolve([{ registration_id: registrationId }]);
    });

    const ok = await repo(execute).invalidateIfCurrentMatchesClientId({
      tenantId,
      serverId,
      clientId: targetClient,
      masterSecret,
    });

    expect(ok).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('leaves current registration untouched when client_id differs', async () => {
    const execute = vi.fn().mockResolvedValue([
      {
        registration_id: registrationId,
        binding_fingerprint: bindingFingerprint,
        sealed_material: sealMaterial('dcr_client_already_rotated'),
      },
    ]);

    const ok = await repo(execute).invalidateIfCurrentMatchesClientId({
      tenantId,
      serverId,
      clientId: 'dcr_client_stale_failed_refresh',
      masterSecret,
    });

    expect(ok).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('returns false when no current registration exists', async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const ok = await repo(execute).invalidateIfCurrentMatchesClientId({
      tenantId,
      serverId,
      clientId: 'dcr_client_orphan',
      masterSecret,
    });

    expect(ok).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('fails safely on envelope decryption errors without throwing', async () => {
    const execute = vi.fn().mockResolvedValue([
      {
        registration_id: registrationId,
        binding_fingerprint: bindingFingerprint,
        sealed_material: 'not:a:valid:sealed:envelope',
      },
    ]);

    const ok = await repo(execute).invalidateIfCurrentMatchesClientId({
      tenantId,
      serverId,
      clientId: 'dcr_client_corrupted',
      masterSecret,
    });

    expect(ok).toBe(false);
  });

  it('returns false without throwing when master secret is unavailable', async () => {
    const execute = vi.fn();
    const envBackup = process.env.AGOR_MASTER_SECRET;
    delete process.env.AGOR_MASTER_SECRET;

    try {
      const ok = await repo(execute).invalidateIfCurrentMatchesClientId({
        tenantId,
        serverId,
        clientId: 'dcr_client_test',
        masterSecret: undefined,
      });

      expect(ok).toBe(false);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      if (envBackup !== undefined) {
        process.env.AGOR_MASTER_SECRET = envBackup;
      }
    }
  });
});
