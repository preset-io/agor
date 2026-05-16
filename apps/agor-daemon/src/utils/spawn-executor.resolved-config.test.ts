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
import { buildResolvedConfigSlice } from './spawn-executor';

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

  it('returns the slice shape even when the config file is absent', () => {
    const slice = buildResolvedConfigSlice() as Record<string, Record<string, unknown>>;
    // All sections present, all values undefined — handlers apply defaults.
    expect(slice).toEqual({
      execution: { permission_timeout_ms: undefined },
      opencode: { serverUrl: undefined },
      daemon: { host_ip_address: undefined },
    });
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
});
