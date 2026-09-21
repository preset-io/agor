import { type AgorConfig, resolveEffectiveConfig } from '@agor/core/config';
import { mcpOAuthFreshPilotRuntimeConfigDigest } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { captureManagedOAuthPilotStartup } from './managed-pilot-startup.js';

const config: AgorConfig = {
  database: { dialect: 'postgresql' },
  daemon: { deployment_id: '11111111-1111-4111-8111-111111111111' },
  managed_mcp_oauth: {
    enabled: true,
    broker_origin: 'https://worker.example',
    worker_issuer: 'https://worker.example/',
    environment: 'staging',
    region: 'us-west-2',
    cell_id: 'synthetic-cell',
    credential_id: 'synthetic-sender',
    sender_key_id: 'synthetic-key',
    sender_private_key_path: '/protected/sender.pem',
    worker_public_keyring_path: '/protected/public.json',
    cell_evidence_path: '/protected/cell.json',
    clock_health_path: '/protected/clock.json',
    contract_sha256: 'a'.repeat(64),
    fresh_pilot_enrollment_sha256: 'b'.repeat(64),
  },
};
const environment = {
  AGOR_DAEMON_INSTANCE_ID: '22222222-2222-4222-8222-222222222222',
  AGOR_POD_NAMESPACE: 'synthetic-pilot',
};

describe('fresh pilot trusted startup capture', () => {
  it('captures the full source configuration before secret/default/environment resolution', () => {
    const raw = structuredClone(config);
    const captured = captureManagedOAuthPilotStartup(raw, environment)!;
    expect(captured).toEqual({
      podUid: environment.AGOR_DAEMON_INSTANCE_ID,
      podNamespace: environment.AGOR_POD_NAMESPACE,
      runtimeConfigDigest: mcpOAuthFreshPilotRuntimeConfigDigest(raw),
    });
    expect(Object.isFrozen(captured)).toBe(true);
    const effective = resolveEffectiveConfig(raw, {
      AGOR_MASTER_SECRET: 'synthetic-only-master',
      AGOR_JWT_SECRET: 'synthetic-only-jwt',
      PORT: '3032',
    });
    expect(effective.daemon?.masterSecret).toBe('synthetic-only-master');
    expect(effective.daemon?.port).toBe(3032);
    expect(mcpOAuthFreshPilotRuntimeConfigDigest(effective)).not.toBe(captured.runtimeConfigDigest);
    expect(raw).toEqual(config);
    expect(captureManagedOAuthPilotStartup(raw, environment)).toEqual(captured);
    expect(JSON.stringify(captured)).not.toContain('synthetic-only');
  });

  it('never treats the pin as enabling the feature, and does not require Pod metadata when disabled', () => {
    const forbiddenEnvironment = {
      get AGOR_DAEMON_INSTANCE_ID(): string {
        throw new Error('must not read');
      },
    };
    expect(captureManagedOAuthPilotStartup({}, forbiddenEnvironment)).toBeUndefined();
    expect(
      captureManagedOAuthPilotStartup(
        { ...config, managed_mcp_oauth: { ...config.managed_mcp_oauth, enabled: false } },
        forbiddenEnvironment
      )
    ).toBeUndefined();
    const legacy = structuredClone(config);
    delete legacy.managed_mcp_oauth!.fresh_pilot_enrollment_sha256;
    expect(captureManagedOAuthPilotStartup(legacy, forbiddenEnvironment)).toBeUndefined();
  });

  it.each([
    {},
    { ...environment, AGOR_DAEMON_INSTANCE_ID: undefined },
    { ...environment, AGOR_DAEMON_INSTANCE_ID: 'reusable-pod-name' },
    { ...environment, AGOR_POD_NAMESPACE: undefined },
    { ...environment, AGOR_POD_NAMESPACE: 'namespace/path' },
    { ...environment, AGOR_POD_NAMESPACE: ' namespace' },
  ])('refuses missing/invalid protected Pod metadata without a diagnostic fallback: %j', (env) => {
    expect(() => captureManagedOAuthPilotStartup(config, env)).toThrow(
      'Managed MCP OAuth deployment evidence is unavailable or unsafe.'
    );
  });

  it('binds every configuration change except the one explicitly excluded self-reference', () => {
    const captured = captureManagedOAuthPilotStartup(config, environment)!;
    const changedPin = structuredClone(config);
    changedPin.managed_mcp_oauth!.fresh_pilot_enrollment_sha256 = 'c'.repeat(64);
    expect(captureManagedOAuthPilotStartup(changedPin, environment)?.runtimeConfigDigest).toBe(
      captured.runtimeConfigDigest
    );
    const staticSource = structuredClone(config);
    staticSource.managed_mcp_oauth!.admission_mode = 'static_generation';
    expect(
      captureManagedOAuthPilotStartup(staticSource, environment)?.runtimeConfigDigest
    ).not.toBe(captured.runtimeConfigDigest);
    const changedSource = structuredClone(config);
    changedSource.daemon!.port = 3032;
    expect(
      captureManagedOAuthPilotStartup(changedSource, environment)?.runtimeConfigDigest
    ).not.toBe(captured.runtimeConfigDigest);
  });
});
