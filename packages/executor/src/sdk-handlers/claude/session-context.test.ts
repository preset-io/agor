import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionID } from '@agor/core/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendSessionContextToCLAUDEmd,
  generateSessionContext,
  removeSessionContextFromCLAUDEmd,
} from './session-context.js';

describe('generateSessionContext', () => {
  it('should generate context with full and short IDs', () => {
    const sessionId = '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f' as SessionID;
    const context = generateSessionContext(sessionId);

    expect(context).toContain(sessionId);
    expect(context).toContain('01933e4a'); // short ID
    expect(context).toContain('## Agor Session Context');
    expect(context).toContain('https://agor.live');
  });

  it('should extract correct 8-char short ID', () => {
    const sessionId = 'abcd1234-5678-7c35-a8f3-9d2e1c4b5a6f' as SessionID;
    const context = generateSessionContext(sessionId);

    expect(context).toContain('abcd1234');
    expect(context).toContain('short: `abcd1234`');
  });

  it('should include markdown formatting', () => {
    const sessionId = '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f' as SessionID;
    const context = generateSessionContext(sessionId);

    expect(context).toContain('---'); // separator
    expect(context).toContain('**'); // bold
    expect(context).toContain('`'); // code blocks
  });

  it('should include SDK session ID when provided', () => {
    const sessionId = '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f' as SessionID;
    const sdkSessionId = 'sdk-abc123-def456';
    const context = generateSessionContext(sessionId, sdkSessionId);

    expect(context).toContain(sessionId); // Agor session ID
    expect(context).toContain(sdkSessionId); // SDK session ID
    expect(context).toContain('Agor Session ID');
    expect(context).toContain('Claude SDK Session ID');
  });

  it('should not include SDK session ID line when not provided', () => {
    const sessionId = '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f' as SessionID;
    const context = generateSessionContext(sessionId);

    expect(context).toContain(sessionId);
    expect(context).not.toContain('Claude SDK Session ID');
  });
});

describe('appendSessionContextToCLAUDEmd', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should create CLAUDE.md if it does not exist', async () => {
    const sessionId = '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f' as SessionID;

    await appendSessionContextToCLAUDEmd(tmpDir, sessionId);

    const claudeMdPath = path.join(tmpDir, 'CLAUDE.md');
    const content = await fs.readFile(claudeMdPath, 'utf-8');

    expect(content).toContain('## Agor Session Context');
    expect(content).toContain(sessionId);
  });

  it('should append to existing CLAUDE.md without replacing', async () => {
    const sessionId = '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f' as SessionID;
    const claudeMdPath = path.join(tmpDir, 'CLAUDE.md');
    const existingContent = '# My Project\n\nThis is important content.';

    await fs.writeFile(claudeMdPath, existingContent);
    await appendSessionContextToCLAUDEmd(tmpDir, sessionId);

    const content = await fs.readFile(claudeMdPath, 'utf-8');

    expect(content).toContain('# My Project');
    expect(content).toContain('This is important content');
    expect(content).toContain('## Agor Session Context');
    expect(content.indexOf('# My Project')).toBeLessThan(
      content.indexOf('## Agor Session Context')
    );
  });

  it('should be idempotent when context already exists', async () => {
    const sessionId = '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f' as SessionID;
    const claudeMdPath = path.join(tmpDir, 'CLAUDE.md');

    // First append
    await appendSessionContextToCLAUDEmd(tmpDir, sessionId);
    const firstContent = await fs.readFile(claudeMdPath, 'utf-8');

    // Second append (should not duplicate)
    await appendSessionContextToCLAUDEmd(tmpDir, sessionId);
    const secondContent = await fs.readFile(claudeMdPath, 'utf-8');

    expect(firstContent).toBe(secondContent);
    expect(secondContent.match(/## Agor Session Context/g)?.length).toBe(1);
  });

  it('should handle different session IDs correctly', async () => {
    const sessionId1 = '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f' as SessionID;
    const sessionId2 = 'abcd1234-5678-7c35-a8f3-9d2e1c4b5a6f' as SessionID;
    const claudeMdPath = path.join(tmpDir, 'CLAUDE.md');

    await appendSessionContextToCLAUDEmd(tmpDir, sessionId1);
    const content1 = await fs.readFile(claudeMdPath, 'utf-8');

    expect(content1).toContain(sessionId1);
    expect(content1).not.toContain(sessionId2);
  });

  it('should not throw on write errors', async () => {
    const sessionId = '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f' as SessionID;
    const invalidPath = '/nonexistent/directory/that/does/not/exist';

    // Should not throw - errors are caught and logged
    await expect(appendSessionContextToCLAUDEmd(invalidPath, sessionId)).resolves.toBeUndefined();
  });
});

describe('removeSessionContextFromCLAUDEmd', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should remove session context from CLAUDE.md', async () => {
    const sessionId = '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f' as SessionID;
    const claudeMdPath = path.join(tmpDir, 'CLAUDE.md');
    const originalContent = '# My Project\n\nOriginal content.';

    await fs.writeFile(claudeMdPath, originalContent);
    await appendSessionContextToCLAUDEmd(tmpDir, sessionId);

    // Verify context was added
    let content = await fs.readFile(claudeMdPath, 'utf-8');
    expect(content).toContain('## Agor Session Context');

    // Remove it
    await removeSessionContextFromCLAUDEmd(tmpDir);

    // Verify context was removed and original preserved
    content = await fs.readFile(claudeMdPath, 'utf-8');
    expect(content).toBe(originalContent);
    expect(content).not.toContain('## Agor Session Context');
  });

  it('should be idempotent when no context exists', async () => {
    const claudeMdPath = path.join(tmpDir, 'CLAUDE.md');
    const content = '# My Project\n\nNo session context here.';

    await fs.writeFile(claudeMdPath, content);
    await removeSessionContextFromCLAUDEmd(tmpDir);

    const resultContent = await fs.readFile(claudeMdPath, 'utf-8');
    expect(resultContent).toBe(content);
  });

  it('should not throw when CLAUDE.md does not exist', async () => {
    await expect(removeSessionContextFromCLAUDEmd(tmpDir)).resolves.toBeUndefined();
  });

  it('should handle CLAUDE.md with only session context', async () => {
    const sessionId = '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f' as SessionID;
    const claudeMdPath = path.join(tmpDir, 'CLAUDE.md');

    // Create file with only session context (no original content)
    const sessionContext = generateSessionContext(sessionId);
    await fs.writeFile(claudeMdPath, sessionContext);

    await removeSessionContextFromCLAUDEmd(tmpDir);

    const content = await fs.readFile(claudeMdPath, 'utf-8');
    expect(content).toBe(''); // Should be empty
  });

  it('should preserve content before session context marker', async () => {
    const claudeMdPath = path.join(tmpDir, 'CLAUDE.md');
    const beforeContent = '# Header\n\nContent before.';
    const afterMarker = '\n\n---\n\n## Agor Session Context\n\nSession info here.';

    await fs.writeFile(claudeMdPath, beforeContent + afterMarker);
    await removeSessionContextFromCLAUDEmd(tmpDir);

    const content = await fs.readFile(claudeMdPath, 'utf-8');
    expect(content).toBe(beforeContent);
  });

  it('should not throw on read/write errors', async () => {
    const invalidPath = '/nonexistent/directory/that/does/not/exist';

    await expect(removeSessionContextFromCLAUDEmd(invalidPath)).resolves.toBeUndefined();
  });
});
