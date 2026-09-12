import { cp, lstat, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';

/** Only provider transcript JSONL files are durable; never auth, settings or machine caches. */
export async function copyClaudeTranscripts(source: string, destination: string): Promise<void> {
  const walk = async (dir: string, relative: string) => {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      if (item.isSymbolicLink()) throw new Error('SDK transcript symlink refused');
      const next = path.join(relative, item.name);
      if (item.isDirectory()) await walk(path.join(dir, item.name), next);
      else if (item.isFile() && item.name.endsWith('.jsonl')) {
        const target = path.join(destination, 'projects', next);
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await cp(path.join(dir, item.name), target, { errorOnExist: true, force: false });
      }
    }
  };
  try {
    await walk(path.join(source, 'projects'), '');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** Import only the authorized provider session and its subagent transcript folder. */
export async function importClaudeSession(
  source: string,
  destination: string,
  sessionId: string
): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error('Invalid Claude session id');
  const projects = path.join(source, 'projects');
  const matches: string[] = [];
  for (const project of await readdir(projects, { withFileTypes: true })) {
    if (!project.isDirectory() || project.isSymbolicLink()) continue;
    const candidate = path.join(projects, project.name, `${sessionId}.jsonl`);
    try {
      const stat = await lstat(candidate);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid transcript entry');
      matches.push(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (matches.length !== 1)
    throw new Error('Authorized Claude transcript missing or ambiguous; resume refused');
  const target = path.join(destination, 'projects', '-workspace');
  await mkdir(target, { recursive: true, mode: 0o700 });
  await cp(matches[0], path.join(target, `${sessionId}.jsonl`), {
    errorOnExist: true,
    force: false,
  });
  const subagents = path.join(path.dirname(matches[0]), sessionId);
  try {
    const stat = await lstat(subagents);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error('Invalid subagent transcript folder');
    const walk = async (src: string, dst: string): Promise<void> => {
      for (const entry of await readdir(src, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error('Transcript symlink refused');
        if (entry.isDirectory()) {
          await mkdir(path.join(dst, entry.name), { recursive: true });
          await walk(path.join(src, entry.name), path.join(dst, entry.name));
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          await mkdir(dst, { recursive: true });
          await cp(path.join(src, entry.name), path.join(dst, entry.name));
        }
      }
    };
    await walk(subagents, path.join(target, sessionId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
