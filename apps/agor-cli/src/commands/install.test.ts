import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateInteractiveAgenticToolSelection } from '../lib/agentic-tool-integrations.js';
import { resolveInstallSelectionPolicy } from './install.js';

const originalRoot = process.env.AGOR_AGENTIC_TOOLS_DIR;
let root: string | undefined;

afterEach(async () => {
  if (originalRoot === undefined) delete process.env.AGOR_AGENTIC_TOOLS_DIR;
  else process.env.AGOR_AGENTIC_TOOLS_DIR = originalRoot;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe('install selection recovery', () => {
  it('requires at least one tool in the interactive selector', () => {
    expect(validateInteractiveAgenticToolSelection([])).toContain('Select at least one');
    expect(validateInteractiveAgenticToolSelection(['codex'])).toBe(true);
  });

  it('lets interactive install replace a malformed local manifest', async () => {
    root = await mkdtemp(join(tmpdir(), 'agor-install-policy-'));
    process.env.AGOR_AGENTIC_TOOLS_DIR = root;
    await writeFile(join(root, 'selection.json'), '{invalid-json');

    await expect(resolveInstallSelectionPolicy({}, false)).resolves.toEqual({
      mode: 'local-managed',
      selected: [],
      source: 'missing-manifest',
    });
  });

  it('keeps sync mode fail-closed for a malformed local manifest', async () => {
    root = await mkdtemp(join(tmpdir(), 'agor-install-policy-'));
    process.env.AGOR_AGENTIC_TOOLS_DIR = root;
    await writeFile(join(root, 'selection.json'), '{invalid-json');

    await expect(resolveInstallSelectionPolicy({}, true)).rejects.toThrow(
      'selection manifest is invalid or unreadable'
    );
  });
});
