import type { CodexOptions } from '@agor/core/sdk';

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
export function applyAgorCodexLaunchPolicy(
  config: CodexConfigObject | undefined
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
    features: {
      ...features,
      // Agor sessions/subsessions are the supported, observable orchestration boundary.
      multi_agent: false,
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
