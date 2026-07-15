import { describe, expect, it } from 'vitest';
import { parseVegaLiteSpec } from './vegaLiteSpec';

const validSpec = {
  description: 'Revenue by month',
  width: 'container',
  height: 240,
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
    [
      'timer-driven selections',
      {
        ...validSpec,
        params: [{ name: 'pulse', select: { type: 'point', on: 'timer:1' } }],
      },
    ],
    ['authored event config', { ...validSpec, config: { events: { view: ['mousemove'] } } }],
    ['signal bindings', { ...validSpec, signals: [{ name: 'value', bind: { input: 'range' } }] }],
    ['facets', { ...validSpec, facet: { field: 'month' }, spec: validSpec }],
    ['repeated views', { repeat: { row: ['a'], column: ['b'] }, spec: validSpec }],
  ])('rejects %s', (_label, spec) => {
    expect(() => parseVegaLiteSpec(JSON.stringify(spec))).toThrow(
      /not allowed|image marks|static|unbounded/i
    );
  });

  it.each([
    ['view step defaults', { ...validSpec, config: { view: { step: 100_000_000 } } }],
    [
      'continuous height defaults',
      { ...validSpec, config: { view: { continuousHeight: 100_000_000 } } },
    ],
    [
      'discrete width step defaults',
      { ...validSpec, config: { view: { discreteWidth: { step: 100_000_000 } } } },
    ],
  ])('rejects unsafe %s', (_label, spec) => {
    expect(() => parseVegaLiteSpec(JSON.stringify(spec))).toThrow(/step|no greater than/i);
  });

  it('does not mistake ordinary inline data fields for layout dimensions', () => {
    const spec = {
      ...validSpec,
      data: { values: [{ width: 'small', height: 'tall', revenue: 28 }] },
    };

    expect(parseVegaLiteSpec(JSON.stringify(spec)).spec).toEqual(spec);
  });

  it.each([
    ['coercible numeric width', { ...validSpec, width: '1e9' }],
    ['step-sized width', { ...validSpec, width: { step: 100_000_000 } }],
    ['negative height', { ...validSpec, height: -1 }],
    ['unknown width keyword', { ...validSpec, width: 'fit' }],
  ])('rejects %s', (_label, spec) => {
    expect(() => parseVegaLiteSpec(JSON.stringify(spec))).toThrow(
      /must be "container" or a finite nonnegative number/
    );
  });

  it('rejects malformed and potentially explosive specs', () => {
    expect(() => parseVegaLiteSpec('{"mark":')).toThrow(/Could not parse/);
    expect(() =>
      parseVegaLiteSpec(JSON.stringify({ data: { sequence: { start: 0, stop: 1_000_000 } } }))
    ).toThrow(/generate more than/);
    expect(() =>
      parseVegaLiteSpec(
        JSON.stringify({
          layer: Array.from({ length: 4 }, () => ({
            concat: Array.from({ length: 5 }, () => validSpec),
          })),
        })
      )
    ).toThrow(/expands to 20 views/);
    expect(() => parseVegaLiteSpec(' '.repeat(100_001))).toThrow(/too large/);
  });
});
