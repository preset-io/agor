import { describe, expect, it } from 'vitest';
import { MCP_RUNTIME_PROVIDER_CAPABILITIES } from './runtime-refresh';

describe('MCP runtime provider capability matrix', () => {
  it('advertises only Claude as a safe in-place task-scoped transport rebuild', () => {
    expect(MCP_RUNTIME_PROVIDER_CAPABILITIES['claude-code']).toMatchObject({
      mode: 'in_place',
      transport_reload: true,
      retries_unstarted_call: false,
    });
    for (const provider of [
      'copilot',
      'codex',
      'gemini',
      'opencode',
      'cursor',
      'claude-code-cli',
    ] as const) {
      expect(MCP_RUNTIME_PROVIDER_CAPABILITIES[provider]).toMatchObject({
        mode: 'next_turn',
        transport_reload: false,
        retries_unstarted_call: false,
      });
    }
  });
});
