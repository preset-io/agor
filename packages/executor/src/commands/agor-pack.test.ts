import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgorPackWriter,
  bufferByteSource,
  claudeProjectSlug,
  forEachPackFragmentEntry,
} from '@agor/core/agor-pack';
import { generateId } from '@agor/core/ids';
import type { AgorPackManifest } from '@agor/core/types';
import { simpleGit } from '@agor/git';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BranchPackCollectPayload, BranchPackMaterializePayload } from '../payload-types.js';
import { createExecutorClient } from '../services/feathers-client.js';
import { handleBranchPackCollect, handleBranchPackMaterialize } from './agor-pack.js';

vi.mock('../services/feathers-client.js', () => ({ createExecutorClient: vi.fn() }));

let root: string;
let tenantRoot: string;
let branchId: string;

async function drain(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function stubBranch(path: string) {
  vi.mocked(createExecutorClient).mockResolvedValue({
    service: () => ({ get: async () => ({ path, filesystem_status: 'ready' }) }),
    io: { disconnect: () => undefined },
  } as never);
}

async function initRepo(path: string): Promise<ReturnType<typeof simpleGit>> {
  await mkdir(path, { recursive: true });
  const git = simpleGit(path);
  await git.init(['--initial-branch=main']);
  await git.addConfig('user.name', 'Fixture');
  await git.addConfig('user.email', 'fixture@example.test');
  return git;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agor-pack-exec-'));
  tenantRoot = join(root, 'tenant');
  branchId = generateId();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

it('collects history, dirty files, and allow-listed Claude memory, nothing else', async () => {
  const worktree = join(root, 'worktree');
  const git = await initRepo(worktree);
  await writeFile(join(worktree, 'README.md'), 'one');
  await git.add('.').commit('first');
  await writeFile(join(worktree, 'README.md'), 'two'); // tracked, modified
  await writeFile(join(worktree, 'notes.txt'), 'untracked');
  await writeFile(join(worktree, '.env'), 'SECRET=1'); // denied by name
  const claude = join(tenantRoot, 'branch-homes', branchId, 'claude');
  await mkdir(join(claude, 'projects', '-src-ada', 'memory'), { recursive: true });
  await writeFile(join(claude, 'projects', '-src-ada', 'memory', 'MEMORY.md'), '# memory');
  await writeFile(join(claude, 'projects', '-src-ada', 'transcript.jsonl'), '{}');
  await writeFile(join(claude, '.credentials.json'), '{"token":"x"}');
  await writeFile(join(claude, 'settings.json'), '{}');
  stubBranch(worktree);

  let uploaded: Buffer | null = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      uploaded = await drain(init.body as unknown as NodeJS.ReadableStream);
      return new Response(JSON.stringify({ ref: 'upl_x' }), { status: 200 });
    })
  );
  const payload = {
    command: 'branch.pack.collect',
    sessionToken: 'token',
    daemonUrl: 'http://daemon.test',
    params: {
      branchId,
      localHome: true,
      branchHome: join(tenantRoot, 'branch-homes', branchId),
      tenantDataRoot: tenantRoot,
      exportId: generateId(),
      includeClaudeMemory: true,
    },
  } as BranchPackCollectPayload;
  const result = await handleBranchPackCollect(payload, {});
  expect(result.success).toBe(true);
  expect(result.data).toMatchObject({
    git: { mode: 'bundle', bundle: true, unpushed_commits: 1, dirty_files: 2 },
    claudeMemory: { files: 1 },
  });
  const names: string[] = [];
  await forEachPackFragmentEntry(bufferByteSource(uploaded as unknown as Buffer), async (entry) => {
    names.push(entry.path);
  });
  expect(names.sort()).toEqual([
    'teammates/t00/git/repo.bundle',
    'teammates/t00/git/state.json',
    'teammates/t00/git/worktree/README.md',
    'teammates/t00/git/worktree/notes.txt',
    'teammates/t00/sdk-home/claude/projects/-src-ada/memory/MEMORY.md',
  ]);
});

it('refuses to collect a working-tree file that looks like a secret', async () => {
  const worktree = join(root, 'worktree');
  const git = await initRepo(worktree);
  await writeFile(join(worktree, 'README.md'), 'one');
  await git.add('.').commit('first');
  await writeFile(join(worktree, 'config.ts'), `const key = "ghp_${'a'.repeat(36)}";`);
  stubBranch(worktree);
  vi.stubGlobal('fetch', vi.fn());
  const result = await handleBranchPackCollect(
    {
      command: 'branch.pack.collect',
      sessionToken: 'token',
      daemonUrl: 'http://daemon.test',
      params: {
        branchId,
        localHome: false,
        branchHome: join(tenantRoot, 'branch-homes', branchId),
        tenantDataRoot: tenantRoot,
        exportId: generateId(),
        includeClaudeMemory: false,
      },
    } as BranchPackCollectPayload,
    {}
  );
  expect(result.success).toBe(false);
  expect(result.error?.message).toMatch(/looks like a secret/);
  expect(fetch).not.toHaveBeenCalled();
});

it('materializes history, files, deletions, and renames the Claude project slug', async () => {
  // Source teammate history to bundle.
  const source = join(root, 'source');
  const sourceGit = await initRepo(source);
  await writeFile(join(source, 'keep.txt'), 'keep');
  await writeFile(join(source, 'gone.txt'), 'gone');
  await sourceGit.add('.').commit('source work');
  const head = (await sourceGit.revparse('HEAD')).trim();
  const bundle = join(root, 'repo.bundle');
  await sourceGit.raw(['bundle', 'create', bundle, '--all']);

  // Destination checkout (as git.branch.add left it): an unrelated fresh repo.
  const destination = join(root, 'dest', 'worktrees', 'ada-2');
  const destGit = await initRepo(destination);
  await writeFile(join(destination, 'template.txt'), 'template');
  await destGit.add('.').commit('template');
  stubBranch(destination);

  const writer = new AgorPackWriter();
  const out = drain(writer.output);
  writer.addBuffer('teammates/t01/git/repo.bundle', await readFile(bundle), { compress: false });
  writer.addJson('teammates/t01/git/state.json', {
    version: 1,
    head_sha: head,
    ref: 'main',
    deleted: ['gone.txt'],
  });
  writer.addBuffer('teammates/t01/git/worktree/notes/todo.md', 'dirty', { mode: 0o644 });
  writer.addBuffer('teammates/t01/sdk-home/claude/projects/-src-ada/memory/MEMORY.md', '# me');
  writer.addBuffer('teammates/t01/sdk-home/claude/CLAUDE.md', 'rules');
  writer.finish(
    ({ entries, content_sha256 }) =>
      ({
        format: 'agor-pack',
        version: 1,
        pack_id: generateId(),
        created_at: new Date().toISOString(),
        source: {
          agor_version: 'test',
          instance_label: null,
          exported_by: { user_id: generateId(), email: null, name: null },
        },
        options: { sections: [], sessions: 'none', include_others_sessions: false },
        teammates: [
          {
            key: 't01',
            display_name: 'Ada',
            emoji: null,
            source_branch_id: generateId(),
            branch_name: 'ada',
            repo: { slug: 'r', remote_url: null, local_home: true },
            sections: {
              board: null,
              knowledge: null,
              artifacts: null,
              schedules: null,
              claude_memory: null,
              uploads: null,
              sessions: null,
              git: null,
            },
            requirements: {
              env_vars: [],
              mcp_servers: [],
              gateway_channels: [],
              agentic_tools: [],
            },
            environment: { variant: null, variants: [] },
            warnings: [],
          },
        ],
        entries,
        content_sha256,
      }) as AgorPackManifest
  );
  const pack = await out;
  const fetchPack = vi.fn(async () => new Response(new Uint8Array(pack), { status: 200 }));
  vi.stubGlobal('fetch', fetchPack);
  const importId = generateId();
  const materialize = (claimToken: string) =>
    handleBranchPackMaterialize(
      {
        command: 'branch.pack.materialize',
        sessionToken: 'token',
        daemonUrl: 'http://daemon.test',
        params: {
          branchId,
          localHome: true,
          branchHome: join(tenantRoot, 'branch-homes', branchId),
          tenantDataRoot: tenantRoot,
          importId,
          teammateKey: 't01',
          claimToken,
          sourceClaudeProjectSlug: '-src-ada',
        },
      } as BranchPackMaterializePayload,
      {}
    );

  const firstClaim = generateId();
  const result = await materialize(firstClaim);
  expect(result).toMatchObject({
    success: true,
    data: { head_sha: head, files: 1, claude_files: 2 },
  });
  // The pack download is bound to this attempt's claim.
  expect(String(fetchPack.mock.calls[0]?.[0])).toContain(`claim=${firstClaim}`);
  // Same pack again (a retry or a second attempt): same checkout, and no
  // attempt's temporary ref is left behind.
  expect(await materialize(generateId())).toMatchObject({
    success: true,
    data: { head_sha: head, files: 1, claude_files: 2 },
  });
  expect((await simpleGit(destination).raw(['for-each-ref', 'refs/agor-pack/'])).trim()).toBe('');
  expect((await simpleGit(destination).revparse('HEAD')).trim()).toBe(head);
  expect(await readFile(join(destination, 'keep.txt'), 'utf8')).toBe('keep');
  await expect(stat(join(destination, 'gone.txt'))).rejects.toThrow();
  expect(await readFile(join(destination, 'notes', 'todo.md'), 'utf8')).toBe('dirty');
  const claude = join(tenantRoot, 'branch-homes', branchId, 'claude');
  const memory = join(claude, 'projects', claudeProjectSlug(destination), 'memory', 'MEMORY.md');
  expect(await readFile(memory, 'utf8')).toBe('# me');
  expect((await stat(memory)).mode & 0o777).toBe(0o600);
  expect(await readFile(join(claude, 'CLAUDE.md'), 'utf8')).toBe('rules');
});

it('rejects a branch home outside the tenant root', async () => {
  stubBranch(join(root, 'anywhere'));
  vi.stubGlobal('fetch', vi.fn());
  const result = await handleBranchPackCollect(
    {
      command: 'branch.pack.collect',
      sessionToken: 'token',
      daemonUrl: 'http://daemon.test',
      params: {
        branchId,
        localHome: true,
        branchHome: join(root, 'elsewhere'),
        tenantDataRoot: tenantRoot,
        exportId: generateId(),
        includeClaudeMemory: true,
      },
    } as BranchPackCollectPayload,
    {}
  );
  expect(result.success).toBe(false);
});
