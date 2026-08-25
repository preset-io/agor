import type { CodexOptions } from '@agor/core/sdk';

type CodexConfigObject = NonNullable<CodexOptions['config']>;

function isCodexConfigObject(value: unknown): value is CodexConfigObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Apply Agor-owned Codex process policy without changing the user's
 * `~/.codex/config.toml`.
 *
 * The Codex SDK flattens this object into per-process
 * `--config features.multi_agent=false`. That override intentionally wins over
 * user configuration while every unrelated config key, including other
 * feature flags, remains intact.
 */
export function applyAgorCodexLaunchPolicy(
  config: CodexConfigObject | undefined
): CodexConfigObject {
  const features = config?.features;
  if (features !== undefined && !isCodexConfigObject(features)) {
    throw new Error(
      'Cannot launch Codex with Agor policy: config.features must be an object so features.multi_agent can be disabled'
    );
  }

  return {
    ...config,
    features: {
      ...features,
      // Agor sessions/subsessions are the supported, observable orchestration boundary.
      multi_agent: false,
    },
  };
}
