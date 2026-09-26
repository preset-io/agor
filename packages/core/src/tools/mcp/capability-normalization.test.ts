import { describe, expect, it } from 'vitest';
import {
  MAX_MCP_CAPABILITY_DESCRIPTION_BUDGET,
  MAX_MCP_CAPABILITY_DESCRIPTION_LENGTH,
  MCP_DESCRIPTION_TRUNCATION_SUFFIX,
  MCPServerWriteValidationError,
  normalizeDiscoveredMCPCapabilities,
} from './server-validation';

const capabilities = (description?: unknown) => ({
  tools: [
    {
      name: 'fictional_mail_search',
      ...(description === undefined ? {} : { description }),
      input_schema: { type: 'object', properties: { query: { type: 'string' } } },
    },
  ],
  resources: [],
  prompts: [],
});

describe('normalizeDiscoveredMCPCapabilities', () => {
  it.each([
    ['missing', undefined],
    ['exactly at the limit', 'a'.repeat(MAX_MCP_CAPABILITY_DESCRIPTION_LENGTH)],
  ])('preserves valid %s descriptions', (_label, description) => {
    const result = normalizeDiscoveredMCPCapabilities(capabilities(description));
    expect(result.truncatedDescriptions).toBe(0);
    expect(result.capabilities.tools[0]?.description).toBe(description);
    expect(result.capabilities.tools[0]).toMatchObject({
      name: 'fictional_mail_search',
      input_schema: { type: 'object' },
    });
  });

  it.each([
    ['limit plus one', 'a'.repeat(MAX_MCP_CAPABILITY_DESCRIPTION_LENGTH + 1)],
    ['very long ASCII', 'mail metadata '.repeat(20_000)],
    ['emoji and graphemes', `${'x'.repeat(MAX_MCP_CAPABILITY_DESCRIPTION_LENGTH - 3)}👩🏽‍💻é`],
  ])('deterministically and Unicode-safely truncates %s', (_label, description) => {
    const first = normalizeDiscoveredMCPCapabilities(capabilities(description));
    const second = normalizeDiscoveredMCPCapabilities(capabilities(description));
    const normalized = first.capabilities.tools[0]?.description;
    expect(first).toEqual(second);
    expect(first.truncatedDescriptions).toBe(1);
    expect(normalized?.length).toBeLessThanOrEqual(MAX_MCP_CAPABILITY_DESCRIPTION_LENGTH);
    expect(normalized?.endsWith(MCP_DESCRIPTION_TRUNCATION_SUFFIX)).toBe(true);
    expect(normalized).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it('caps aggregate descriptions without dropping or reordering tools', () => {
    const result = normalizeDiscoveredMCPCapabilities({
      tools: Array.from({ length: 8 }, (_, index) => ({
        name: `tool_${index}`,
        description: String(index).repeat(MAX_MCP_CAPABILITY_DESCRIPTION_LENGTH),
        input_schema: { type: 'object' },
      })),
      resources: [],
      prompts: [],
    });
    expect(result.capabilities.tools.map((tool) => tool.name)).toEqual(
      Array.from({ length: 8 }, (_, index) => `tool_${index}`)
    );
    expect(
      result.capabilities.tools.reduce((sum, tool) => sum + (tool.description?.length ?? 0), 0)
    ).toBeLessThanOrEqual(MAX_MCP_CAPABILITY_DESCRIPTION_BUDGET);
    expect(result.truncatedDescriptions).toBeGreaterThan(0);
  });

  it.each([null, 1, {}, ['not text']])(
    'rejects malformed description value %j with a per-tool diagnostic',
    (description) => {
      expect(() => normalizeDiscoveredMCPCapabilities(capabilities(description))).toThrowError(
        new MCPServerWriteValidationError('tools[0].description must be a bounded string')
      );
    }
  );

  it('rejects malformed names and schemas instead of silently repairing them', () => {
    expect(() =>
      normalizeDiscoveredMCPCapabilities({
        tools: [{ name: '', input_schema: 'not-an-object' }],
        resources: [],
        prompts: [],
      })
    ).toThrow(/tools\[0\]\.name/);
  });

  it('preserves JSON schema text while retaining storage and structural bounds', () => {
    const input_schema = {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'First line\nSecond line' },
        separator: { type: 'string', enum: ['\n', '\t', '\b'], default: '\t' },
      },
    };
    const discovered = { tools: [{ name: 'search', input_schema }], resources: [], prompts: [] };
    expect(
      normalizeDiscoveredMCPCapabilities(discovered).capabilities.tools[0]?.input_schema
    ).toEqual(input_schema);
    for (const invalid of [
      null,
      'not a schema',
      { description: 'bad\0text' },
      { enum: Array(257).fill('x') },
    ]) {
      expect(() =>
        normalizeDiscoveredMCPCapabilities({
          ...discovered,
          tools: [{ name: 'search', input_schema: invalid }],
        })
      ).toThrow(/tools\[0\]\.input_schema/);
    }
  });

  it('allows protocol free text line breaks but rejects unsafe control characters', () => {
    expect(
      normalizeDiscoveredMCPCapabilities(capabilities('line one\nline two\tformatted')).capabilities
        .tools[0]?.description
    ).toBe('line one\nline two\tformatted');
    expect(() => normalizeDiscoveredMCPCapabilities(capabilities('bad\0text'))).toThrow(
      /tools\[0\]\.description/
    );
  });
});
