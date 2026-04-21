import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupCodexSessionHome, materializeCodexSessionHome } from './session-home.js';

describe('materializeCodexSessionHome', () => {
  let tempDir: string;
  let stableCodexHome: string;
  let tmpBaseDir: string;
  let fallbackBaseDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-codex-home-'));
    stableCodexHome = path.join(tempDir, 'stable');
    tmpBaseDir = path.join(tempDir, 'tmp');
    fallbackBaseDir = path.join(tempDir, 'fallback');

    await fs.mkdir(stableCodexHome, { recursive: true });
    await fs.mkdir(tmpBaseDir, { recursive: true });
    await fs.mkdir(fallbackBaseDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('creates a session overlay, writes AGENTS.md, and links auth.json from the stable base', async () => {
    const authPath = path.join(stableCodexHome, 'auth.json');
    await fs.writeFile(authPath, '{"token":"test"}', 'utf-8');

    const result = await materializeCodexSessionHome({
      sessionId: 'session-123',
      agorSystemPrompt: '# session prompt',
      stableCodexHome,
      tmpBaseDir,
      fallbackBaseDir,
    });

    expect(result.stableCodexHome).toBe(stableCodexHome);
    expect(result.sessionCodexHome).toBe(path.join(tmpBaseDir, 'agor-codex-session-123'));
    expect(await fs.readFile(path.join(result.sessionCodexHome, 'AGENTS.md'), 'utf-8')).toBe(
      '# session prompt'
    );

    const linkedAuthPath = path.join(result.sessionCodexHome, 'auth.json');
    const stats = await fs.lstat(linkedAuthPath);
    expect(stats.isSymbolicLink()).toBe(true);
    expect(await fs.readlink(linkedAuthPath)).toBe(authPath);
  });

  it('creates the overlay even when the stable base has no auth.json', async () => {
    const result = await materializeCodexSessionHome({
      sessionId: 'session-456',
      agorSystemPrompt: '# session prompt',
      stableCodexHome,
      tmpBaseDir,
      fallbackBaseDir,
    });

    await expect(
      fs.access(path.join(result.sessionCodexHome, 'AGENTS.md'))
    ).resolves.toBeUndefined();
    await expect(fs.access(path.join(result.sessionCodexHome, 'auth.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('sanitizes session ids before deriving overlay paths', async () => {
    const result = await materializeCodexSessionHome({
      sessionId: '../session/../with\\\\slashes',
      agorSystemPrompt: '# session prompt',
      stableCodexHome,
      tmpBaseDir,
      fallbackBaseDir,
    });

    expect(result.sessionCodexHome).toBe(
      path.join(tmpBaseDir, 'agor-codex-_-session-_-with-slashes')
    );
  });

  it('replaces a pre-existing auth.json directory with the stable auth symlink', async () => {
    const authPath = path.join(stableCodexHome, 'auth.json');
    await fs.writeFile(authPath, '{"token":"test"}', 'utf-8');

    const existingSessionHome = path.join(tmpBaseDir, 'agor-codex-session-dir-auth');
    await fs.mkdir(path.join(existingSessionHome, 'auth.json'), { recursive: true });

    const result = await materializeCodexSessionHome({
      sessionId: 'session-dir-auth',
      agorSystemPrompt: '# session prompt',
      stableCodexHome,
      tmpBaseDir,
      fallbackBaseDir,
    });

    const linkedAuthPath = path.join(result.sessionCodexHome, 'auth.json');
    const stats = await fs.lstat(linkedAuthPath);
    expect(stats.isSymbolicLink()).toBe(true);
    expect(await fs.readlink(linkedAuthPath)).toBe(authPath);
  });

  it('links auth.json from a per-user stable Codex home', async () => {
    const userStableCodexHome = path.join(tempDir, '.agor', 'codex', 'users', 'user-123');
    await fs.mkdir(userStableCodexHome, { recursive: true });
    const authPath = path.join(userStableCodexHome, 'auth.json');
    await fs.writeFile(authPath, '{"token":"user-123"}', 'utf-8');

    const result = await materializeCodexSessionHome({
      sessionId: 'session-user-home',
      agorSystemPrompt: '# session prompt',
      stableCodexHome: userStableCodexHome,
      tmpBaseDir,
      fallbackBaseDir,
    });

    const linkedAuthPath = path.join(result.sessionCodexHome, 'auth.json');
    const stats = await fs.lstat(linkedAuthPath);
    expect(stats.isSymbolicLink()).toBe(true);
    expect(await fs.readlink(linkedAuthPath)).toBe(authPath);
  });
});

describe('cleanupCodexSessionHome', () => {
  let tempDir: string;
  let stableCodexHome: string;
  let tmpBaseDir: string;
  let fallbackBaseDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-codex-home-cleanup-'));
    stableCodexHome = path.join(tempDir, 'stable');
    tmpBaseDir = path.join(tempDir, 'tmp');
    fallbackBaseDir = path.join(tempDir, 'fallback');

    await fs.mkdir(stableCodexHome, { recursive: true });
    await fs.mkdir(tmpBaseDir, { recursive: true });
    await fs.mkdir(fallbackBaseDir, { recursive: true });
    await fs.writeFile(path.join(stableCodexHome, 'auth.json'), '{"token":"test"}', 'utf-8');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('removes the session overlay without touching the stable base', async () => {
    const { sessionCodexHome } = await materializeCodexSessionHome({
      sessionId: 'session-cleanup',
      agorSystemPrompt: '# session prompt',
      stableCodexHome,
      tmpBaseDir,
      fallbackBaseDir,
    });

    await cleanupCodexSessionHome('session-cleanup', {
      tmpBaseDir,
      fallbackBaseDir,
    });

    await expect(fs.access(sessionCodexHome)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(path.join(stableCodexHome, 'auth.json'))).resolves.toBeUndefined();
  });
});
