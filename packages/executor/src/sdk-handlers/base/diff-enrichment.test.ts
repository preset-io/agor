import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearToolInvocationState,
  enrichContentBlocks,
  enrichToolResults,
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

  it('falls back to git HEAD diff after explicit snapshot cleanup', () => {
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

    const lines = blocks[1].diff?.files?.[0]?.structuredPatch?.[0]?.lines ?? [];
    expect(lines.some((line) => line.includes('-const value = "head";'))).toBe(true);
    expect(lines.some((line) => line.includes('+const value = "post";'))).toBe(true);
    expect(lines.some((line) => line.includes('-const value = "pre";'))).toBe(false);
  });

  it('skips unsafe relative paths when resolving git HEAD content', () => {
    const repoDir = createTempGitRepo();
    const srcDir = path.join(repoDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    const filePath = path.join(srcDir, 'safe.ts');

    fs.writeFileSync(filePath, 'const value = 1;\n', 'utf-8');
    execSync('git add .', { cwd: repoDir, stdio: 'ignore' });
    execSync('git commit -m "initial"', { cwd: repoDir, stdio: 'ignore' });
    fs.writeFileSync(filePath, 'const value = 2;\n', 'utf-8');

    const contentBlocks: TestContentBlock[] = [
      {
        type: 'tool_use',
        id: 'tool-codex-edit-files-unsafe-1',
        name: 'edit_files',
        input: {
          changes: [{ path: '../outside.ts', kind: 'update' }],
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
