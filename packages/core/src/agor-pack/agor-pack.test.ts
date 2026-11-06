import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ZipFile } from 'yazl';
import { generateId } from '../lib/ids';
import {
  AGOR_PACK,
  type AgorPackManifest,
  agorPackExportRequestSchema,
  agorPackPrivateHost,
} from '../types/agor-pack';
import { classifyEnvironmentVariants } from './environment-classification';
import {
  AgorPackFormatError,
  assertAgorPackEntryPath,
  isAllowedClaudeHomePath,
  isPortableWorktreePath,
  renameClaudeProjectPath,
} from './paths';
import {
  assertNoSecrets,
  assertNoSecretsDeep,
  redactSecrets,
  redactSecretsDeep,
  scanForSecrets,
} from './secret-scan';
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
async function rawZip(
  files: Record<string, string> | Array<[string, string, { mode?: number }?]>
): Promise<Buffer> {
  const zip = new ZipFile();
  const out = drain(zip.outputStream);
  const list = Array.isArray(files) ? files : Object.entries(files);
  for (const [name, content, options] of list) zip.addBuffer(Buffer.from(content), name, options);
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

  it('rejects a traversal name smuggled past the writer', async () => {
    // yazl refuses `..`, so write a same-length name and patch the bytes.
    const zip = await rawZip({ 'manifest.json': '{}', 'xx/escape.json': 'x' });
    const patched = Buffer.from(
      zip.toString('latin1').split('xx/escape').join('../escape'),
      'latin1'
    );
    await expect(AgorPackReader.open(bufferByteSource(patched))).rejects.toThrow(/\.\.\/escape/);
  });

  it('rejects duplicate and symlink entries in a raw archive', async () => {
    const duplicate = await rawZip([
      ['manifest.json', '{}'],
      ['teammates/t01/teammate.json', '{}'],
      ['teammates/t01/teammate.json', '{"evil":true}'],
    ]);
    await expect(AgorPackReader.open(bufferByteSource(duplicate))).rejects.toThrow(/Duplicate/);
    const symlink = await rawZip([
      ['manifest.json', '{}'],
      ['teammates/t01/git/worktree/link', '/etc/passwd', { mode: 0o120777 }],
    ]);
    await expect(AgorPackReader.open(bufferByteSource(symlink))).rejects.toThrow(
      /not a regular file/
    );
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

  it('redacts a whole private key block, not just its header', () => {
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
    const out = redactSecrets(`before\n${key}\nafter`);
    expect(out.text).toBe('before\n[redacted:private_key]\nafter');
    expect(redactSecrets('-----BEGIN PRIVATE KEY-----\nMIIEvQ').text).toBe(
      '[redacted:private_key]'
    );
  });

  it('finds tokens that JSON escaping glues to a word character', () => {
    const value = {
      content: `token:\nghp_${'a'.repeat(36)}`,
      nested: [`\t${'xoxb-123456789012-abc'}`],
    };
    // Serialized, `\nghp_` has no word boundary before `ghp_`.
    expect(scanForSecrets(JSON.stringify(value)).map((hit) => hit.id)).not.toContain(
      'github_token'
    );
    expect(() => assertNoSecretsDeep('x.json', value)).toThrow(/github_token/);
    const redacted = redactSecretsDeep(value);
    expect(redacted.redacted).toBe(2);
    expect(JSON.stringify(redacted.value)).not.toMatch(/ghp_a|xoxb-1/);
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

describe('agorPackPrivateHost', () => {
  it.each([
    ['https://jenkins.internal/job/x', 'jenkins.internal'],
    ['curl http://10.0.0.12:8080/health', '10.0.0.12'],
    ['http://172.20.1.1', '172.20.1.1'],
    ['http://192.168.1.5/', '192.168.1.5'],
    ['http://localhost:3000', 'localhost'],
    ['ssh build.lan', 'build.lan'],
    ['http://printer.local.', 'printer.local'],
  ])('finds the host in %s', (text, host) => {
    expect(agorPackPrivateHost(text)).toBe(host);
  });

  it.each([
    'https://mcp.notion.com/mcp',
    'cp .env.local .env',
    'cat config.local.json',
    'http://172.32.0.1',
    'http://8.8.8.8',
    'node server.internal.js',
  ])('ignores %s', (text) => {
    expect(agorPackPrivateHost(text)).toBeNull();
  });
});

describe('secret scan: credentials in URLs', () => {
  it.each([
    'https://user:hunter22@api.example.test/v1',
    'https://api.example.test/v1?api_key=plainsecret123',
    'https://api.example.test/v1?region=eu&access_token=abcdefgh12345',
    // A literal next to a reference is still a literal.
    'https://{{ user.env.USER }}:literal-password@example.test/auth',
    'https://{{ user.env.USER }}:{{ user.env.PASS }}x@example.test/auth',
    'https://api.example.test/v1?api_key={{ user.env.KEY }}plainsecret',
    'https://api.example.test/v1?api_key=sk{{ user.env.KEY }}',
    // Encoded or mixed-case names are the same names.
    'https://api.example.test/v1?%74oken=literal-secret',
    'https://api.example.test/v1?region=eu&API%5FKey=plainsecret123',
    'https://api.example.test/v1?ToKeN=literal-secret',
  ])('catches %s', (text) => {
    expect(scanForSecrets(text).map((hit) => hit.id)).not.toEqual([]);
  });

  it.each([
    'https://api.example.test/v1?api_key={{ user.env.ACME_KEY }}',
    'https://{{ user.env.USER }}:{{ user.env.PASS }}@api.example.test/',
    'https://api.example.test/v1?api_key=[redacted]',
    'https://git@github.com/preset-io/agor.git',
    'https://api.example.test/v1?page=2&sort=desc',
    'https://api.example.test/v1?token={{ user.env.TOKEN }}&region=eu',
    'https://alice:{{ user.env.PASS }}@example.test/auth',
    'https://api.example.test/v1?%70age=2&sort=desc',
  ])('ignores %s', (text) => {
    expect(scanForSecrets(text)).toEqual([]);
  });
});

describe('older packs', () => {
  it('reads a manifest exported with the earlier 30-day session default', async () => {
    const pack = await buildPack(
      (writer) => writer.addJson('teammates/t01/teammate.json', { a: 1 }),
      (manifest) => ({
        ...manifest,
        options: { ...manifest.options, sessions: 'last_30_days' },
        teammates: manifest.teammates.map((teammate) => ({
          ...teammate,
          sections: {
            ...teammate.sections,
            sessions: {
              mode: 'last_30_days',
              count: 0,
              messages: 0,
              others_included: false,
              redacted_values: 0,
            },
          },
        })),
      })
    );
    const reader = await AgorPackReader.open(bufferByteSource(pack));
    expect(reader.manifest.options.sessions).toBe('last_30_days');
    expect(reader.manifest.teammates[0]?.sections.sessions?.mode).toBe('last_30_days');
    reader.close();
    // New exports only write the current modes.
    expect(
      agorPackExportRequestSchema.safeParse({
        branch_ids: [generateId()],
        sessions: 'last_30_days',
      }).success
    ).toBe(false);
  });
});

describe('redacting encoded credential names', () => {
  it('redacts a credential behind a percent-encoded name', () => {
    const { text, redacted } = redactSecrets('see https://x.test/a?%74oken=literal-secret ok');
    expect(redacted).toBe(1);
    expect(text).not.toContain('literal-secret');
  });
});
