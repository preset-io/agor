/**
 * Tests for the daemon-resolved config slice that ships in executor payloads.
 *
 * Pairs with H1 in context/explorations/daemon-fs-decoupling.md §1.5.
 * The contract: the daemon resolves only a small subset of AgorConfig and
 * embeds it in the payload; the executor never reads ~/.agor/config.yaml
 * itself. These tests pin the slice shape and the fields it covers.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { __resetConfigCacheForTests } from '@agor/core/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildResolvedConfigSlice, withResolvedConfig } from './build-resolved-config-slice';

describe('buildResolvedConfigSlice', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-rcs-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
    __resetConfigCacheForTests();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    __resetConfigCacheForTests();
  });

  /**
   * Write a hand-crafted YAML config so we don't pull js-yaml as a daemon
   * test dependency. Inputs are kept simple (scalars only) to make this
   * safe.
   */
  async function writeConfigYaml(yamlBody: string): Promise<void> {
    const agorDir = path.join(tempDir, '.agor');
    await fs.mkdir(agorDir, { recursive: true });
    await fs.writeFile(path.join(agorDir, 'config.yaml'), yamlBody, 'utf-8');
  }

  it('surfaces permission_timeout_ms from execution.*', async () => {
    await writeConfigYaml('execution:\n  permission_timeout_ms: 1234\n');
    const slice = buildResolvedConfigSlice();
    expect(slice).toMatchObject({
      execution: { permission_timeout_ms: 1234 },
    });
  });

  it('surfaces opencode.serverUrl', async () => {
    await writeConfigYaml('opencode:\n  serverUrl: http://opencode.internal:4096\n');
    const slice = buildResolvedConfigSlice();
    expect(slice).toMatchObject({
      opencode: { serverUrl: 'http://opencode.internal:4096' },
    });
  });

  it('surfaces daemon.host_ip_address', async () => {
    await writeConfigYaml('daemon:\n  host_ip_address: 10.0.0.5\n');
    const slice = buildResolvedConfigSlice();
    expect(slice).toMatchObject({
      daemon: { host_ip_address: '10.0.0.5' },
    });
  });

  it('returns an empty slice when no relevant fields are configured', () => {
    // No config file → no fields surface. Sections are omitted entirely
    // rather than set to objects with undefined values, so the in-memory
    // shape matches what survives JSON serialization to the executor.
    const slice = buildResolvedConfigSlice();
    expect(slice).toEqual({});
  });

  it('returns the same shape before and after JSON round-trip (wire fidelity)', async () => {
    await writeConfigYaml(
      [
        'execution:',
        '  permission_timeout_ms: 60000',
        'opencode:',
        '  serverUrl: http://opencode.internal:4096',
        'daemon:',
        '  host_ip_address: 10.0.0.5',
        '',
      ].join('\n')
    );
    const slice = buildResolvedConfigSlice();
    // The slice is shipped to the executor as JSON via stdin; this asserts
    // the in-memory shape and the wire shape are identical so tests on
    // either side stay honest.
    expect(JSON.parse(JSON.stringify(slice))).toEqual(slice);
  });

  it('does not leak unrelated config sections into the slice', async () => {
    await writeConfigYaml(
      [
        'execution:',
        '  permission_timeout_ms: 60000',
        '  unix_user_mode: strict',
        'daemon:',
        '  host_ip_address: 10.0.0.5',
        '  port: 4040',
        '  base_url: https://example.com',
        'credentials:',
        '  ANTHROPIC_API_KEY: sk-should-not-appear',
        'security:',
        '  csp:',
        '    extras:',
        '      - x',
        '',
      ].join('\n')
    );
    const slice = buildResolvedConfigSlice() as Record<string, Record<string, unknown>>;
    // Allowed fields surface.
    expect(slice.execution?.permission_timeout_ms).toBe(60_000);
    expect(slice.daemon?.host_ip_address).toBe('10.0.0.5');
    // Non-allowed top-level sections are absent — slice is a strict subset.
    expect(slice).not.toHaveProperty('credentials');
    expect(slice).not.toHaveProperty('security');
    // Non-allowed fields within an allowed section are also absent.
    expect(slice.execution).not.toHaveProperty('unix_user_mode');
    expect(slice.daemon).not.toHaveProperty('port');
    expect(slice.daemon).not.toHaveProperty('base_url');
  });

  it('survives the executor-side payload schema as-is', async () => {
    const { ResolvedConfigSliceSchema } = await import('@agor/core/config');
    await writeConfigYaml(
      [
        'execution:',
        '  permission_timeout_ms: 60000',
        'opencode:',
        '  serverUrl: http://opencode.internal:4096',
        'daemon:',
        '  host_ip_address: 10.0.0.5',
        '',
      ].join('\n')
    );
    const slice = buildResolvedConfigSlice();
    const parsed = ResolvedConfigSliceSchema.parse(slice);
    expect(parsed).toEqual(slice);
  });

  it('schema tolerates unknown fields (forward compat for version skew)', async () => {
    // Templated / remote executor mode means the daemon and executor can
    // run from different image versions. A newer daemon that adds a new
    // field to ResolvedConfigSlice must NOT crash an older executor that
    // doesn't know about it — strict() at the schema level would do
    // exactly that. This test pins the looseness.
    const { ResolvedConfigSliceSchema } = await import('@agor/core/config');
    const fromNewerDaemon = {
      execution: {
        permission_timeout_ms: 60_000,
        // hypothetical field added by a newer daemon image:
        future_field_unknown_to_executor: 'whatever',
      },
      // hypothetical brand-new top-level section:
      future_section: { anything: true },
    };
    expect(() => ResolvedConfigSliceSchema.parse(fromNewerDaemon)).not.toThrow();
  });
});

describe('withResolvedConfig', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-with-rc-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
    __resetConfigCacheForTests();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    __resetConfigCacheForTests();
  });

  it('injects a daemon-resolved slice when the payload has no resolvedConfig', () => {
    const before = { command: 'prompt' as const };
    const after = withResolvedConfig(before);
    expect(after).not.toBe(before);
    expect(after).toHaveProperty('resolvedConfig');
  });

  it('injects a daemon-resolved slice when resolvedConfig is explicitly undefined', () => {
    // Regression: `'resolvedConfig' in payload` used to gate this, which
    // is true for `{ resolvedConfig: undefined }` — the payload would
    // skip injection, JSON.stringify would then drop the undefined, and
    // the executor would receive nothing. The contract is "no slice yet"
    // not "key absent", so an undefined value must trigger injection too.
    const before = { command: 'prompt' as const, resolvedConfig: undefined };
    const after = withResolvedConfig(before);
    expect(after.resolvedConfig).toBeDefined();
  });

  it('preserves an existing resolvedConfig untouched', () => {
    const original = {
      command: 'prompt' as const,
      resolvedConfig: { execution: { permission_timeout_ms: 123_456 } },
    };
    const after = withResolvedConfig(original);
    expect(after).toBe(original);
    expect(after.resolvedConfig).toEqual({ execution: { permission_timeout_ms: 123_456 } });
  });
});
