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
    expect(() => parseVegaLiteSpec(JSON.stringify(spec))).toThrow(/outside|supported|not allowed/i);
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
    expect(() => parseVegaLiteSpec(JSON.stringify(spec))).toThrow(/outside/i);
  });

  it('does not mistake ordinary inline data fields for layout dimensions', () => {
    const spec = {
      ...validSpec,
      data: {
        values: [
          { width: 'small', height: 'tall', href: 'category-a', url: 'category-b', revenue: 28 },
        ],
      },
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
      /must be ("container" or )?a finite nonnegative number/
    );
  });

  it.each([
    ['huge root padding', { ...validSpec, padding: 100_000_000 }],
    ['concat spacing', { ...validSpec, concat: [validSpec], spacing: 100_000_000 }],
    ['concat config spacing', { ...validSpec, config: { concat: { spacing: 100_000_000 } } }],
    [
      'authored mark geometry',
      { ...validSpec, mark: { type: 'point', size: 10_000_000_000_000_000 } },
    ],
    [
      'density transforms',
      { ...validSpec, transform: [{ density: 'revenue', steps: 100_000_000 }] },
    ],
  ])('rejects %s outside the allowlisted unit-chart subset', (_label, spec) => {
    expect(() => parseVegaLiteSpec(JSON.stringify(spec))).toThrow(/outside|mark geometry/i);
  });

  it('requires explicit bounded layout dimensions', () => {
    const { width: _width, ...withoutWidth } = validSpec;
    expect(() => parseVegaLiteSpec(JSON.stringify(withoutWidth))).toThrow(/width.*required/i);
    expect(() => parseVegaLiteSpec(JSON.stringify({ ...validSpec, height: 'container' }))).toThrow(
      /height must be a finite/i
    );
  });

  it.each([
    null,
    '',
    { unexpected: 'object' },
  ])('rejects an invalid authored count field: %j', (field) => {
    const spec = {
      ...validSpec,
      encoding: {
        y: { aggregate: 'count', field, type: 'quantitative' },
      },
    };

    expect(() => parseVegaLiteSpec(JSON.stringify(spec))).toThrow(/field must name/);
  });

  it('allows count to omit its field', () => {
    const spec = {
      ...validSpec,
      encoding: { y: { aggregate: 'count', type: 'quantitative' } },
    };

    expect(parseVegaLiteSpec(JSON.stringify(spec)).spec).toEqual(spec);
  });

  it('rejects malformed and overly large specs', () => {
    expect(() => parseVegaLiteSpec('{"mark":')).toThrow(/Could not parse/);
    expect(() =>
      parseVegaLiteSpec(
        JSON.stringify({
          ...validSpec,
          data: { values: Array.from({ length: 2_001 }, (_, value) => ({ value })) },
        })
      )
    ).toThrow(/maximum is 2,000/);
    expect(() => parseVegaLiteSpec(' '.repeat(100_001))).toThrow(/too large/);
  });
});
