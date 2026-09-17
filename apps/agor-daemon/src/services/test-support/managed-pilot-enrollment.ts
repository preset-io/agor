/** TEST ONLY: declared operator inputs for consumer tests, NOT real enrollment/clock provenance. */
import type { AgorConfig } from '@agor/core/config';
import {
  type McpOAuthFreshPilotEnrollment,
  mcpOAuthFreshPilotRuntimeConfigDigest,
} from '@agor/core/types';

export const SYNTHETIC_PILOT_POD_UID = '66666666-6666-4666-8666-666666666666';

export function syntheticFreshPilotEnrollment(config: AgorConfig): McpOAuthFreshPilotEnrollment {
  return {
    version: 1,
    environment: 'staging',
    region: 'us-west-2',
    enrollment_id: '11111111-1111-4111-8111-111111111111',
    cell_birth_id: '22222222-2222-4222-8222-222222222222',
    database_birth_id: '33333333-3333-4333-8333-333333333333',
    namespace: 'synthetic-fresh-cell',
    namespace_uid: '44444444-4444-4444-8444-444444444444',
    admission_policy_uid: '55555555-5555-4555-8555-555555555555',
    admission_policy_digest: '1'.repeat(64),
    runtime_image: `registry.example/runtime@sha256:${'2'.repeat(64)}`,
    worker_image: `registry.example/worker@sha256:${'3'.repeat(64)}`,
    executor_image: `registry.example/executor@sha256:${'4'.repeat(64)}`,
    runtime_config_digest: mcpOAuthFreshPilotRuntimeConfigDigest(config),
    worker_config_digest: '6'.repeat(64),
    database_binding_digest: '7'.repeat(64),
    source_policy_digest: '8'.repeat(64),
    issuer_uncertainty_ms: 2500,
  };
}
