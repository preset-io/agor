import { describe, expect, it } from 'vitest';
import { parseVegaLiteSpec } from './vegaLiteSpec';

const validSpec = {
  description: 'Revenue by month',
  data: { values: [{ month: 'Jan', revenue: 28 }] },
  mark: 'bar',
  encoding: {
    x: { field: 'month', type: 'nominal' },
    y: { field: 'revenue', type: 'quantitative' },
  },
};

describe('parseVegaLiteSpec', () => {
  it('accepts a bounded inline-data Vega-Lite spec', () => {
    expect(parseVegaLiteSpec(JSON.stringify(validSpec))).toEqual({
      description: 'Revenue by month',
      spec: validSpec,
    });
  });

  it('adds a generic accessible description when one is absent', () => {
    const { description, spec } = parseVegaLiteSpec(
      JSON.stringify({ ...validSpec, description: undefined })
    );

    expect(description).toBe('Vega-Lite data visualization');
    expect(spec.description).toBe(description);
  });

  it.each([
    ['remote data', { ...validSpec, data: { url: 'https://example.com/data.json' } }],
    [
      'remote image encodings',
      { ...validSpec, encoding: { url: { value: 'https://example.com/x.png' } } },
    ],
    ['image marks', { ...validSpec, mark: 'image' }],
    ['embed overrides', { ...validSpec, usermeta: { embedOptions: { actions: true } } }],
  ])('rejects %s', (_label, spec) => {
    expect(() => parseVegaLiteSpec(JSON.stringify(spec))).toThrow(/not allowed|image marks/i);
  });

  it('rejects malformed and potentially explosive specs', () => {
    expect(() => parseVegaLiteSpec('{"mark":')).toThrow(/Could not parse/);
    expect(() =>
      parseVegaLiteSpec(JSON.stringify({ data: { sequence: { start: 0, stop: 1_000_000 } } }))
    ).toThrow(/generate more than/);
    expect(() =>
      parseVegaLiteSpec(
        JSON.stringify({
          repeat: { column: Array.from({ length: 17 }, (_, index) => `field_${index}`) },
          spec: validSpec,
        })
      )
    ).toThrow(/repeated fields/);
    expect(() => parseVegaLiteSpec(' '.repeat(100_001))).toThrow(/too large/);
  });
});
