import { readFileSync } from 'node:fs';
import type { AgorConfig } from '@agor/core/config';

/**
 * Cloud's launch-enabled provisioning -> Helm configuration contract. Set
 * AGOR_TEST_HOSTED_CONFIG to a freshly rendered config.json for cross-repo
 * replay through the real services; ordinary tests use this minimal projection.
 */
export function hostedOpenCodeConfig(): AgorConfig {
  const rendered = process.env.AGOR_TEST_HOSTED_CONFIG;
  if (rendered) return JSON.parse(readFileSync(rendered, 'utf8')) as AgorConfig;
  return {
    multi_tenancy: { mode: 'required_from_auth' },
    execution: {
      unix_user_mode: 'delegated',
      executor_command_template: 'launch {payload}',
      executor_storage: { user_home: 'persistent-per-user' },
      sandbox: { sdk_home_mode: 'per_branch' },
    },
    agentic_tools: { opencode_hosted_native_state: 'checkpointed' },
  } as AgorConfig;
}
