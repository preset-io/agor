import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearEditFilesTurnBaseline,
  clearToolInvocationState,
  enrichContentBlocks,
  enrichToolResults,
  refreshEditFilesTurnBaseline,
  registerEditFilesTurnBaseline,
  registerToolInvocationStart,
  registerToolUses,
} from './diff-enrichment.js';

interface TestContentBlock {
  type: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  diff?: {
    structuredPatch: Array<{
      oldStart: number;
      oldLines: number;
      newStart: number;
      newLines: number;
      lines: string[];
    }>;
    files?: Array<{
      path: string;
      kind: 'add' | 'update' | 'delete';
      structuredPatch: Array<{
        oldStart: number;
        oldLines: number;
        newStart: number;
        newLines: number;
        lines: string[];
      }>;
    }>;
  };
}

const tempDirs: string[] = [];

function createTempGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agor-diff-enrichment-'));
  tempDirs.push(dir);
  execSync('git init', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "Test User"', { cwd: dir, stdio: 'ignore' });
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('diff enrichment', () => {
  it('enriches Codex edit_files updates with relative paths as true updates', () => {
    const repoDir = createTempGitRepo();
    const srcDir = path.join(repoDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    const filePath = path.join(srcDir, 'example.ts');

    fs.writeFileSync(filePath, 'const value = "old";\n', 'utf-8');
    execSync('git add .', { cwd: repoDir, stdio: 'ignore' });
    execSync('git commit -m "initial"', { cwd: repoDir, stdio: 'ignore' });
    registerToolInvocationStart(
      'tool-codex-edit-files-1',
      'edit_files',
      { changes: [{ path: 'src/example.ts', kind: 'update' }] },
      { workingDirectory: repoDir }
    );
    fs.writeFileSync(filePath, 'const value = "new";\n', 'utf-8');

    const contentBlocks: TestContentBlock[] = [
      {
        type: 'tool_use',
        id: 'tool-codex-edit-files-1',
        name: 'edit_files',
        input: {
          changes: [{ path: 'src/example.ts', kind: 'update' }],
        },
      },
      {
        type: 'tool_result',
        tool_use_id: 'tool-codex-edit-files-1',
        content: '[completed]',
      },
    ];

    enrichContentBlocks(contentBlocks, { workingDirectory: repoDir });

    const toolResult = contentBlocks[1];
    expect(toolResult.diff?.files).toHaveLength(1);
    expect(toolResult.diff?.files?.[0]?.path).toBe('src/example.ts');
    expect(toolResult.diff?.files?.[0]?.kind).toBe('update');
    const lines = toolResult.diff?.files?.[0]?.structuredPatch?.[0]?.lines ?? [];
    expect(lines.some((line) => line.includes('-const value = "old";'))).toBe(true);
    expect(lines.some((line) => line.includes('+const value = "new";'))).toBe(true);
  });

  it('enriches absolute edit_files paths when tool path and git root use different symlink prefixes', () => {
    const repoDir = createTempGitRepo();
    const aliasParent = fs.mkdtempSync(path.join(os.tmpdir(), 'agor-diff-enrichment-alias-'));
    tempDirs.push(aliasParent);
    const aliasRepo = path.join(aliasParent, 'repo-link');
    fs.symlinkSync(repoDir, aliasRepo, 'dir');

    const srcDir = path.join(repoDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    const realFilePath = path.join(srcDir, 'example.ts');
    const aliasFilePath = path.join(aliasRepo, 'src', 'example.ts');

    fs.writeFileSync(realFilePath, 'const value = "old";\n', 'utf-8');
    execSync('git add .', { cwd: repoDir, stdio: 'ignore' });
    execSync('git commit -m "initial"', { cwd: repoDir, stdio: 'ignore' });
    registerToolInvocationStart(
      'tool-codex-edit-files-symlink-path-1',
      'edit_files',
      { changes: [{ path: aliasFilePath, kind: 'update' }] },
      { workingDirectory: repoDir }
    );
    fs.writeFileSync(aliasFilePath, 'const value = "new";\n', 'utf-8');

    const contentBlocks: TestContentBlock[] = [
      {
        type: 'tool_use',
        id: 'tool-codex-edit-files-symlink-path-1',
        name: 'edit_files',
        input: {
          changes: [{ path: aliasFilePath, kind: 'update' }],
        },
      },
      {
        type: 'tool_result',
        tool_use_id: 'tool-codex-edit-files-symlink-path-1',
        content: '[completed]',
      },
    ];

    enrichContentBlocks(contentBlocks, { workingDirectory: repoDir });

    const toolResult = contentBlocks[1];
    expect(toolResult.diff?.files).toHaveLength(1);
    expect(toolResult.diff?.files?.[0]?.kind).toBe('update');
    const lines = toolResult.diff?.files?.[0]?.structuredPatch?.[0]?.lines ?? [];
    expect(lines.some((line) => line.includes('-const value = "old";'))).toBe(true);
    expect(lines.some((line) => line.includes('+const value = "new";'))).toBe(true);
  });

  it('enriches Codex edit_files delete operations with relative paths', () => {
    const repoDir = createTempGitRepo();
    const srcDir = path.join(repoDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    const filePath = path.join(srcDir, 'delete-me.ts');

    fs.writeFileSync(filePath, 'const removed = true;\n', 'utf-8');
    execSync('git add .', { cwd: repoDir, stdio: 'ignore' });
    execSync('git commit -m "initial"', { cwd: repoDir, stdio: 'ignore' });
    registerToolInvocationStart(
      'tool-codex-edit-files-delete-1',
      'edit_files',
      { changes: [{ path: 'src/delete-me.ts', kind: 'delete' }] },
      { workingDirectory: repoDir }
    );
    fs.rmSync(filePath);

    const contentBlocks: TestContentBlock[] = [
      {
        type: 'tool_use',
        id: 'tool-codex-edit-files-delete-1',
        name: 'edit_files',
        input: {
          changes: [{ path: 'src/delete-me.ts', kind: 'delete' }],
        },
      },
      {
        type: 'tool_result',
        tool_use_id: 'tool-codex-edit-files-delete-1',
        content: '[completed]',
      },
    ];

    enrichContentBlocks(contentBlocks, { workingDirectory: repoDir });

    const toolResult = contentBlocks[1];
    expect(toolResult.diff?.files).toHaveLength(1);
    expect(toolResult.diff?.files?.[0]?.kind).toBe('delete');
    const lines = toolResult.diff?.files?.[0]?.structuredPatch?.[0]?.lines ?? [];
    expect(lines.some((line) => line.includes('-const removed = true;'))).toBe(true);
  });

  it('does not render dirty untracked edit_files updates as full-file additions without snapshots', () => {
    const repoDir = createTempGitRepo();
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# test\n', 'utf-8');
    execSync('git add .', { cwd: repoDir, stdio: 'ignore' });
    execSync('git commit -m "initial"', { cwd: repoDir, stdio: 'ignore' });

    const dirtyPath = path.join(repoDir, 'src', 'dirty.ts');
    fs.mkdirSync(path.dirname(dirtyPath), { recursive: true });
    fs.writeFileSync(dirtyPath, 'export const value = "pre";\n', 'utf-8');
    fs.writeFileSync(dirtyPath, 'export const value = "post";\n', 'utf-8');

    const contentBlocks: TestContentBlock[] = [
      {
        type: 'tool_use',
        id: 'tool-codex-edit-files-dirty-untracked-1',
        name: 'edit_files',
        input: {
          changes: [{ path: 'src/dirty.ts', kind: 'update' }],
        },
      },
      {
        type: 'tool_result',
        tool_use_id: 'tool-codex-edit-files-dirty-untracked-1',
        content: '[completed]',
      },
    ];

    enrichContentBlocks(contentBlocks, { workingDirectory: repoDir });

    expect(contentBlocks[1].diff).toBeUndefined();
  });

  it('uses the Codex turn baseline when file_change has no start-time paths', async () => {
    const repoDir = createTempGitRepo();
    const filePath = path.join(repoDir, 'src', 'baseline.ts');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'export const value = "before";\n', 'utf-8');
    execSync('git add .', { cwd: repoDir, stdio: 'ignore' });
    execSync('git commit -m "initial"', { cwd: repoDir, stdio: 'ignore' });

    await registerEditFilesTurnBaseline({
      workingDirectory: repoDir,
      snapshotScope: 'turn-baseline',
    });
    fs.writeFileSync(filePath, 'export const value = "after";\n', 'utf-8');

    const contentBlocks: TestContentBlock[] = [
      {
        type: 'tool_use',
        id: 'tool-codex-edit-files-baseline-1',
        name: 'edit_files',
        input: { changes: [{ path: 'src/baseline.ts', kind: 'update' }] },
      },
      {
        type: 'tool_result',
        tool_use_id: 'tool-codex-edit-files-baseline-1',
        content: '[completed]',
      },
    ];

    enrichContentBlocks(contentBlocks, {
      workingDirectory: repoDir,
      snapshotScope: 'turn-baseline',
    });
    clearEditFilesTurnBaseline({ snapshotScope: 'turn-baseline' });

    const fileDiff = contentBlocks[1].diff?.files?.[0];
    expect(fileDiff?.path).toBe('src/baseline.ts');
    expect(fileDiff?.kind).toBe('update');
    const lines = fileDiff?.structuredPatch?.[0]?.lines ?? [];
    expect(lines.some((line) => line.includes('-export const value = "before";'))).toBe(true);
    expect(lines.some((line) => line.includes('+export const value = "after";'))).toBe(true);
  });

  it('preserves the turn baseline when file_change starts after the filesystem mutation', async () => {
    const repoDir = createTempGitRepo();
    const filePath = path.join(repoDir, 'src', 'late-start.ts');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'export const value = "before";\n', 'utf-8');
    execSync('git add .', { cwd: repoDir, stdio: 'ignore' });
    execSync('git commit -m "initial"', { cwd: repoDir, stdio: 'ignore' });

    const context = { workingDirectory: repoDir, snapshotScope: 'turn-late-start' };
    await registerEditFilesTurnBaseline(context);

    // Codex can report item.started after apply_patch has already mutated disk.
    fs.writeFileSync(filePath, 'export const value = "after";\n', 'utf-8');
    registerToolInvocationStart(
      'tool-codex-edit-files-late-start',
      'edit_files',
      { changes: [{ path: filePath, kind: 'update' }] },
      context
    );

    const blocks: TestContentBlock[] = [
      {
        type: 'tool_use',
        id: 'tool-codex-edit-files-late-start',
        name: 'edit_files',
        input: { changes: [{ path: filePath, kind: 'update' }] },
      },
      {
        type: 'tool_result',
        tool_use_id: 'tool-codex-edit-files-late-start',
        content: '[completed]',
      },
    ];

    enrichContentBlocks(blocks, context);
    clearEditFilesTurnBaseline(context);

    const lines = blocks[1].diff?.files?.[0]?.structuredPatch?.[0]?.lines ?? [];
    expect(lines.some((line) => line.includes('-export const value = "before";'))).toBe(true);
    expect(lines.some((line) => line.includes('+export const value = "after";'))).toBe(true);
  });

  it('falls back to the turn baseline independently for each file in a mixed snapshot', async () => {
    const repoDir = createTempGitRepo();
    const firstPath = path.join(repoDir, 'src', 'first.ts');
    const secondPath = path.join(repoDir, 'src', 'second.ts');
    fs.mkdirSync(path.dirname(firstPath), { recursive: true });
    fs.writeFileSync(firstPath, 'export const first = "before";\n', 'utf-8');
    fs.writeFileSync(secondPath, 'export const second = "before";\n', 'utf-8');
    execSync('git add .', { cwd: repoDir, stdio: 'ignore' });
    execSync('git commit -m "initial"', { cwd: repoDir, stdio: 'ignore' });

    const context = { workingDirectory: repoDir, snapshotScope: 'turn-mixed-start' };
    await registerEditFilesTurnBaseline(context);

    // Simulate Codex being between two filesystem mutations when item.started
    // is observed: first.ts is already post-edit, while second.ts is pre-edit.
    fs.writeFileSync(firstPath, 'export const first = "after";\n', 'utf-8');
    const changes = [
      { path: 'src/first.ts', kind: 'update' },
      { path: 'src/second.ts', kind: 'update' },
    ];
    registerToolInvocationStart(
      'tool-codex-edit-files-mixed-start',
      'edit_files',
      { changes },
      context
    );
    fs.writeFileSync(secondPath, 'export const second = "after";\n', 'utf-8');

    const blocks: TestContentBlock[] = [
      {
        type: 'tool_use',
        id: 'tool-codex-edit-files-mixed-start',
        name: 'edit_files',
        input: { changes },
      },
      {
        type: 'tool_result',
        tool_use_id: 'tool-codex-edit-files-mixed-start',
        content: '[completed]',
      },
    ];

    enrichContentBlocks(blocks, context);
    clearEditFilesTurnBaseline(context);

    expect(blocks[1].diff?.files).toHaveLength(2);
    const firstLines =
      blocks[1].diff?.files?.find((file) => file.path === 'src/first.ts')?.structuredPatch?.[0]
        ?.lines ?? [];
    const secondLines =
      blocks[1].diff?.files?.find((file) => file.path === 'src/second.ts')?.structuredPatch?.[0]
        ?.lines ?? [];
    expect(firstLines.some((line) => line.includes('-export const first = "before";'))).toBe(true);
    expect(firstLines.some((line) => line.includes('+export const first = "after";'))).toBe(true);
    expect(secondLines.some((line) => line.includes('-export const second = "before";'))).toBe(
      true
    );
    expect(secondLines.some((line) => line.includes('+export const second = "after";'))).toBe(true);
  });

  it('does not treat files beyond a truncated turn baseline as absent', async () => {
    const repoDir = createTempGitRepo();
    const bulkDir = path.join(repoDir, 'bulk');
    fs.mkdirSync(bulkDir, { recursive: true });
    for (let index = 0; index < 5_000; index += 1) {
      fs.writeFileSync(path.join(bulkDir, `${String(index).padStart(4, '0')}.txt`), '');
    }

    // This sorts after the 5,000 bulk files and is therefore not enumerated in
    // the bounded turn baseline.
    const filePath = path.join(repoDir, 'target.ts');
    fs.writeFileSync(filePath, 'export const value = "before";\n', 'utf-8');
    const context = { workingDirectory: repoDir, snapshotScope: 'turn-truncated-baseline' };
    await registerEditFilesTurnBaseline(context);

    fs.writeFileSync(filePath, 'export const value = "after";\n', 'utf-8');
    registerToolInvocationStart(
      'tool-codex-edit-files-truncated-baseline',
      'edit_files',
      { changes: [{ path: 'target.ts', kind: 'update' }] },
      context
    );

    const blocks: TestContentBlock[] = [
      {
        type: 'tool_use',
        id: 'tool-codex-edit-files-truncated-baseline',
        name: 'edit_files',
        input: { changes: [{ path: 'target.ts', kind: 'update' }] },
      },
      {
        type: 'tool_result',
        tool_use_id: 'tool-codex-edit-files-truncated-baseline',
        content: '[completed]',
      },
    ];

    enrichContentBlocks(blocks, context);
    clearEditFilesTurnBaseline(context);

    expect(blocks[1].diff).toBeUndefined();
  });

  it('keeps rapid late-start edits scoped to the immediately preceding state', async () => {
    const repoDir = createTempGitRepo();
    const filePath = path.join(repoDir, 'src', 'rapid-late-start.ts');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'export const value = "one";\n', 'utf-8');
    execSync('git add .', { cwd: repoDir, stdio: 'ignore' });
    execSync('git commit -m "initial"', { cwd: repoDir, stdio: 'ignore' });

    const context = { workingDirectory: repoDir, snapshotScope: 'turn-rapid-late-start' };
    await registerEditFilesTurnBaseline(context);

    fs.writeFileSync(filePath, 'export const value = "two";\n', 'utf-8');
    registerToolInvocationStart(
      'tool-codex-edit-files-rapid-late-start-1',
      'edit_files',
      { changes: [{ path: 'src/rapid-late-start.ts', kind: 'update' }] },
      context
    );
    const firstBlocks: TestContentBlock[] = [
      {
        type: 'tool_use',
        id: 'tool-codex-edit-files-rapid-late-start-1',
        name: 'edit_files',
        input: { changes: [{ path: 'src/rapid-late-start.ts', kind: 'update' }] },
      },
      {
        type: 'tool_result',
        tool_use_id: 'tool-codex-edit-files-rapid-late-start-1',
        content: '[completed]',
      },
    ];
    enrichContentBlocks(firstBlocks, context);

    fs.writeFileSync(filePath, 'export const value = "three";\n', 'utf-8');
    registerToolInvocationStart(
      'tool-codex-edit-files-rapid-late-start-2',
      'edit_files',
      { changes: [{ path: 'src/rapid-late-start.ts', kind: 'update' }] },
      context
    );
    const secondBlocks: TestContentBlock[] = [
      {
        type: 'tool_use',
        id: 'tool-codex-edit-files-rapid-late-start-2',
        name: 'edit_files',
        input: { changes: [{ path: 'src/rapid-late-start.ts', kind: 'update' }] },
      },
      {
        type: 'tool_result',
        tool_use_id: 'tool-codex-edit-files-rapid-late-start-2',
        content: '[completed]',
      },
    ];
    enrichContentBlocks(secondBlocks, context);
    clearEditFilesTurnBaseline(context);

    const firstLines = firstBlocks[1].diff?.files?.[0]?.structuredPatch?.[0]?.lines ?? [];
    expect(firstLines.some((line) => line.includes('-export const value = "one";'))).toBe(true);
    expect(firstLines.some((line) => line.includes('+export const value = "two";'))).toBe(true);

    const secondLines = secondBlocks[1].diff?.files?.[0]?.structuredPatch?.[0]?.lines ?? [];
    expect(secondLines.some((line) => line.includes('-export const value = "two";'))).toBe(true);
    expect(secondLines.some((line) => line.includes('+export const value = "three";'))).toBe(true);
    expect(secondLines.some((line) => line.includes('"one"'))).toBe(false);
  });

  it('refreshes the Codex turn baseline after each edit_files result', async () => {
    const repoDir = createTempGitRepo();
    const filePath = path.join(repoDir, 'src', 'twice.ts');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'export const value = "one";\n', 'utf-8');
    execSync('git add .', { cwd: repoDir, stdio: 'ignore' });
    execSync('git commit -m "initial"', { cwd: repoDir, stdio: 'ignore' });

    const context = { workingDirectory: repoDir, snapshotScope: 'turn-refresh' };
    await registerEditFilesTurnBaseline(context);

    fs.writeFileSync(filePath, 'export const value = "two";\n', 'utf-8');
    const firstBlocks: TestContentBlock[] = [
      {
        type: 'tool_use',
        id: 'tool-codex-edit-files-refresh-1',
        name: 'edit_files',
        input: { changes: [{ path: 'src/twice.ts', kind: 'update' }] },
      },
      {
        type: 'tool_result',
        tool_use_id: 'tool-codex-edit-files-refresh-1',
        content: '[completed]',
      },
    ];
    enrichContentBlocks(firstBlocks, context);

    fs.writeFileSync(filePath, 'export const value = "three";\n', 'utf-8');
    const secondBlocks: TestContentBlock[] = [
      {
        type: 'tool_use',
        id: 'tool-codex-edit-files-refresh-2',
        name: 'edit_files',
        input: { changes: [{ path: 'src/twice.ts', kind: 'update' }] },
      },
      {
        type: 'tool_result',
        tool_use_id: 'tool-codex-edit-files-refresh-2',
        content: '[completed]',
      },
    ];
    enrichContentBlocks(secondBlocks, context);
    clearEditFilesTurnBaseline(context);

    const firstLines = firstBlocks[1].diff?.files?.[0]?.structuredPatch?.[0]?.lines ?? [];
    expect(firstLines.some((line) => line.includes('-export const value = "one";'))).toBe(true);
    expect(firstLines.some((line) => line.includes('+export const value = "two";'))).toBe(true);

    const secondLines = secondBlocks[1].diff?.files?.[0]?.structuredPatch?.[0]?.lines ?? [];
    expect(secondLines.some((line) => line.includes('-export const value = "two";'))).toBe(true);
    expect(secondLines.some((line) => line.includes('+export const value = "three";'))).toBe(true);
    expect(secondLines.some((line) => line.includes('"one"'))).toBe(false);
  });

  it('refreshes the Codex turn baseline after a non-edit_files tool mutates a file', async () => {
    const repoDir = createTempGitRepo();
    const filePath = path.join(repoDir, 'src', 'after-bash.ts');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'export const value = "one";\n', 'utf-8');
    execSync('git add .', { cwd: repoDir, stdio: 'ignore' });
    execSync('git commit -m "initial"', { cwd: repoDir, stdio: 'ignore' });

    const context = { workingDirectory: repoDir, snapshotScope: 'turn-refresh-after-bash' };
    await registerEditFilesTurnBaseline(context);

    // Simulate a completed Bash/command_execution tool mutating the worktree
    // before a later Codex file_change/edit_files item updates the same file.
    fs.writeFileSync(filePath, 'export const value = "two";\n', 'utf-8');
    await refreshEditFilesTurnBaseline(context);

    fs.writeFileSync(filePath, 'export const value = "three";\n', 'utf-8');
    const blocks: TestContentBlock[] = [
      {
        type: 'tool_use',
        id: 'tool-codex-edit-files-after-bash',
        name: 'edit_files',
        input: { changes: [{ path: 'src/after-bash.ts', kind: 'update' }] },
      },
      {
        type: 'tool_result',
        tool_use_id: 'tool-codex-edit-files-after-bash',
        content: '[completed]',
      },
    ];

    enrichContentBlocks(blocks, context);
    clearEditFilesTurnBaseline(context);

    const lines = blocks[1].diff?.files?.[0]?.structuredPatch?.[0]?.lines ?? [];
    expect(lines.some((line) => line.includes('-export const value = "two";'))).toBe(true);
    expect(lines.some((line) => line.includes('+export const value = "three";'))).toBe(true);
    expect(lines.some((line) => line.includes('"one"'))).toBe(false);
  });

  it('skips tracked symlinks during Codex turn baseline capture', async () => {
    const repoDir = createTempGitRepo();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agor-diff-enrichment-outside-'));
    tempDirs.push(outsideDir);
    const outsideFile = path.join(outsideDir, 'secret.txt');
    const linkPath = path.join(repoDir, 'linked.txt');

    fs.writeFileSync(outsideFile, 'outside-before\n', 'utf-8');
    fs.symlinkSync(outsideFile, linkPath);
    execSync('git add linked.txt', { cwd: repoDir, stdio: 'ignore' });
    execSync('git commit -m "tracked symlink"', { cwd: repoDir, stdio: 'ignore' });

    const context = { workingDirectory: repoDir, snapshotScope: 'turn-symlink' };
    await registerEditFilesTurnBaseline(context);

    fs.writeFileSync(outsideFile, 'outside-after\n', 'utf-8');
    const blocks: TestContentBlock[] = [
      {
        type: 'tool_use',
        id: 'tool-codex-edit-files-symlink',
        name: 'edit_files',
        input: { changes: [{ path: 'linked.txt', kind: 'update' }] },
      },
      {
        type: 'tool_result',
        tool_use_id: 'tool-codex-edit-files-symlink',
        content: '[completed]',
      },
    ];

    enrichContentBlocks(blocks, context);
    clearEditFilesTurnBaseline(context);

    expect(blocks[1].diff).toBeUndefined();
  });

  it('skips binary edit_files snapshots instead of rendering bogus text diffs', () => {
    const repoDir = createTempGitRepo();
    const filePath = path.join(repoDir, 'asset.bin');
    fs.writeFileSync(filePath, Buffer.from([0, 1, 2, 3]));
    execSync('git add .', { cwd: repoDir, stdio: 'ignore' });
    execSync('git commit -m "initial"', { cwd: repoDir, stdio: 'ignore' });

    registerToolInvocationStart(
      'tool-codex-edit-files-binary-1',
      'edit_files',
      { changes: [{ path: 'asset.bin', kind: 'update' }] },
      { workingDirectory: repoDir }
    );
    fs.writeFileSync(filePath, Buffer.from([0, 1, 9, 3]));

    const contentBlocks: TestContentBlock[] = [
      {
        type: 'tool_use',
        id: 'tool-codex-edit-files-binary-1',
        name: 'edit_files',
        input: { changes: [{ path: 'asset.bin', kind: 'update' }] },
      },
      {
        type: 'tool_result',
        tool_use_id: 'tool-codex-edit-files-binary-1',
        content: '[completed]',
      },
    ];

    enrichContentBlocks(contentBlocks, { workingDirectory: repoDir });

    expect(contentBlocks[1].diff).toBeUndefined();
  });

  it('enriches Codex edit_files add operations with relative paths', () => {
    const repoDir = createTempGitRepo();
    const srcDir = path.join(repoDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(path.join(repoDir, 'README.md'), '# test\n', 'utf-8');
    execSync('git add .', { cwd: repoDir, stdio: 'ignore' });
    execSync('git commit -m "initial"', { cwd: repoDir, stdio: 'ignore' });

    const newFilePath = path.join(srcDir, 'added.ts');
    fs.writeFileSync(newFilePath, 'export const added = true;\n', 'utf-8');

    const contentBlocks: TestContentBlock[] = [
      {
        type: 'tool_use',
        id: 'tool-codex-edit-files-add-1',
        name: 'edit_files',
        input: {
          changes: [{ path: 'src/added.ts', kind: 'add' }],
        },
      },
      {
        type: 'tool_result',
        tool_use_id: 'tool-codex-edit-files-add-1',
        content: '[completed]',
      },
    ];

    enrichContentBlocks(contentBlocks, { workingDirectory: repoDir });

    const toolResult = contentBlocks[1];
    expect(toolResult.diff?.files).toHaveLength(1);
    expect(toolResult.diff?.files?.[0]?.kind).toBe('add');
    const lines = toolResult.diff?.files?.[0]?.structuredPatch?.[0]?.lines ?? [];
    expect(lines.some((line) => line.includes('+export const added = true;'))).toBe(true);
  });

  it('skips symlinks in edit_files add fallback when no baseline is available', () => {
    const repoDir = createTempGitRepo();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agor-diff-enrichment-add-outside-'));
    tempDirs.push(outsideDir);
    const outsideFile = path.join(outsideDir, 'secret.txt');
    const linkPath = path.join(repoDir, 'linked-add.txt');

    fs.writeFileSync(path.join(repoDir, 'README.md'), '# test\n', 'utf-8');
    execSync('git add .', { cwd: repoDir, stdio: 'ignore' });
    execSync('git commit -m "initial"', { cwd: repoDir, stdio: 'ignore' });

    fs.writeFileSync(outsideFile, 'outside secret\n', 'utf-8');
    fs.symlinkSync(outsideFile, linkPath);

    const contentBlocks: TestContentBlock[] = [
      {
        type: 'tool_use',
        id: 'tool-codex-edit-files-add-symlink',
        name: 'edit_files',
        input: { changes: [{ path: 'linked-add.txt', kind: 'add' }] },
      },
      {
        type: 'tool_result',
        tool_use_id: 'tool-codex-edit-files-add-symlink',
        content: '[completed]',
      },
    ];

    enrichContentBlocks(contentBlocks, { workingDirectory: repoDir });

    expect(contentBlocks[1].diff).toBeUndefined();
  });

  it('skips binary files in edit_files add fallback when no baseline is available', () => {
    const repoDir = createTempGitRepo();
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# test\n', 'utf-8');
    execSync('git add .', { cwd: repoDir, stdio: 'ignore' });
    execSync('git commit -m "initial"', { cwd: repoDir, stdio: 'ignore' });

    fs.writeFileSync(path.join(repoDir, 'asset.bin'), Buffer.from([1, 2, 0, 3]));

    const contentBlocks: TestContentBlock[] = [
      {
        type: 'tool_use',
        id: 'tool-codex-edit-files-add-binary',
        name: 'edit_files',
        input: { changes: [{ path: 'asset.bin', kind: 'add' }] },
      },
      {
        type: 'tool_result',
        tool_use_id: 'tool-codex-edit-files-add-binary',
        content: '[completed]',
      },
    ];

    enrichContentBlocks(contentBlocks, { workingDirectory: repoDir });

    expect(contentBlocks[1].diff).toBeUndefined();
  });

  it('truncates large edit_files add diffs before storing them', () => {
    const repoDir = createTempGitRepo();
    const srcDir = path.join(repoDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(path.join(repoDir, 'README.md'), '# test\n', 'utf-8');
    execSync('git add .', { cwd: repoDir, stdio: 'ignore' });
    execSync('git commit -m "initial"', { cwd: repoDir, stdio: 'ignore' });

    const newFilePath = path.join(srcDir, 'large.ts');
    const content = Array.from({ length: 250 }, (_, i) => `export const value${i} = ${i};`).join(
      '\n'
    );
    fs.writeFileSync(newFilePath, `${content}\n`, 'utf-8');

    const contentBlocks: TestContentBlock[] = [
      {
        type: 'tool_use',
        id: 'tool-codex-edit-files-large-add-1',
        name: 'edit_files',
        input: {
          changes: [{ path: 'src/large.ts', kind: 'add' }],
        },
      },
      {
        type: 'tool_result',
        tool_use_id: 'tool-codex-edit-files-large-add-1',
        content: '[completed]',
      },
    ];

    enrichContentBlocks(contentBlocks, { workingDirectory: repoDir });

    const lines = contentBlocks[1].diff?.files?.[0]?.structuredPatch?.[0]?.lines ?? [];
    expect(lines).toHaveLength(201);
    expect(lines[0]).toBe('+export const value0 = 0;');
    expect(lines[199]).toBe('+export const value199 = 199;');
    expect(lines[200]).toBe(' [diff output was truncated: showing first 200 of 250 lines]');
  });

  it('uses invocation snapshots so add then remove across calls both render correctly', () => {
    const repoDir = createTempGitRepo();
    const srcDir = path.join(repoDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# test\n', 'utf-8');
    execSync('git add .', { cwd: repoDir, stdio: 'ignore' });
    execSync('git commit -m "initial"', { cwd: repoDir, stdio: 'ignore' });

    const relPath = 'src/toggle.ts';
    const absPath = path.join(repoDir, relPath);

    // Invocation 1: add file
    registerToolInvocationStart(
      'tool-codex-edit-files-toggle-add',
      'edit_files',
      { changes: [{ path: relPath, kind: 'add' }] },
      { workingDirectory: repoDir }
    );
    fs.writeFileSync(absPath, 'export const mode = "on";\n', 'utf-8');
    const addBlocks: TestContentBlock[] = [
      {
        type: 'tool_use',
        id: 'tool-codex-edit-files-toggle-add',
        name: 'edit_files',
        input: { changes: [{ path: relPath, kind: 'add' }] },
      },
      {
        type: 'tool_result',
        tool_use_id: 'tool-codex-edit-files-toggle-add',
        content: '[completed]',
      },
    ];
    enrichContentBlocks(addBlocks, { workingDirectory: repoDir });

    expect(addBlocks[1].diff?.files).toHaveLength(1);
    expect(addBlocks[1].diff?.files?.[0]?.kind).toBe('add');
    const addLines = addBlocks[1].diff?.files?.[0]?.structuredPatch?.[0]?.lines ?? [];
    expect(addLines.some((line) => line.includes('+export const mode = "on";'))).toBe(true);

    // Invocation 2: delete same file (after add already happened)
    registerToolInvocationStart(
      'tool-codex-edit-files-toggle-delete',
      'edit_files',
      { changes: [{ path: relPath, kind: 'delete' }] },
      { workingDirectory: repoDir }
    );
    fs.rmSync(absPath);
    const deleteBlocks: TestContentBlock[] = [
      {
        type: 'tool_use',
        id: 'tool-codex-edit-files-toggle-delete',
        name: 'edit_files',
        input: { changes: [{ path: relPath, kind: 'delete' }] },
      },
      {
        type: 'tool_result',
        tool_use_id: 'tool-codex-edit-files-toggle-delete',
        content: '[completed]',
      },
    ];
    enrichContentBlocks(deleteBlocks, { workingDirectory: repoDir });

    expect(deleteBlocks[1].diff?.files).toHaveLength(1);
    expect(deleteBlocks[1].diff?.files?.[0]?.kind).toBe('delete');
    const deleteLines = deleteBlocks[1].diff?.files?.[0]?.structuredPatch?.[0]?.lines ?? [];
    expect(deleteLines.some((line) => line.includes('-export const mode = "on";'))).toBe(true);
  });

  it('isolates snapshot lookups by scope when tool_use IDs collide', () => {
    const sharedToolUseId = 'tool-collision-id';

    const repoA = createTempGitRepo();
    const fileA = path.join(repoA, 'collision-a.ts');
    fs.writeFileSync(fileA, 'const value = "a-head";\n', 'utf-8');
    execSync('git add .', { cwd: repoA, stdio: 'ignore' });
    execSync('git commit -m "initial"', { cwd: repoA, stdio: 'ignore' });
    fs.writeFileSync(fileA, 'const value = "a-pre";\n', 'utf-8');
    registerToolInvocationStart(
      sharedToolUseId,
      'edit_files',
      { changes: [{ path: 'collision-a.ts', kind: 'update' }] },
      { workingDirectory: repoA, snapshotScope: 'scope-a' }
    );
    fs.writeFileSync(fileA, 'const value = "a-post";\n', 'utf-8');

    const repoB = createTempGitRepo();
    const fileB = path.join(repoB, 'collision-b.ts');
    fs.writeFileSync(fileB, 'const value = "b-head";\n', 'utf-8');
    execSync('git add .', { cwd: repoB, stdio: 'ignore' });
    execSync('git commit -m "initial"', { cwd: repoB, stdio: 'ignore' });
    fs.writeFileSync(fileB, 'const value = "b-pre";\n', 'utf-8');
    registerToolInvocationStart(
      sharedToolUseId,
      'edit_files',
      { changes: [{ path: 'collision-b.ts', kind: 'update' }] },
      { workingDirectory: repoB, snapshotScope: 'scope-b' }
    );
    fs.writeFileSync(fileB, 'const value = "b-post";\n', 'utf-8');

    const blocksA: TestContentBlock[] = [
      {
        type: 'tool_use',
        id: sharedToolUseId,
        name: 'edit_files',
        input: { changes: [{ path: 'collision-a.ts', kind: 'update' }] },
      },
      {
        type: 'tool_result',
        tool_use_id: sharedToolUseId,
        content: '[completed]',
      },
    ];

    enrichContentBlocks(blocksA, { workingDirectory: repoA, snapshotScope: 'scope-a' });

    const linesA = blocksA[1].diff?.files?.[0]?.structuredPatch?.[0]?.lines ?? [];
    expect(linesA.some((line) => line.includes('-const value = "a-pre";'))).toBe(true);
    expect(linesA.some((line) => line.includes('+const value = "a-post";'))).toBe(true);
    expect(linesA.some((line) => line.includes('b-pre'))).toBe(false);

    const blocksB: TestContentBlock[] = [
      {
        type: 'tool_use',
        id: sharedToolUseId,
        name: 'edit_files',
        input: { changes: [{ path: 'collision-b.ts', kind: 'update' }] },
      },
      {
        type: 'tool_result',
        tool_use_id: sharedToolUseId,
        content: '[completed]',
      },
    ];

    enrichContentBlocks(blocksB, { workingDirectory: repoB, snapshotScope: 'scope-b' });

    const linesB = blocksB[1].diff?.files?.[0]?.structuredPatch?.[0]?.lines ?? [];
    expect(linesB.some((line) => line.includes('-const value = "b-pre";'))).toBe(true);
    expect(linesB.some((line) => line.includes('+const value = "b-post";'))).toBe(true);
    expect(linesB.some((line) => line.includes('a-pre'))).toBe(false);
  });

  it('does not synthesize edit_files update diffs from HEAD after snapshot cleanup', () => {
    const repoDir = createTempGitRepo();
    const filePath = path.join(repoDir, 'cleanup.ts');

    fs.writeFileSync(filePath, 'const value = "head";\n', 'utf-8');
    execSync('git add .', { cwd: repoDir, stdio: 'ignore' });
    execSync('git commit -m "initial"', { cwd: repoDir, stdio: 'ignore' });

    // Diverge from HEAD before registering snapshot so snapshot and HEAD differ.
    fs.writeFileSync(filePath, 'const value = "pre";\n', 'utf-8');
    registerToolInvocationStart(
      'tool-codex-edit-files-cleanup',
      'edit_files',
      { changes: [{ path: 'cleanup.ts', kind: 'update' }] },
      { workingDirectory: repoDir, snapshotScope: 'scope-cleanup' }
    );

    fs.writeFileSync(filePath, 'const value = "post";\n', 'utf-8');
    clearToolInvocationState('tool-codex-edit-files-cleanup', { snapshotScope: 'scope-cleanup' });

    const blocks: TestContentBlock[] = [
      {
        type: 'tool_use',
        id: 'tool-codex-edit-files-cleanup',
        name: 'edit_files',
        input: { changes: [{ path: 'cleanup.ts', kind: 'update' }] },
      },
      {
        type: 'tool_result',
        tool_use_id: 'tool-codex-edit-files-cleanup',
        content: '[completed]',
      },
    ];

    enrichContentBlocks(blocks, { workingDirectory: repoDir, snapshotScope: 'scope-cleanup' });

    expect(blocks[1].diff).toBeUndefined();
  });

  it('skips unsafe relative paths when rendering add fallbacks', () => {
    const repoDir = createTempGitRepo();
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# test\n', 'utf-8');
    execSync('git add .', { cwd: repoDir, stdio: 'ignore' });
    execSync('git commit -m "initial"', { cwd: repoDir, stdio: 'ignore' });

    const outsidePath = path.join(path.dirname(repoDir), 'outside.ts');
    fs.writeFileSync(outsidePath, 'export const outside = true;\n', 'utf-8');

    const contentBlocks: TestContentBlock[] = [
      {
        type: 'tool_use',
        id: 'tool-codex-edit-files-unsafe-1',
        name: 'edit_files',
        input: {
          changes: [{ path: '../outside.ts', kind: 'add' }],
        },
      },
      {
        type: 'tool_result',
        tool_use_id: 'tool-codex-edit-files-unsafe-1',
        content: '[completed]',
      },
    ];

    enrichContentBlocks(contentBlocks, { workingDirectory: repoDir });

    // Path resolves outside repo and should be ignored without enriching diff.
    expect(contentBlocks[1].diff).toBeUndefined();
  });

  it('preserves Claude split-message Edit enrichment behavior', () => {
    const repoDir = createTempGitRepo();
    const filePath = path.join(repoDir, 'claude-edit.txt');

    // File is already in post-edit state when tool_result is enriched.
    fs.writeFileSync(filePath, 'bar\n', 'utf-8');

    registerToolUses([
      {
        id: 'tool-claude-edit-1',
        name: 'Edit',
        input: {
          file_path: filePath,
          old_string: 'foo\n',
          new_string: 'bar\n',
        },
      },
    ]);

    const contentBlocks: TestContentBlock[] = [
      {
        type: 'tool_result',
        tool_use_id: 'tool-claude-edit-1',
        content: 'success',
      },
    ];

    enrichToolResults(contentBlocks);

    const lines = contentBlocks[0].diff?.structuredPatch?.[0]?.lines ?? [];
    expect(lines.some((line) => line.includes('-foo'))).toBe(true);
    expect(lines.some((line) => line.includes('+bar'))).toBe(true);
  });
});
