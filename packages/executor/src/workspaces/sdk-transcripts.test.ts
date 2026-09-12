import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { copyClaudeTranscripts } from './sdk-transcripts';

it('persists only transcripts and rejects symlinks', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sdk-state-'));
  try {
    const source = path.join(root, 'home'),
      out = path.join(root, 'snapshot');
    await mkdir(path.join(source, 'projects', '-workspace'), { recursive: true });
    await mkdir(out);
    await writeFile(path.join(source, '.credentials.json'), 'secret');
    await writeFile(path.join(source, 'projects', '-workspace', 'session.jsonl'), 'transcript');
    await copyClaudeTranscripts(source, out);
    expect(await readFile(path.join(out, 'projects', '-workspace', 'session.jsonl'), 'utf8')).toBe(
      'transcript'
    );
    await expect(readFile(path.join(out, '.credentials.json'))).rejects.toThrow();
    await symlink(
      path.join(source, '.credentials.json'),
      path.join(source, 'projects', 'leak.jsonl')
    );
    await expect(copyClaudeTranscripts(source, path.join(root, 'other'))).rejects.toThrow(
      'symlink'
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('imports only the selected legacy session into the stable workspace project', async () => {
  const { importClaudeSession } = await import('./sdk-transcripts');
  const root = await mkdtemp(path.join(tmpdir(), 'sdk-import-'));
  const id = '01990000-0000-7000-8000-000000000001';
  try {
    const source = path.join(root, 'old');
    const project = path.join(source, 'projects', '-old-branch');
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, `${id}.jsonl`), 'selected transcript');
    await writeFile(path.join(project, 'someone-else.jsonl'), 'private');
    const out = path.join(root, 'new');
    await importClaudeSession(source, out, id);
    expect(await readFile(path.join(out, 'projects', '-workspace', `${id}.jsonl`), 'utf8')).toBe(
      'selected transcript'
    );
    await expect(
      readFile(path.join(out, 'projects', '-workspace', 'someone-else.jsonl'))
    ).rejects.toThrow();
    await expect(
      importClaudeSession(
        source,
        path.join(root, 'missing'),
        '01990000-0000-7000-8000-000000000002'
      )
    ).rejects.toThrow('missing or ambiguous');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
