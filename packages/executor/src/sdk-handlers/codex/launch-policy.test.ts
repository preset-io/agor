import type { CodexOptions } from '@agor/core/sdk';
import { describe, expect, it } from 'vitest';
import { applyAgorCodexLaunchPolicy } from './launch-policy.js';

type CodexConfigObject = NonNullable<CodexOptions['config']>;

describe('applyAgorCodexLaunchPolicy', () => {
  it('disables native multi-agent while preserving every unrelated override', () => {
    const config: CodexConfigObject = {
      features: {
        goals: false,
        memories: true,
        multi_agent: true,
      },
      model_instructions_file: '/tmp/agor-instructions.md',
      mcp_servers: {
        agor: {
          url: 'http://localhost:3030/mcp',
        },
      },
    };

    expect(applyAgorCodexLaunchPolicy(config)).toEqual({
      features: {
        goals: false,
        memories: true,
        multi_agent: false,
      },
      tools: {
        update_plan: { enabled: true },
      },
      model_instructions_file: '/tmp/agor-instructions.md',
      mcp_servers: {
        agor: {
          url: 'http://localhost:3030/mcp',
        },
      },
    });
    expect(config.features).toEqual({
      goals: false,
      memories: true,
      multi_agent: true,
    });
  });

  it('creates the required per-process overrides when no other config exists', () => {
    expect(applyAgorCodexLaunchPolicy(undefined)).toEqual({
      features: { multi_agent: false },
      tools: { update_plan: { enabled: true } },
    });
  });

  it('forces update_plan on while preserving sibling tool toggles and sub-fields', () => {
    const config: CodexConfigObject = {
      tools: {
        web_search: true,
        update_plan: { enabled: false, some_future_field: 'keep' },
      },
    };

    expect(applyAgorCodexLaunchPolicy(config)).toEqual({
      features: { multi_agent: false },
      tools: {
        web_search: true,
        update_plan: { enabled: true, some_future_field: 'keep' },
      },
    });
    // Input is not mutated.
    expect((config.tools as CodexConfigObject).update_plan).toEqual({
      enabled: false,
      some_future_field: 'keep',
    });
  });

  it('fails clearly instead of dropping the policy when features cannot be merged', () => {
    expect(() => applyAgorCodexLaunchPolicy({ features: true } as CodexConfigObject)).toThrow(
      'Cannot launch Codex with Agor policy: config.features must be an object so features.multi_agent can be disabled'
    );
  });

  it('fails clearly when tools cannot be merged', () => {
    expect(() => applyAgorCodexLaunchPolicy({ tools: true } as CodexConfigObject)).toThrow(
      'Cannot launch Codex with Agor policy: config.tools must be an object so tools.update_plan can be enabled'
    );
  });

  it('fails clearly when tools.update_plan cannot be merged', () => {
    expect(() =>
      applyAgorCodexLaunchPolicy({ tools: { update_plan: true } } as CodexConfigObject)
    ).toThrow(
      'Cannot launch Codex with Agor policy: config.tools.update_plan must be an object so its enabled flag can be set'
    );
  });
});
