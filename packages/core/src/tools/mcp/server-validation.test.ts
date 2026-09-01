import { describe, expect, it } from 'vitest';
import { assertValidDiscoveredMCPCapabilities } from './server-validation';

describe('discovered MCP capability validation', () => {
  it('accepts protocol-valid multiline descriptions', () => {
    expect(() =>
      assertValidDiscoveredMCPCapabilities({
        tools: [
          {
            name: 'resolve-library-id',
            description:
              'Resolve a library.\n\nRules:\n- prefer an exact match\n- explain ambiguity',
          },
        ],
        resources: [
          {
            uri: 'docs://guide',
            name: 'Guide',
            description: 'First line\r\nSecond line',
          },
        ],
        prompts: [
          {
            name: 'research',
            description: 'Research\tcarefully',
            arguments: [{ name: 'topic', description: 'Line one\nLine two' }],
          },
        ],
      })
    ).not.toThrow();
  });

  it('still rejects unsafe control characters in descriptions', () => {
    expect(() =>
      assertValidDiscoveredMCPCapabilities({
        tools: [{ name: 'unsafe', description: 'hidden\0suffix' }],
        resources: [],
        prompts: [],
      })
    ).toThrow(/tools\[0\]\.description must be a bounded string/);
  });
});
