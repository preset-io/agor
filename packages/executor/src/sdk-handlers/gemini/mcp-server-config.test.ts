/**
 * Pins Gemini's positional MCP config against the REAL shipped class.
 *
 * This is the one positional coupling in the codebase, and it fails OPEN: the
 * slot immediately before `excludeTools` is `includeTools`, an ALLOWLIST. If
 * the SDK ever inserts a parameter ahead of it, Agor's deny list slides one
 * slot left and becomes "permit only the tools the user switched off" —
 * every other tool on the server allowed, and no error anywhere.
 *
 * An earlier version of this file declared its own mirror of the constructor
 * and passed that in, so it asserted the builder agreed with a copy of the
 * signature rather than with the SDK. It therefore passed under exactly the
 * three mutations that matter: a parameter inserted before `excludeTools`, the
 * field renamed, or the field removed. Its header also claimed `tsc` covered
 * arity and types against the real class; it does not, because the builder
 * types the constructor as `new (...args: never[]) => T` and casts it to
 * `unknown[]`, which erases positional checking entirely.
 *
 * The real module cannot be imported here — `@google/gemini-cli-core` pulls in
 * an OpenTelemetry build that uses directory imports Node's ESM loader rejects,
 * which is what drove the mirror in the first place. So the signature is read
 * from the shipped `config.d.ts` instead. That is a real build artifact of the
 * installed package: it moves when the SDK moves, which a hand-written mirror
 * never does.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildGeminiMcpServerConfig } from './mcp-server-config.js';

/** Splits on top-level commas only, so `Record<string, string>` stays intact. */
function splitParams(raw: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of raw) {
    if ('<([{'.includes(char)) depth++;
    else if ('>)]}'.includes(char)) depth--;
    if (char === ',' && depth === 0) {
      out.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) out.push(current);
  return out;
}

/**
 * Constructor parameter names, in declaration order, from the installed SDK.
 *
 * Throws rather than falling back to a hardcoded list: if the declaration can
 * no longer be found, the coupling is unverified, and silently "passing" is the
 * failure this file exists to prevent.
 */
function readRealCtorParamOrder(): string[] {
  const require = createRequire(import.meta.url);
  const dts = join(
    dirname(require.resolve('@google/gemini-cli-core/package.json')),
    'dist/src/config/config.d.ts'
  );
  const source = readFileSync(dts, 'utf8');
  const match =
    /export declare class MCPServerConfig\b[\s\S]*?\n\s*constructor\(([\s\S]*?)\);/.exec(source);
  if (!match) {
    throw new Error(`Could not find the MCPServerConfig constructor in ${dts}`);
  }

  return splitParams(match[1]).map((param) => {
    const name = /^\s*([A-Za-z_$][\w$]*)\s*\??\s*:/.exec(param)?.[1];
    if (!name) throw new Error(`Could not parse a parameter name from "${param.trim()}"`);
    return name;
  });
}

const REAL_PARAMS = readRealCtorParamOrder();

/** Captures raw positional arguments; nothing is interpreted for us. */
class RecordingConfig {
  readonly args: unknown[];
  constructor(...args: unknown[]) {
    this.args = args;
  }
}

/** The value the builder placed in whichever slot the SDK calls `name`. */
function slot(config: unknown, name: string): unknown {
  const index = REAL_PARAMS.indexOf(name);
  expect(index, `the SDK no longer declares a "${name}" constructor parameter`).toBeGreaterThan(-1);
  return (config as RecordingConfig).args[index];
}

const build = (options: Parameters<typeof buildGeminiMcpServerConfig>[1]) =>
  buildGeminiMcpServerConfig(RecordingConfig as never, options);

describe('buildGeminiMcpServerConfig', () => {
  it('still matches the SDK signature it hardcodes positions against', () => {
    // The builder pads to a fixed arity. If the SDK grew or shrank the
    // constructor, every assertion below is comparing against stale offsets.
    expect(REAL_PARAMS).toContain('excludeTools');
    expect(REAL_PARAMS.indexOf('excludeTools')).toBe(13);
    // The hazard is specifically that this allowlist sits directly before it.
    expect(REAL_PARAMS[REAL_PARAMS.indexOf('excludeTools') - 1]).toBe('includeTools');
  });

  it('lands the deny list in the SDK slot actually named excludeTools', () => {
    const config = build({
      command: 'npx',
      args: ['-y', 'server-github'],
      env: { GITHUB_TOKEN: 'x' },
      cwd: '/branch',
      excludeTools: ['create_pull_request', 'merge_pull_request'],
    });

    expect(slot(config, 'excludeTools')).toEqual(['create_pull_request', 'merge_pull_request']);
  });

  it('never lets the deny list reach includeTools, which would allow everything else', () => {
    const config = build({
      command: 'npx',
      env: {},
      excludeTools: ['delete_repository'],
    });

    // The fail-open case, asserted directly rather than inferred from a
    // neighbouring field being undefined.
    expect(slot(config, 'includeTools')).toBeUndefined();
    expect(slot(config, 'excludeTools')).toEqual(['delete_repository']);
  });

  it('places every transport field in the slot the SDK names', () => {
    const stdio = build({
      command: 'npx',
      args: ['-y', 'server-github'],
      env: { A: '1' },
      cwd: '/branch',
      excludeTools: [],
    });
    expect(slot(stdio, 'command')).toBe('npx');
    expect(slot(stdio, 'args')).toEqual(['-y', 'server-github']);
    expect(slot(stdio, 'env')).toEqual({ A: '1' });
    expect(slot(stdio, 'cwd')).toBe('/branch');

    const http = build({
      env: {},
      httpUrl: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer t' },
      excludeTools: [],
    });
    expect(slot(http, 'httpUrl')).toBe('https://example.com/mcp');
    expect(slot(http, 'headers')).toEqual({ Authorization: 'Bearer t' });
    expect(slot(http, 'url')).toBeUndefined();

    const sse = build({ env: {}, url: 'https://example.com/sse', excludeTools: [] });
    expect(slot(sse, 'url')).toBe('https://example.com/sse');
    expect(slot(sse, 'httpUrl')).toBeUndefined();
  });

  it('leaves every slot Agor never sets empty', () => {
    const config = build({
      command: 'npx',
      env: {},
      cwd: '/branch',
      excludeTools: ['x'],
    });

    // A shifted argument would populate one of these instead of erroring.
    for (const name of ['tcp', 'type', 'timeout', 'trust', 'description', 'includeTools']) {
      expect(slot(config, name), `expected the SDK's "${name}" slot to stay unset`).toBeUndefined();
    }
  });

  it('leaves excludeTools unset when nothing is gated', () => {
    const config = build({ command: 'npx', env: {}, excludeTools: [] });

    expect(slot(config, 'excludeTools')).toBeUndefined();
  });
});
