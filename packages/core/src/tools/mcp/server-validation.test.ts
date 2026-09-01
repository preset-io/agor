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

  it.each([
    ['NUL', '\0'],
    ['BEL', '\u0007'],
    ['other C0', '\u001f'],
    ['DEL', '\u007f'],
  ])('rejects %s in nested input_schema text', (_label, unsafe) => {
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

  it('rejects unsafe controls under the same policy in top-level capability prose', () => {
    expect(() =>
      assertValidDiscoveredMCPCapabilities({
        tools: [{ name: 'unsafe', description: 'hidden\u0007suffix' }],
        resources: [],
        prompts: [],
      })
    ).toThrow(/tools\[0\]\.description must be a bounded string/);
  });

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
