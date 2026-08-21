import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10_000;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function syncDirectory(dir: string): Promise<void> {
  try {
    const handle = await open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Some platforms/filesystems cannot fsync directories. The file itself is
    // still fsynced before rename; Linux production paths exercise this arm.
  }
}

async function atomicWrite(target: string, content: string, mode: number): Promise<void> {
  const dir = join(target, '..');
  const temporary = join(dir, `.${target.split('/').at(-1)}.${randomBytes(6).toString('hex')}`);
  const handle = await open(temporary, 'wx', mode);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, target);
    await syncDirectory(dir);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function acquireLock(lockDir: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await mkdir(lockDir, { mode: 0o700 });
      return async () => rm(lockDir, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - (await stat(lockDir)).mtimeMs > LOCK_STALE_MS) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) throw new Error('Credential mutation lock timed out');
      await sleep(25);
    }
  }
}

async function currentGeneration(path: string): Promise<number> {
  try {
    const value = Number.parseInt(await readFile(path, 'utf8'), 10);
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

/**
 * Filesystem-side generation fence for delayed external executor commands.
 * The generation tombstone is persisted before the auth mutation: a crash may
 * leave an ambiguous newest operation, but an older command can never restore
 * stale credentials afterward.
 */
export async function mutateCredentialFile(options: {
  target: string;
  content?: string;
  generation?: number;
}): Promise<'applied' | 'stale'> {
  const dir = join(options.target, '..');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);

  if (options.generation === undefined) {
    if (options.content === undefined) await rm(options.target, { force: true });
    else await atomicWrite(options.target, options.content, 0o600);
    return 'applied';
  }
  if (!Number.isSafeInteger(options.generation) || options.generation <= 0) {
    throw new Error('Credential mutation generation is invalid');
  }

  const release = await acquireLock(join(dir, '.agor-auth-mutation.lock'));
  try {
    const generationPath = join(dir, '.agor-auth-generation');
    if (options.generation < (await currentGeneration(generationPath))) return 'stale';
    await atomicWrite(generationPath, `${options.generation}\n`, 0o600);
    if (options.content === undefined) {
      await rm(options.target, { force: true });
      await syncDirectory(dir);
    } else {
      await atomicWrite(options.target, options.content, 0o600);
    }
    return 'applied';
  } finally {
    await release();
  }
}
