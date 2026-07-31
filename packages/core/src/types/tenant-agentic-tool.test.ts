import { describe, expect, it } from 'vitest';
import { AGENTIC_TOOL_NAMES } from './agentic-tool.js';
import {
  isProviderConnectionTool,
  PROVIDER_CONNECTION_FIELDS,
  TENANT_AGENTIC_TOOL_NAMES,
} from './tenant-agentic-tool.js';

describe('tenant agentic-tool ownership', () => {
  it('reuses the canonical installed tool names', () => {
    expect(TENANT_AGENTIC_TOOL_NAMES).toBe(AGENTIC_TOOL_NAMES);
  });

  it('derives provider-connection tools from their authoritative field map', () => {
    expect(isProviderConnectionTool('codex')).toBe(true);
    expect(isProviderConnectionTool('opencode')).toBe(false);
    expect(Object.keys(PROVIDER_CONNECTION_FIELDS)).not.toContain('opencode');
  });
});
