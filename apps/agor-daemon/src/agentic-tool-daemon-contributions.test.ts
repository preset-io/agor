import { OPENCODE_DAEMON_CONTRIBUTION } from '@agor/agentic-tool-opencode/daemon';
import { AGENTIC_TOOL_NAMES } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import {
  AGENTIC_TOOL_DAEMON_CONTRIBUTIONS,
  getAgenticToolDaemonContribution,
} from './agentic-tool-daemon-contributions.js';

describe('agentic-tool daemon contributions (design §4/§13 Phase 2)', () => {
  it('exposes a contribution for every canonical tool exactly once', () => {
    expect(Object.keys(AGENTIC_TOOL_DAEMON_CONTRIBUTIONS).sort()).toEqual(
      [...AGENTIC_TOOL_NAMES].sort()
    );
  });

  it('wires OpenCode to its real contribution byte-for-byte', () => {
    expect(AGENTIC_TOOL_DAEMON_CONTRIBUTIONS.opencode).toBe(OPENCODE_DAEMON_CONTRIBUTION);
    expect(typeof AGENTIC_TOOL_DAEMON_CONTRIBUTIONS.opencode.getExecutorLaunch).toBe('function');
  });

  it('keeps every non-OpenCode tool an inert no-op this phase', () => {
    for (const tool of AGENTIC_TOOL_NAMES) {
      if (tool === 'opencode') continue;
      expect(AGENTIC_TOOL_DAEMON_CONTRIBUTIONS[tool].getExecutorLaunch).toBeUndefined();
    }
  });

  it('resolves known tools and returns undefined for unmapped/legacy names', () => {
    expect(getAgenticToolDaemonContribution('opencode')).toBe(OPENCODE_DAEMON_CONTRIBUTION);
    expect(getAgenticToolDaemonContribution('claude-code')?.getExecutorLaunch).toBeUndefined();
    // Legacy persisted identifier that is no longer in the runtime registry.
    expect(getAgenticToolDaemonContribution('claude-code-cli')).toBeUndefined();
    expect(getAgenticToolDaemonContribution('not-a-tool')).toBeUndefined();
  });
});
