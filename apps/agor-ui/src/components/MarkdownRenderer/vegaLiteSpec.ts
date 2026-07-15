const MAX_SPEC_BYTES = 100_000;
const MAX_DEPTH = 32;
const MAX_NODES = 10_000;
const MAX_ARRAY_ITEMS = 2_000;
const MAX_DIMENSION = 2_000;
const MAX_FIELD_NAME_LENGTH = 256;
const MAX_LABEL_LENGTH = 500;
const MAX_DATA_STRING_LENGTH = 10_000;

const TOP_LEVEL_KEYS = new Set([
  '$schema',
  'data',
  'description',
  'encoding',
  'height',
  'mark',
  'title',
  'width',
]);
const MARK_TYPES = new Set([
  'arc',
  'area',
  'bar',
  'circle',
  'line',
  'point',
  'rect',
  'rule',
  'square',
  'tick',
]);
const ENCODING_CHANNELS = new Set([
  'color',
  'detail',
  'fill',
  'opacity',
  'order',
  'radius',
  'radius2',
  'shape',
  'size',
  'stroke',
  'theta',
  'theta2',
  'x',
  'x2',
  'y',
  'y2',
]);
const CHANNEL_KEYS = new Set([
  'aggregate',
  'axis',
  'bin',
  'field',
  'legend',
  'sort',
  'stack',
  'title',
  'type',
]);
const FIELD_TYPES = new Set(['nominal', 'ordinal', 'quantitative', 'temporal']);
const DATA_KEYS = new Set(['values']);
const SORT_VALUES = new Set<unknown>(['ascending', 'descending', null]);
const STACK_VALUES = new Set<unknown>(['zero', 'normalize', 'center', null]);
const AGGREGATES = new Set([
  'average',
  'count',
  'distinct',
  'max',
  'mean',
  'median',
  'min',
  'missing',
  'q1',
  'q3',
  'stdev',
  'stdevp',
  'sum',
  'valid',
  'variance',
  'variancep',
]);

export interface ParsedVegaLiteSpec {
  description: string;
  spec: Record<string, unknown>;
}

export class VegaLiteSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VegaLiteSpecError';
  }
}

/**
 * Parse the deliberately constrained Vega-Lite subset used in conversations.
 *
 * This is an explicit allowlist, not a partial Vega-Lite denylist. The POC
 * accepts one bounded unit chart over inline primitive rows and deliberately
 * excludes authored transforms, composition, configuration, expressions, and
 * mark geometry. Unreviewed Vega-Lite features remain ordinary source code.
 */
export function parseVegaLiteSpec(source: string): ParsedVegaLiteSpec {
  const byteLength = new TextEncoder().encode(source).byteLength;
  if (byteLength > MAX_SPEC_BYTES) {
    throw new VegaLiteSpecError(
      `Spec is too large (${byteLength.toLocaleString()} bytes; maximum is ${MAX_SPEC_BYTES.toLocaleString()}).`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'invalid JSON';
    throw new VegaLiteSpecError(`Could not parse the Vega-Lite JSON: ${detail}`);
  }

  if (!isRecord(parsed)) {
    throw new VegaLiteSpecError('A Vega-Lite spec must be a JSON object.');
  }

  const state = { nodes: 0 };
  inspectValue(parsed, '$', 0, state);
  validateSupportedUnitSpec(parsed);

  const description =
    typeof parsed.description === 'string' && parsed.description.trim()
      ? parsed.description.trim()
      : 'Vega-Lite data visualization';

  return {
    description,
    spec: parsed.description ? parsed : { ...parsed, description },
  };
}

function inspectValue(value: unknown, path: string, depth: number, state: { nodes: number }): void {
  state.nodes += 1;
  if (state.nodes > MAX_NODES) {
    throw new VegaLiteSpecError(
      `Spec is too complex (more than ${MAX_NODES.toLocaleString()} values).`
    );
  }
  if (depth > MAX_DEPTH) {
    throw new VegaLiteSpecError(`Spec is nested too deeply near ${path}.`);
  }

  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) {
      throw new VegaLiteSpecError(
        `${path} has ${value.length.toLocaleString()} items; the maximum is ${MAX_ARRAY_ITEMS.toLocaleString()}.`
      );
    }
    value.forEach((item, index) => {
      inspectValue(item, `${path}[${index}]`, depth + 1, state);
    });
    return;
  }

  if (!isRecord(value)) return;

  for (const [key, child] of Object.entries(value)) {
    inspectValue(child, `${path}.${key}`, depth + 1, state);
  }
}

function validateSupportedUnitSpec(spec: Record<string, unknown>): void {
  rejectUnknownKeys(spec, TOP_LEVEL_KEYS, '$');

  if (
    spec.$schema !== undefined &&
    spec.$schema !== 'https://vega.github.io/schema/vega-lite/v6.json'
  ) {
    throw new VegaLiteSpecError('$.$schema must identify the supported Vega-Lite v6 schema.');
  }
  validateOptionalText(spec.description, '$.description');
  validateOptionalText(spec.title, '$.title');

  if (!Object.hasOwn(spec, 'width') || !Object.hasOwn(spec, 'height')) {
    throw new VegaLiteSpecError('$.width and $.height are required for a bounded unit chart.');
  }
  validateDimension(spec.width, '$.width', true);
  validateDimension(spec.height, '$.height', false);
  validateInlineData(spec.data);
  validateMark(spec.mark);
  validateEncoding(spec.encoding);
}

function validateDimension(value: unknown, path: string, allowContainer: boolean): void {
  const isBoundedNumber =
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_DIMENSION;
  if (isBoundedNumber || (allowContainer && value === 'container')) return;

  throw new VegaLiteSpecError(
    `${path} must be ${allowContainer ? '"container" or ' : ''}a finite nonnegative number no greater than ${MAX_DIMENSION.toLocaleString()} pixels; numeric strings, step sizing, and other objects are not allowed.`
  );
}

function validateInlineData(value: unknown): void {
  if (!isRecord(value)) {
    throw new VegaLiteSpecError('$.data must be an object containing inline values.');
  }
  rejectUnknownKeys(value, DATA_KEYS, '$.data');
  if (!Array.isArray(value.values)) {
    throw new VegaLiteSpecError('$.data.values must be an array of inline rows.');
  }

  value.values.forEach((row, rowIndex) => {
    validateInlineRow(row, `$.data.values[${rowIndex}]`);
  });
}

function validateInlineRow(value: unknown, path: string): void {
  if (!isRecord(value)) {
    throw new VegaLiteSpecError(`${path} must be an object with primitive field values.`);
  }

  for (const [field, fieldValue] of Object.entries(value)) {
    if (!field || field.length > MAX_FIELD_NAME_LENGTH) {
      throw new VegaLiteSpecError(`${path} contains an invalid or overly long field name.`);
    }
    const isPrimitive =
      fieldValue === null || ['boolean', 'number', 'string'].includes(typeof fieldValue);
    if (!isPrimitive || (typeof fieldValue === 'number' && !Number.isFinite(fieldValue))) {
      throw new VegaLiteSpecError(`${path}.${field} must be a finite JSON primitive.`);
    }
    if (typeof fieldValue === 'string' && fieldValue.length > MAX_DATA_STRING_LENGTH) {
      throw new VegaLiteSpecError(`${path}.${field} is too long.`);
    }
  }
}

function validateMark(value: unknown): void {
  if (typeof value !== 'string' || !MARK_TYPES.has(value)) {
    throw new VegaLiteSpecError(
      '$.mark must be one of the supported static mark names; authored mark geometry is not allowed.'
    );
  }
}

function validateEncoding(value: unknown): void {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    throw new VegaLiteSpecError('$.encoding must contain at least one supported field channel.');
  }

  rejectUnknownKeys(value, ENCODING_CHANNELS, '$.encoding');
  for (const [channel, definition] of Object.entries(value)) {
    validateChannelDefinition(definition, `$.encoding.${channel}`);
  }
}

function validateChannelDefinition(value: unknown, path: string): void {
  if (!isRecord(value)) {
    throw new VegaLiteSpecError(`${path} must be a field definition object.`);
  }
  rejectUnknownKeys(value, CHANNEL_KEYS, path);

  const field = value.field;
  const hasAuthoredField = Object.hasOwn(value, 'field');
  const hasField = typeof field === 'string' && field.length > 0;
  const isCount = value.aggregate === 'count';
  if ((hasAuthoredField && !hasField) || (!hasAuthoredField && !isCount)) {
    throw new VegaLiteSpecError(`${path}.field must name an inline-data field.`);
  }
  if (hasField && field.length > MAX_FIELD_NAME_LENGTH) {
    throw new VegaLiteSpecError(`${path}.field is too long.`);
  }
  if (typeof value.type !== 'string' || !FIELD_TYPES.has(value.type)) {
    throw new VegaLiteSpecError(
      `${path}.type must be nominal, ordinal, quantitative, or temporal.`
    );
  }
  if (value.aggregate !== undefined) {
    if (typeof value.aggregate !== 'string' || !AGGREGATES.has(value.aggregate)) {
      throw new VegaLiteSpecError(`${path}.aggregate is not supported.`);
    }
  }
  if (value.bin !== undefined && typeof value.bin !== 'boolean') {
    throw new VegaLiteSpecError(`${path}.bin must be a boolean.`);
  }
  if (value.sort !== undefined && !SORT_VALUES.has(value.sort)) {
    throw new VegaLiteSpecError(`${path}.sort must be ascending, descending, or null.`);
  }
  if (value.stack !== undefined && !STACK_VALUES.has(value.stack)) {
    throw new VegaLiteSpecError(`${path}.stack is not supported.`);
  }
  for (const key of ['axis', 'legend']) {
    if (value[key] !== undefined && value[key] !== null) {
      throw new VegaLiteSpecError(
        `${path}.${key} may only be null; authored guide configuration is not allowed.`
      );
    }
  }
  validateOptionalText(value.title, `${path}.title`, true);
}

function validateOptionalText(value: unknown, path: string, allowNull = false): void {
  if (value === undefined || (allowNull && value === null)) return;
  if (typeof value !== 'string' || value.length > MAX_LABEL_LENGTH) {
    throw new VegaLiteSpecError(
      `${path} must be a string no longer than ${MAX_LABEL_LENGTH} characters.`
    );
  }
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  path: string
): void {
  const unknownKey = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknownKey) {
    throw new VegaLiteSpecError(
      `${path}.${unknownKey} is outside the supported static unit-chart subset and will remain ordinary source code.`
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
