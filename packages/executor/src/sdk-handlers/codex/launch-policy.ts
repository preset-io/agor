import type { CodexOptions } from '@agor/core/sdk';
import { parse as parseToml } from 'smol-toml';

type CodexConfigObject = NonNullable<CodexOptions['config']>;

function isCodexConfigObject(value: unknown): value is CodexConfigObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Apply Agor-owned Codex process policy without changing the user's
 * `~/.codex/config.toml`.
 *
 * The Codex SDK flattens these objects into per-process overrides such as
 * `--config features.multi_agent=false` and
 * `--config tools.update_plan.enabled=true`. They intentionally win over user
 * configuration while every unrelated config key, including other feature
 * flags and tool toggles, remains intact.
 *
 * `tools.update_plan.enabled` is forced on because Agor renders the Codex
 * `update_plan` (todo_list) tool as its sticky task list. Newer Codex CLI
 * builds no longer expose that tool by default, so — mirroring the Claude
 * `allowedTools` opt-in — Agor always enables it rather than relying on the
 * runtime default. `update_plan` is a nested table (`{ enabled: bool }`), not a
 * scalar toggle like `tools.web_search`.
 */
/** Every MCP bearer Agor hands Codex travels in an env var matching this pattern. */
export const AGOR_MCP_ENV_PATTERN = 'AGOR_MCP_*';

/**
 * Keep Agor's MCP bearer env vars out of every shell command the agent runs.
 *
 * Codex reads `bearer_token_env_var`/`env_http_headers` from its own process
 * env, which its shell tool would otherwise inherit (`ignore_default_excludes`
 * defaults to true). Codex applies the policy form of the topmost layer that
 * sets one, so a `filters` override would silently drop a user's legacy
 * `exclude`/`include_only` list; in that case the legacy form is extended
 * instead.
 */
export function agorShellEnvironmentPolicy(userConfigToml: string | undefined): CodexConfigObject {
  let userPolicy: unknown;
  try {
    userPolicy = userConfigToml
      ? (parseToml(userConfigToml) as Record<string, unknown>).shell_environment_policy
      : undefined;
  } catch {
    // Codex refuses an unparseable config.toml itself; no user policy survives it.
  }
  const policy = isCodexConfigObject(userPolicy) ? userPolicy : {};
  if (policy.exclude !== undefined || policy.include_only !== undefined) {
    const userExclude = Array.isArray(policy.exclude)
      ? policy.exclude.filter((pattern): pattern is string => typeof pattern === 'string')
      : [];
    return { exclude: [...userExclude, AGOR_MCP_ENV_PATTERN] };
  }
  return { filters: { [AGOR_MCP_ENV_PATTERN]: 'exclude' } };
}

export function applyAgorCodexLaunchPolicy(
  config: CodexConfigObject | undefined,
  includePlugins = false,
  userConfigToml?: string
): CodexConfigObject {
  const features = config?.features;
  if (features !== undefined && !isCodexConfigObject(features)) {
    throw new Error(
      'Cannot launch Codex with Agor policy: config.features must be an object so features.multi_agent can be disabled'
    );
  }

  const tools = config?.tools;
  if (tools !== undefined && !isCodexConfigObject(tools)) {
    throw new Error(
      'Cannot launch Codex with Agor policy: config.tools must be an object so tools.update_plan can be enabled'
    );
  }

  const updatePlan = tools?.update_plan;
  if (updatePlan !== undefined && !isCodexConfigObject(updatePlan)) {
    throw new Error(
      'Cannot launch Codex with Agor policy: config.tools.update_plan must be an object so its enabled flag can be set'
    );
  }

  return {
    ...config,
    shell_environment_policy: agorShellEnvironmentPolicy(userConfigToml),
    features: {
      ...features,
      // Agor sessions/subsessions are the supported, observable orchestration boundary.
      multi_agent: false,
      // Opt-in permits native settings; it never forces plugins on.
      ...(includePlugins ? {} : { plugins: false }),
    },
    tools: {
      ...tools,
      update_plan: {
        ...updatePlan,
        // Agor's sticky task list is driven by Codex's update_plan tool.
        enabled: true,
      },
    },
  };
}
