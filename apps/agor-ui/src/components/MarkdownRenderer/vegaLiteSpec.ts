const MAX_SPEC_BYTES = 100_000;
const MAX_DEPTH = 32;
const MAX_NODES = 10_000;
const MAX_ARRAY_ITEMS = 2_000;
const MAX_COMPOSED_VIEWS = 16;
const MAX_DIMENSION = 2_000;
const MAX_SEQUENCE_ITEMS = 10_000;

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
 * The POC only accepts inline data. Blocking every `url`/`href` key is
 * intentionally conservative: Vega can load both datasets and images, and a
 * chart in an agent response must not become an ambient browser fetch.
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
  validateSpecLayout(parsed, '$');
  validateComposedViewCount(parsed);

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
    const childPath = `${path}.${key}`;
    const normalizedKey = key.toLowerCase();

    if (normalizedKey === 'url' || normalizedKey === 'href') {
      throw new VegaLiteSpecError(
        `${childPath} is not allowed; conversation charts must use inline data and cannot load remote resources.`
      );
    }
    if (normalizedKey === 'usermeta') {
      throw new VegaLiteSpecError(
        `${childPath} is not allowed because it can override embed behavior.`
      );
    }
    if (['params', 'selection', 'signals', 'bind', 'events'].includes(normalizedKey)) {
      throw new VegaLiteSpecError(
        `${childPath} is not allowed; conversation charts are static and cannot register event streams or bindings.`
      );
    }
    if (normalizedKey === 'facet' || normalizedKey === 'repeat') {
      throw new VegaLiteSpecError(
        `${childPath} is not allowed because it can expand one authored spec into an unbounded number of views.`
      );
    }
    if (
      ['layer', 'concat', 'hconcat', 'vconcat'].includes(normalizedKey) &&
      Array.isArray(child) &&
      child.length > MAX_COMPOSED_VIEWS
    ) {
      throw new VegaLiteSpecError(
        `${childPath} cannot contain more than ${MAX_COMPOSED_VIEWS} views.`
      );
    }
    if (normalizedKey === 'mark' && isImageMark(child)) {
      throw new VegaLiteSpecError(
        `${childPath} cannot use image marks because images may trigger remote loads.`
      );
    }
    if (normalizedKey === 'sequence' && isRecord(child)) {
      validateSequence(child, childPath);
    }

    inspectValue(child, childPath, depth + 1, state);
  }
}

/**
 * Validate dimensions only where Vega-Lite interprets them as layout. A
 * recursive property-name check is both incomplete (config aliases exist) and
 * incorrect (inline data may legitimately contain fields named width/height).
 */
function validateSpecLayout(spec: Record<string, unknown>, path: string): void {
  if (Object.hasOwn(spec, 'width')) validateDimension(spec.width, `${path}.width`);
  if (Object.hasOwn(spec, 'height')) validateDimension(spec.height, `${path}.height`);

  const config = spec.config;
  if (isRecord(config) && isRecord(config.view)) {
    validateViewConfig(config.view, `${path}.config.view`);
  }

  for (const key of ['layer', 'concat', 'hconcat', 'vconcat']) {
    const children = spec[key];
    if (!Array.isArray(children)) continue;
    children.forEach((child, index) => {
      if (isRecord(child)) validateSpecLayout(child, `${path}.${key}[${index}]`);
    });
  }
}

function validateDimension(value: unknown, path: string): void {
  const isBoundedNumber =
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_DIMENSION;
  if (isBoundedNumber || value === 'container') return;

  throw new VegaLiteSpecError(
    `${path} must be "container" or a finite nonnegative number no greater than ${MAX_DIMENSION.toLocaleString()} pixels; numeric strings, step sizing, and other objects are not allowed.`
  );
}

function validateViewConfig(view: Record<string, unknown>, path: string): void {
  if (Object.hasOwn(view, 'step')) {
    throw new VegaLiteSpecError(
      `${path}.step is not allowed because per-category step sizing can create an unbounded aggregate chart dimension.`
    );
  }

  for (const key of [
    'width',
    'height',
    'continuousWidth',
    'continuousHeight',
    'discreteWidth',
    'discreteHeight',
  ]) {
    if (!Object.hasOwn(view, key)) continue;
    validateFixedDimension(view[key], `${path}.${key}`);
  }
}

function validateFixedDimension(value: unknown, path: string): void {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_DIMENSION) {
    return;
  }

  throw new VegaLiteSpecError(
    `${path} must be a finite nonnegative number no greater than ${MAX_DIMENSION.toLocaleString()} pixels; step sizing and coercible values are not allowed.`
  );
}

/**
 * Individual composition arrays are insufficient as a limit: nested arrays
 * multiply/sum into much larger render trees. Count unit views across the
 * complete authored composition and fail closed before Vega compiles it.
 */
function validateComposedViewCount(spec: Record<string, unknown>): void {
  const viewCount = countComposedViews(spec);
  if (viewCount > MAX_COMPOSED_VIEWS) {
    throw new VegaLiteSpecError(
      `Spec expands to ${viewCount.toLocaleString()} views; the maximum is ${MAX_COMPOSED_VIEWS}.`
    );
  }
}

function countComposedViews(spec: Record<string, unknown>): number {
  let composedViews = 0;
  for (const key of ['layer', 'concat', 'hconcat', 'vconcat']) {
    const children = spec[key];
    if (!Array.isArray(children)) continue;
    composedViews += children.reduce(
      (total, child) => total + (isRecord(child) ? countComposedViews(child) : 1),
      0
    );
  }

  return composedViews || 1;
}

function validateSequence(sequence: Record<string, unknown>, path: string): void {
  const start = typeof sequence.start === 'number' ? sequence.start : 0;
  const stop = typeof sequence.stop === 'number' ? sequence.stop : undefined;
  const step = typeof sequence.step === 'number' ? sequence.step : 1;
  if (
    stop === undefined ||
    !Number.isFinite(start) ||
    !Number.isFinite(stop) ||
    !Number.isFinite(step) ||
    step === 0
  ) {
    throw new VegaLiteSpecError(
      `${path} must contain finite start/stop values and a non-zero step.`
    );
  }
  const itemCount = Math.max(0, Math.ceil((stop - start) / step));
  if (itemCount > MAX_SEQUENCE_ITEMS) {
    throw new VegaLiteSpecError(
      `${path} would generate more than ${MAX_SEQUENCE_ITEMS.toLocaleString()} rows.`
    );
  }
}

function isImageMark(value: unknown): boolean {
  if (typeof value === 'string') return value.toLowerCase() === 'image';
  return isRecord(value) && typeof value.type === 'string' && value.type.toLowerCase() === 'image';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
