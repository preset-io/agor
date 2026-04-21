import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionID } from '../../types.js';

export interface CodexSessionHomePaths {
  sessionCodexHome: string;
  stableCodexHome: string;
}

interface SessionHomePathOptions {
  tmpBaseDir?: string;
  fallbackBaseDir?: string;
}

interface MaterializeCodexSessionHomeParams extends SessionHomePathOptions {
  sessionId: SessionID | string;
  agorSystemPrompt: string;
  stableCodexHome: string;
}

function getCodexSessionDirName(sessionId: SessionID | string): string {
  return `agor-codex-${sessionId}`;
}

function getCodexSessionHomeCandidates(
  sessionId: SessionID | string,
  options: SessionHomePathOptions = {}
): string[] {
  const sessionDirName = getCodexSessionDirName(sessionId);
  const fallbackBaseDir = options.fallbackBaseDir ?? path.join(os.homedir(), '.agor', 'tmp');

  return [
    path.join(options.tmpBaseDir ?? os.tmpdir(), sessionDirName),
    path.join(fallbackBaseDir, sessionDirName),
  ];
}

async function ensureSessionOverlayDirectory(
  sessionId: SessionID | string,
  options: SessionHomePathOptions = {}
): Promise<string> {
  const [primaryPath, fallbackPath] = getCodexSessionHomeCandidates(sessionId, options);

  try {
    await fs.mkdir(primaryPath, { recursive: true, mode: 0o700 });
    return primaryPath;
  } catch (mkdirError) {
    console.warn(
      `⚠️  [Codex] Failed to create CODEX_HOME in ${path.dirname(primaryPath)} (${(mkdirError as Error).message}), falling back to ${path.dirname(fallbackPath)}`
    );
    await fs.mkdir(fallbackPath, { recursive: true, mode: 0o700 });
    return fallbackPath;
  }
}

async function syncStableAuthArtifact(
  stableCodexHome: string,
  sessionCodexHome: string
): Promise<void> {
  const stableAuthPath = path.join(stableCodexHome, 'auth.json');
  const sessionAuthPath = path.join(sessionCodexHome, 'auth.json');

  await fs.rm(sessionAuthPath, { force: true });

  try {
    await fs.access(stableAuthPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    return;
  }

  await fs.symlink(stableAuthPath, sessionAuthPath);
}

export async function materializeCodexSessionHome(
  params: MaterializeCodexSessionHomeParams
): Promise<CodexSessionHomePaths> {
  const sessionCodexHome = await ensureSessionOverlayDirectory(params.sessionId, params);

  await fs.writeFile(path.join(sessionCodexHome, 'AGENTS.md'), params.agorSystemPrompt, {
    encoding: 'utf-8',
    mode: 0o600,
  });

  await syncStableAuthArtifact(params.stableCodexHome, sessionCodexHome);

  return {
    sessionCodexHome,
    stableCodexHome: params.stableCodexHome,
  };
}

export async function cleanupCodexSessionHome(
  sessionId: SessionID | string,
  options: SessionHomePathOptions = {}
): Promise<void> {
  const possiblePaths = getCodexSessionHomeCandidates(sessionId, options);

  for (const sessionCodexHome of possiblePaths) {
    try {
      await fs.rm(sessionCodexHome, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`⚠️  Failed to remove CODEX_HOME at ${sessionCodexHome}:`, error);
      }
    }
  }
}
