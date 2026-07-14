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
    if (
      (normalizedKey === 'width' || normalizedKey === 'height') &&
      typeof child === 'number' &&
      child > MAX_DIMENSION
    ) {
      throw new VegaLiteSpecError(
        `${childPath} cannot exceed ${MAX_DIMENSION.toLocaleString()} pixels.`
      );
    }
    if (
      ['layer', 'concat', 'hconcat', 'vconcat', 'repeat'].includes(normalizedKey) &&
      Array.isArray(child) &&
      child.length > MAX_COMPOSED_VIEWS
    ) {
      throw new VegaLiteSpecError(
        `${childPath} cannot contain more than ${MAX_COMPOSED_VIEWS} views.`
      );
    }
    if (normalizedKey === 'repeat' && isRecord(child)) {
      for (const [channel, fields] of Object.entries(child)) {
        if (Array.isArray(fields) && fields.length > MAX_COMPOSED_VIEWS) {
          throw new VegaLiteSpecError(
            `${childPath}.${channel} cannot contain more than ${MAX_COMPOSED_VIEWS} repeated fields.`
          );
        }
      }
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
