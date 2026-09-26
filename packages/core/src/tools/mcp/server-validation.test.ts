import { describe, expect, it, vi } from 'vitest';
import {
  assertValidDiscoveredMCPCapabilities,
  isMCPServerWriteValidationError,
  MCPServerWriteValidationError,
} from './server-validation';

describe('discovered MCP capability validation', () => {
  it('accepts protocol-valid multiline descriptions', () => {
    expect(() =>
      assertValidDiscoveredMCPCapabilities({
        tools: [
          {
            name: 'resolve-library-id',
            description:
              'Resolve a library.\n\nRules:\n- prefer an exact match\n- explain ambiguity',
            input_schema: {
              type: 'object',
              properties: {
                'line\nbreak': {
                  type: 'string',
                  description: 'First line\r\n\tIndented second line',
                  examples: ['one\ntwo', { explanation: 'left\tright' }],
                },
              },
            },
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

  it('rejects NUL in nested input_schema text for PostgreSQL jsonb parity', () => {
    const unsafe = '\0';
    expect(() =>
      assertValidDiscoveredMCPCapabilities({
        tools: [
          {
            name: 'unsafe',
            input_schema: {
              type: 'object',
              properties: {
                query: { type: 'string', description: `hidden${unsafe}suffix` },
              },
            },
          },
        ],
        resources: [],
        prompts: [],
      })
    ).toThrow(/tools\[0\]\.input_schema.*contains an invalid string/);
  });

  it('rejects unsafe controls in top-level capability prose', () => {
    expect(() =>
      assertValidDiscoveredMCPCapabilities({
        tools: [{ name: 'unsafe', description: 'hidden\u0007suffix' }],
        resources: [],
        prompts: [],
      })
    ).toThrow(/tools\[0\]\.description must be a bounded string/);
  });

  it.each(['\0', '\u0007', '\u001f', '\u007f'])(
    'rejects non-whitespace controls in schema keys: %j',
    (control) => {
      expect(() =>
        assertValidDiscoveredMCPCapabilities({
          tools: [{ name: 'search', input_schema: { properties: { [`key${control}`]: {} } } }],
        })
      ).toThrow(/contains an invalid key/);
    }
  );

  it('classifies validator errors without invoking a hostile prototype trap', () => {
    const getPrototypeOf = vi.fn(() => {
      throw new Error('provider-controlled trap');
    });
    const hostile = new Proxy(new Error('provider-controlled prose'), { getPrototypeOf });

    expect(isMCPServerWriteValidationError(new MCPServerWriteValidationError('safe'))).toBe(true);
    expect(isMCPServerWriteValidationError(hostile)).toBe(false);
    expect(getPrototypeOf).toHaveBeenCalledOnce();
  });
});
