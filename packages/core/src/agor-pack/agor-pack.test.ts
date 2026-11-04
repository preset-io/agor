import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ZipFile } from 'yazl';
import { generateId } from '../lib/ids';
import { AGOR_PACK, type AgorPackManifest } from '../types/agor-pack';
import { classifyEnvironmentVariants } from './environment-classification';
import {
  AgorPackFormatError,
  assertAgorPackEntryPath,
  isAllowedClaudeHomePath,
  isPortableWorktreePath,
  renameClaudeProjectPath,
} from './paths';
import { assertNoSecrets, redactSecrets, scanForSecrets } from './secret-scan';
import { AgorPackReader, bufferByteSource } from './zip-reader';
import { AgorPackWriter, computePackContentSha256 } from './zip-writer';

async function drain(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function manifestFor(
  entries: AgorPackManifest['entries'],
  content_sha256: string
): AgorPackManifest {
  return {
    format: 'agor-pack',
    version: 1,
    pack_id: generateId(),
    created_at: new Date().toISOString(),
    source: {
      agor_version: '0.0.0-test',
      instance_label: null,
      exported_by: { user_id: generateId(), email: 'a@example.com', name: 'A' },
    },
    options: { sections: ['board'], sessions: 'none', include_others_sessions: false },
    teammates: [
      {
        key: 't01',
        display_name: 'Ada',
        emoji: null,
        source_branch_id: generateId(),
        branch_name: 'ada',
        repo: { slug: 'preset-io/agor-teammate', remote_url: null, local_home: true },
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
        requirements: { env_vars: [], mcp_servers: [], gateway_channels: [], agentic_tools: [] },
        environment: { variant: null, variants: [] },
        warnings: [],
      },
    ],
    entries,
    content_sha256,
  };
}

async function buildPack(
  add: (writer: AgorPackWriter) => Promise<void> | void,
  mutate?: (manifest: AgorPackManifest) => AgorPackManifest
): Promise<Buffer> {
  const writer = new AgorPackWriter();
  const out = drain(writer.output);
  await add(writer);
  writer.finish(({ entries, content_sha256 }) => {
    const manifest = manifestFor(entries, content_sha256);
    return mutate ? mutate(manifest) : manifest;
  });
  return out;
}

/** A raw zip with arbitrary entry names, bypassing the writer's validation. */
async function rawZip(files: Record<string, string>): Promise<Buffer> {
  const zip = new ZipFile();
  const out = drain(zip.outputStream);
  for (const [name, content] of Object.entries(files)) zip.addBuffer(Buffer.from(content), name);
  zip.end();
  return out;
}

describe('agor pack round trip', () => {
  it('writes entries with hashes and reads them back verified', async () => {
    const pack = await buildPack(async (writer) => {
      writer.addJson('teammates/t01/teammate.json', { hello: 'world' });
      await writer.addStream(
        'teammates/t01/git/worktree/bin/run.sh',
        Readable.from([Buffer.from('#!/bin/sh\necho hi\n')]),
        { mode: 0o755 }
      );
    });
    const reader = await AgorPackReader.open(bufferByteSource(pack));
    expect(reader.manifest.entries.map((entry) => entry.path)).toEqual([
      'teammates/t01/git/worktree/bin/run.sh',
      'teammates/t01/teammate.json',
    ]);
    expect(JSON.parse(await reader.readText('teammates/t01/teammate.json'))).toEqual({
      hello: 'world',
    });
    expect(reader.mode('teammates/t01/git/worktree/bin/run.sh')).toBe(0o755);
    expect(reader.list('teammates/t01/git/')).toHaveLength(1);
    reader.close();
  });

  it('gives identical content hashes for identical content', async () => {
    const build = () =>
      buildPack((writer) => writer.addJson('teammates/t01/teammate.json', { a: 1 }));
    const [first, second] = await Promise.all([build(), build()]);
    const a = await AgorPackReader.open(bufferByteSource(first));
    const b = await AgorPackReader.open(bufferByteSource(second));
    expect(a.manifest.content_sha256).toBe(b.manifest.content_sha256);
  });

  it('rejects an entry the manifest does not list', async () => {
    const entries = [
      {
        path: 'teammates/t01/teammate.json',
        bytes: 2,
        sha256: createHash('sha256').update('{}').digest('hex'),
      },
    ];
    const manifest = manifestFor(entries, computePackContentSha256(entries));
    const zip = await rawZip({
      'manifest.json': JSON.stringify(manifest),
      'teammates/t01/teammate.json': '{}',
      'teammates/t01/board.json': '{}',
    });
    await expect(AgorPackReader.open(bufferByteSource(zip))).rejects.toThrow(/not in the manifest/);
  });

  it('rejects tampered entry bytes on read', async () => {
    const entries = [
      {
        path: 'teammates/t01/teammate.json',
        bytes: 2,
        sha256: createHash('sha256').update('{}').digest('hex'),
      },
    ];
    const manifest = manifestFor(entries, computePackContentSha256(entries));
    const zip = await rawZip({
      'manifest.json': JSON.stringify(manifest),
      'teammates/t01/teammate.json': '[]',
    });
    const reader = await AgorPackReader.open(bufferByteSource(zip));
    await expect(reader.readText('teammates/t01/teammate.json')).rejects.toThrow(/integrity/);
  });

  it('rejects a manifest whose content hash does not match', async () => {
    const pack = buildPack(
      (writer) => writer.addJson('teammates/t01/teammate.json', {}),
      (manifest) => ({ ...manifest, content_sha256: '0'.repeat(64) })
    );
    await expect(AgorPackReader.open(bufferByteSource(await pack))).rejects.toThrow(/content hash/);
  });

  it.each([
    ['../escape.json'],
    ['/etc/passwd'],
    ['teammates/t01/../t02/teammate.json'],
    ['teammates/t01/unknown.json'],
    ['teammates/t01/git/worktree/.git/config'],
    ['teammates/t01/git/worktree/.env'],
    ['teammates/t01/sdk-home/claude/.credentials.json'],
    ['teammates/t01/sdk-home/claude/settings.json'],
    ['teammates/t01/sdk-home/claude/projects/x/abc.jsonl'],
  ])('rejects unsafe or unknown entry name %s', async (name) => {
    expect(() => assertAgorPackEntryPath(name)).toThrow(AgorPackFormatError);
    // yazl itself refuses absolute and `..` names, so only zip what it accepts.
    if (name.startsWith('/') || name.includes('..')) return;
    const zip = await rawZip({ 'manifest.json': '{}', [name]: 'x' });
    await expect(AgorPackReader.open(bufferByteSource(zip))).rejects.toThrow(AgorPackFormatError);
  });

  it('rejects duplicate entries and oversized packs', async () => {
    const writer = new AgorPackWriter();
    writer.addJson('teammates/t01/teammate.json', {});
    expect(() => writer.addJson('teammates/t01/teammate.json', {})).toThrow(/Duplicate/);
    await expect(
      AgorPackReader.open({ size: AGOR_PACK.maxBytes + 1, readRange: () => Readable.from([]) })
    ).rejects.toThrow(/maximum size/);
  });
});

describe('agor pack path rules', () => {
  it('allows only memory, skills, agents, commands, and CLAUDE.md from the Claude home', () => {
    expect(isAllowedClaudeHomePath('CLAUDE.md')).toBe(true);
    expect(isAllowedClaudeHomePath('projects/-home-a/memory/MEMORY.md')).toBe(true);
    expect(isAllowedClaudeHomePath('skills/review/SKILL.md')).toBe(true);
    expect(isAllowedClaudeHomePath('projects/-home-a/session.jsonl')).toBe(false);
    expect(isAllowedClaudeHomePath('history.jsonl')).toBe(false);
    expect(isAllowedClaudeHomePath('todos/x.json')).toBe(false);
  });

  it('keeps secret-bearing working-tree files out', () => {
    expect(isPortableWorktreePath('src/index.ts')).toBe(true);
    expect(isPortableWorktreePath('.env.local')).toBe(false);
    expect(isPortableWorktreePath('keys/server.pem')).toBe(false);
    expect(isPortableWorktreePath('home/.ssh/id_ed25519')).toBe(false);
  });

  it('renames the source project slug and its subdirectory slugs', () => {
    expect(renameClaudeProjectPath('projects/-old/memory/a.md', '-old', '-new')).toBe(
      'projects/-new/memory/a.md'
    );
    expect(renameClaudeProjectPath('projects/-old-sub/memory/a.md', '-old', '-new')).toBe(
      'projects/-new-sub/memory/a.md'
    );
    expect(renameClaudeProjectPath('projects/-other/memory/a.md', '-old', '-new')).toBe(
      'projects/-other/memory/a.md'
    );
  });
});

describe('agor pack secret scan', () => {
  const fixtures: Array<[string, string]> = [
    ['agor_encrypted_value', `${'a'.repeat(32)}:${'b'.repeat(32)}:${'c'.repeat(32)}:abcdef`],
    ['agor_api_key', 'agor_sk_0123456789abcdefABCD'],
    ['slack_token', 'xoxb-123456789012-abcdefghijkl'],
    ['slack_app_token', 'xapp-1-A0123456789-abcdefghij'],
    ['github_token', `ghp_${'a'.repeat(36)}`],
    ['github_pat', `github_pat_${'a'.repeat(30)}`],
    ['anthropic_key', `sk-ant-api03-${'a'.repeat(30)}`],
    ['aws_access_key', 'AKIAABCDEFGHIJKLMNOP'],
    ['private_key', '-----BEGIN OPENSSH PRIVATE KEY-----'],
  ];

  it.each(fixtures)('detects %s', (id, value) => {
    expect(scanForSecrets(`token: ${value}\n`).map((hit) => hit.id)).toContain(id);
    expect(() => assertNoSecrets('teammates/t01/x', value)).toThrow(/looks like a secret/);
    expect(redactSecrets(`a ${value} b`).text).not.toContain(value);
  });

  it('passes ordinary text', () => {
    expect(scanForSecrets('use the GITHUB_TOKEN env var; sha 0123abcd')).toEqual([]);
  });
});

describe('environment classification', () => {
  it('flags container and localhost variants', () => {
    const result = classifyEnvironmentVariants({
      version: 2,
      default: 'dev',
      variants: {
        dev: { start: 'docker compose up -d', stop: 'docker compose down' },
        local: { start: 'pnpm dev', stop: 'true', health: 'http://localhost:3000' },
        hook: {
          start: 'https://deploy.example.com/start',
          stop: 'https://deploy.example.com/stop',
        },
      },
    });
    expect(result).toEqual([
      { name: 'dev', status: 'wont_run_in_cloud', match: 'docker' },
      { name: 'hook', status: 'ok', match: null },
      { name: 'local', status: 'needs_webhook', match: 'localhost' },
    ]);
  });
});
