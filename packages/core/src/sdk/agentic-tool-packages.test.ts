import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../..', import.meta.url));
let fixture: string;

// Exercise the real CI gate against small fictional package manifests, without
// mutating the worktree or importing any vendor SDK/native runtime.
beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'agor-sdk-alignment-'));
  const write = (path: string, value: unknown) => {
    const target = join(fixture, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
  };
  write('packages/agor-live/package.json', { name: 'agor-live', version: '1.0.0' });
  write('apps/agor-cli/package.json', { name: '@agor/cli', private: true, version: '1.0.0' });
  const vendors = {
    claude: '@anthropic-ai/claude-agent-sdk',
    codex: '@openai/codex-sdk',
    gemini: '@google/gemini-cli-core',
    copilot: '@github/copilot-sdk',
    cursor: '@cursor/sdk',
    opencode: '@opencode-ai/sdk',
  };
  for (const [id, vendor] of Object.entries(vendors)) {
    write(`packages/agor-${id}/package.json`, {
      name: `@agor-live/${id}`,
      version: '1.0.0',
      dependencies: { [vendor]: '1.2.3', ...(id === 'opencode' ? { 'opencode-ai': '1.2.3' } : {}) },
    });
    write(`packages/agor-${id}/src/index.ts`, "export const AGOR_INTEGRATION_VERSION = '1.0.0';");
  }
  write('packages/core/package.json', {
    name: '@agor/core',
    private: true,
    devDependencies: {
      '@anthropic-ai/claude-agent-sdk': '1.2.3',
      '@openai/codex-sdk': '1.2.3',
      '@google/gemini-cli-core': '1.2.3',
    },
  });
  write('packages/core/src/sdk/index.ts', '');
  write(
    'packages/executor/src/sdk-watchdog.ts',
    "['@anthropic-ai/claude-agent-sdk@1.2.3', '@openai/codex-sdk@1.2.3', '@google/gemini-cli-core@1.2.3']"
  );
  write('packages/agentic-tool-opencode/package.json', {
    name: '@agor/agentic-tool-opencode',
    private: true,
    devDependencies: { '@opencode-ai/sdk': '1.2.3' },
  });
  write(
    'packages/agentic-tool-opencode/src/shared/known-models.ts',
    "export const OPENCODE_VERSION = '1.2.3';"
  );
  write(
    'packages/agentic-tool-opencode/src/shared/index.ts',
    "({ sdkVersion: '@opencode-ai/sdk@1.2.3' });"
  );
  write('docker/Dockerfile', 'RUN npm install -g opencode-ai@1.2.3');
  mkdirSync(join(fixture, 'scripts'));
  cpSync(
    join(root, 'scripts/check-agentic-tool-packages.mjs'),
    join(fixture, 'scripts/check-agentic-tool-packages.mjs')
  );
});

afterEach(() => rmSync(fixture, { recursive: true, force: true }));

function check() {
  return spawnSync(process.execPath, [join(fixture, 'scripts/check-agentic-tool-packages.mjs')], {
    encoding: 'utf8',
  });
}

describe('agent SDK package alignment gate', () => {
  it('accepts aligned runtime, source types, and telemetry pins', () => {
    const result = check();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it.each(['@anthropic-ai/claude-agent-sdk', '@openai/codex-sdk', '@google/gemini-cli-core'])(
    'rejects a source-only %s version newer than the runtime',
    (vendor) => {
      const path = join(fixture, 'packages/core/package.json');
      const pkg = JSON.parse(readFileSync(path, 'utf8'));
      pkg.devDependencies[vendor] = '1.2.4';
      writeFileSync(path, JSON.stringify(pkg));
      const result = check();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${vendor} is 1.2.4, expected runtime pin 1.2.3`);
    }
  );

  it('rejects stale SDK watchdog metadata', () => {
    writeFileSync(join(fixture, 'packages/executor/src/sdk-watchdog.ts'), '');
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('SDK watchdog version drift');
  });

  it('rejects an OpenCode SDK-only upgrade with an older binary', () => {
    const path = join(fixture, 'packages/agor-opencode/package.json');
    const pkg = JSON.parse(readFileSync(path, 'utf8'));
    pkg.dependencies['@opencode-ai/sdk'] = '1.2.4';
    writeFileSync(path, JSON.stringify(pkg));
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('OpenCode version drift: wrapper @opencode-ai/sdk is 1.2.4');
  });
});
