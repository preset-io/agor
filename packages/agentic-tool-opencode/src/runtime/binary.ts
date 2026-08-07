import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { OPENCODE_VERSION } from '../shared/known-models.js';

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve the user-installed OpenCode CLI without assuming how it was installed. */
export async function resolvePackagedOpenCodeBinary(): Promise<string> {
  const configured = process.env.AGOR_OPENCODE_PATH?.trim();
  if (configured) {
    if (await isExecutable(configured)) return configured;
    throw new Error(`AGOR_OPENCODE_PATH is not executable: ${configured}`);
  }

  const names = process.platform === 'win32' ? ['opencode.exe', 'opencode.cmd'] : ['opencode'];
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(directory, name);
      if (await isExecutable(candidate)) return candidate;
    }
  }

  throw new Error(
    `OpenCode ${OPENCODE_VERSION} is not available to the Agor executor. ` +
      'Install the OpenCode CLI using its official instructions, ensure `opencode` is on the daemon PATH, ' +
      'or set AGOR_OPENCODE_PATH. See https://agor.live/guide/extended-install#agentic-tools'
  );
}
