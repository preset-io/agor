import { AGENTIC_TOOL_NAMES } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import {
  AGENTIC_TOOL_CAPABILITIES,
  AGENTIC_TOOL_DISPLAY_NAMES,
  AGENTIC_TOOL_INTEGRATIONS,
  getAgenticToolModelSelectionError,
  TOOL_API_KEY_NAMES,
} from './index.js';

describe('agentic-tool integrations', () => {
  it.each(['codex', 'opencode'] as const)(
    'exposes every Agor reasoning effort level for %s',
    (tool) => {
      expect(AGENTIC_TOOL_CAPABILITIES[tool].reasoningEffortLevels).toEqual([
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
      ]);
    }
  );

  it('describes every canonical tool exactly once', () => {
    expect(Object.keys(AGENTIC_TOOL_INTEGRATIONS).sort()).toEqual([...AGENTIC_TOOL_NAMES].sort());
  });

  describe('config-home relocation capability (design §5/§5.1)', () => {
    // The exact matrix shipped in Phase 2. Cursor is the one unsupported tool —
    // its relocation is confirmed broken upstream (design §5).
    const EXPECTED_SUPPORT: Record<(typeof AGENTIC_TOOL_NAMES)[number], boolean> = {
      'claude-code': true,
      codex: true,
      gemini: true,
      opencode: true,
      copilot: true,
      cursor: false,
    };

    const EXPECTED_MAPPING: Partial<
      Record<(typeof AGENTIC_TOOL_NAMES)[number], { semantics: string; envVars: string[] }>
    > = {
      'claude-code': { semantics: 'config-dir', envVars: ['CLAUDE_CONFIG_DIR'] },
      codex: { semantics: 'config-dir', envVars: ['CODEX_HOME', 'CODEX_SQLITE_HOME'] },
      gemini: { semantics: 'home-root', envVars: ['GEMINI_CLI_HOME'] },
      opencode: {
        semantics: 'home-root',
        envVars: ['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME'],
      },
      copilot: { semantics: 'config-dir', envVars: ['COPILOT_HOME', 'COPILOT_CACHE_HOME'] },
      // cursor: intentionally absent
    };

    it.each(AGENTIC_TOOL_NAMES)('reports the shipped capability for %s', (tool) => {
      expect(AGENTIC_TOOL_CAPABILITIES[tool].supportsConfigHomeOverride).toBe(
        EXPECTED_SUPPORT[tool]
      );
    });

    it.each(AGENTIC_TOOL_NAMES)('records the shipped env-var mapping for %s', (tool) => {
      expect(AGENTIC_TOOL_INTEGRATIONS[tool].configHomeOverride).toEqual(EXPECTED_MAPPING[tool]);
    });

    // The core invariant of §5.1: the browser-facing boolean is DERIVED from the
    // mapping, so they can never disagree. This guards the derivation in
    // defineIntegration against a future hand-edit that sets only one side.
    it.each(AGENTIC_TOOL_NAMES)('keeps the boolean and the mapping consistent for %s', (tool) => {
      const integration = AGENTIC_TOOL_INTEGRATIONS[tool];
      expect(integration.capabilities.supportsConfigHomeOverride).toBe(
        integration.configHomeOverride !== undefined
      );
    });

    it('flows the derived boolean through AGENTIC_TOOL_CAPABILITIES', () => {
      for (const tool of AGENTIC_TOOL_NAMES) {
        expect(AGENTIC_TOOL_CAPABILITIES[tool].supportsConfigHomeOverride).toBe(
          AGENTIC_TOOL_INTEGRATIONS[tool].capabilities.supportsConfigHomeOverride
        );
      }
    });
  });

  it('owns OpenCode metadata without inventing a host credential', () => {
    expect(AGENTIC_TOOL_INTEGRATIONS.opencode).toMatchObject({
      name: 'opencode',
      displayName: 'OpenCode',
      authentication: 'runtime-managed',
      sdkVersion: '@opencode-ai/sdk@1.14.33',
      unverifiedTerminationReason: 'OpenCode server-side execution termination is not verified.',
    });
    expect(TOOL_API_KEY_NAMES.opencode).toBeUndefined();
    expect(AGENTIC_TOOL_CAPABILITIES.opencode).toEqual(
      AGENTIC_TOOL_INTEGRATIONS.opencode.capabilities
    );
    expect(AGENTIC_TOOL_DISPLAY_NAMES.opencode).toBe('OpenCode');
    expect(
      getAgenticToolModelSelectionError('opencode', { provider: 'openai', model: '' })
    ).toMatch(/provider and model/i);
    expect(
      getAgenticToolModelSelectionError('opencode', { provider: 'openai', model: 'gpt-5' })
    ).toBeUndefined();
  });
});
