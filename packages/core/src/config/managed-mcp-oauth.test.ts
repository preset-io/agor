import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MANAGED_MCP_OAUTH_CONTRACT_SOURCE_SHA256,
  MANAGED_MCP_OAUTH_FLAGS,
  managedMCPOAuthOperationEnabled,
  validateManagedMCPOAuthConfig,
} from './managed-mcp-oauth';
import type { AgorManagedMCPOAuthSettings } from './types';

const configured: AgorManagedMCPOAuthSettings = {
  enabled: true,
  broker_origin: 'https://oauth.staging.example.test',
  worker_issuer: 'https://oauth.staging.example.test/',
  environment: 'staging',
  region: 'us-west-2',
  cell_id: 'fake-cell',
  credential_id: 'fake-credential',
  sender_key_id: 'fake-key',
  sender_private_key_path: '/run/secrets/synthetic-cell-sender-key',
  worker_public_keyring_path: '/run/agor-managed/worker-public.json',
  cell_evidence_path: '/run/agor-managed/cell.json',
  clock_health_path: '/run/agor-clock/health.json',
  contract_sha256: 'a'.repeat(64),
};

describe('managed OAuth deployment configuration', () => {
  it('accepts only a staging us-west-2 immutable pilot pin, never an enrollment flag', () => {
    expect(() =>
      validateManagedMCPOAuthConfig({
        ...configured,
        fresh_pilot_enrollment_sha256: 'b'.repeat(64),
      })
    ).not.toThrow();
    for (const value of [true, '', 'fresh', 'B'.repeat(64), 'b'.repeat(63), `${'b'.repeat(64)} `]) {
      expect(() =>
        validateManagedMCPOAuthConfig({
          ...configured,
          fresh_pilot_enrollment_sha256: value,
        } as AgorManagedMCPOAuthSettings)
      ).toThrow('fresh pilot requires');
    }
    for (const environment of ['production', undefined] as const) {
      expect(() =>
        validateManagedMCPOAuthConfig({
          ...configured,
          environment,
          fresh_pilot_enrollment_sha256: 'b'.repeat(64),
        })
      ).toThrow('fresh pilot requires');
    }
    const pinned = { ...configured, enabled: false, fresh_pilot_enrollment_sha256: 'b'.repeat(64) };
    for (const flag of MANAGED_MCP_OAUTH_FLAGS.filter((flag) => flag !== 'enabled')) {
      expect(managedMCPOAuthOperationEnabled({ managed_mcp_oauth: pinned }, flag)).toBe(false);
    }
  });

  it('requires full wiring for cleanup independently of vending', () => {
    expect(() => validateManagedMCPOAuthConfig({ enabled: false, revocation: true })).toThrow();
    expect(() =>
      validateManagedMCPOAuthConfig({ ...configured, enabled: false, revocation: true })
    ).not.toThrow();
  });
  it('sanitizes malformed issuer parser errors', () => {
    expect(() =>
      validateManagedMCPOAuthConfig({
        ...configured,
        worker_issuer: 'invalid sensitive diagnostic marker',
      })
    ).toThrow('Managed MCP OAuth requires an exact worker issuer on the broker origin');
    try {
      validateManagedMCPOAuthConfig({
        ...configured,
        worker_issuer: 'invalid sensitive diagnostic marker',
      });
    } catch (error) {
      expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(
        'sensitive diagnostic marker'
      );
    }
  });
  it('pins deployment admission to the exact mirrored Cloud source bytes', () => {
    const bytes = readFileSync(new URL('../types/mcp-managed-oauth-contract.ts', import.meta.url));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      MANAGED_MCP_OAUTH_CONTRACT_SOURCE_SHA256
    );
  });
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
      ).toBe(flag === 'revocation');
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
