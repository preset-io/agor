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

  it('creates the required per-process override when no other config exists', () => {
    expect(applyAgorCodexLaunchPolicy(undefined)).toEqual({
      features: { multi_agent: false },
    });
  });

  it('fails clearly instead of dropping the policy when features cannot be merged', () => {
    expect(() => applyAgorCodexLaunchPolicy({ features: true } as CodexConfigObject)).toThrow(
      'Cannot launch Codex with Agor policy: config.features must be an object so features.multi_agent can be disabled'
    );
  });
});
