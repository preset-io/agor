import { describe, expect, it } from 'vitest';
import {
  MANAGED_MCP_OAUTH_FLAGS,
  managedMCPOAuthOperationEnabled,
  validateManagedMCPOAuthConfig,
} from './managed-mcp-oauth';
import type { AgorManagedMCPOAuthSettings } from './types';

const configured: AgorManagedMCPOAuthSettings = {
  enabled: true,
  broker_origin: 'https://oauth.staging.example.test',
  environment: 'staging',
  region: 'us-west-2',
  cell_id: 'fake-cell',
  credential_id: 'fake-credential',
  sender_key_id: 'fake-key',
  sender_private_key_path: '/run/secrets/synthetic-cell-sender-key',
  contract_sha256: 'a'.repeat(64),
};

describe('managed OAuth deployment configuration', () => {
  it('defaults every operation off, independently of wiring and other operation flags', () => {
    expect(() => validateManagedMCPOAuthConfig(undefined)).not.toThrow();
    expect(() => validateManagedMCPOAuthConfig(configured)).not.toThrow();
    for (const flag of MANAGED_MCP_OAUTH_FLAGS.filter((flag) => flag !== 'enabled')) {
      expect(managedMCPOAuthOperationEnabled({}, flag)).toBe(false);
      expect(managedMCPOAuthOperationEnabled({ managed_mcp_oauth: configured }, flag)).toBe(false);
      expect(
        managedMCPOAuthOperationEnabled(
          { managed_mcp_oauth: { ...configured, [flag]: true } },
          flag
        )
      ).toBe(true);
      expect(
        managedMCPOAuthOperationEnabled(
          { managed_mcp_oauth: { ...configured, enabled: false, [flag]: true } },
          flag
        )
      ).toBe(false);
    }
  });

  it('rejects incomplete enabled wiring, unsupported regions and non-exact origins', () => {
    expect(() => validateManagedMCPOAuthConfig({ enabled: true })).toThrow();
    for (const origin of [
      'http://oauth.example.test',
      'https://oauth.example.test/',
      'https://user@oauth.example.test',
      'https://oauth.example.test:444',
      'https://oauth.example.test/path',
      'https://oauth.example.test?next=elsewhere',
    ]) {
      expect(() =>
        validateManagedMCPOAuthConfig({ ...configured, broker_origin: origin })
      ).toThrow();
    }
    expect(() =>
      validateManagedMCPOAuthConfig({
        ...configured,
        region: 'eu-west-1',
      } as unknown as AgorManagedMCPOAuthSettings)
    ).toThrow();
    expect(() =>
      validateManagedMCPOAuthConfig({ ...configured, sender_private_key_path: 'relative' })
    ).toThrow();
  });
});
