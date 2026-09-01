/**
 * Unit tests for response normalization plus a fake-process protocol check
 * for the Codex app-server sidecar client.
 */

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAppServerClient, extractCodexSkillsFromListResponse } from './app-server-client.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function createFakeAppServer(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agor-codex-app-server-'));
  temporaryDirectories.push(directory);
  const command = join(directory, 'fake-codex');
  await writeFile(
    command,
    `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    send({ id: request.id, result: {} });
  } else if (request.method === 'skills/list') {
    send({
      id: request.id,
      result: {
        data: [{
          cwd: request.params.cwds[0],
          skills: [{
            name: process.env.OPENAI_API_KEY ? 'ambient-key-leaked' : 'safe-skill',
            description: JSON.stringify(request.params),
            enabled: true,
          }],
          errors: [],
        }],
      },
    });
  }
});
`
  );
  await chmod(command, 0o755);
  return command;
}

describe('extractCodexSkillsFromListResponse', () => {
  it('flattens per-cwd groups, keeping plugin-qualified names and metadata', () => {
    const skills = extractCodexSkillsFromListResponse({
      data: [
        {
          cwd: '/work/branch-a',
          skills: [
            {
              name: 'dwh-user:dwh-operations',
              description: 'DWH reference',
              enabled: true,
              scope: 'user',
              pluginId: 'dwh-user@ug-internal-plugins',
            },
            { name: 'deep-research', description: 'Research harness', enabled: true },
          ],
        },
      ],
    });

    expect(skills).toEqual([
      {
        name: 'dwh-user:dwh-operations',
        description: 'DWH reference',
        enabled: true,
        scope: 'user',
        pluginId: 'dwh-user@ug-internal-plugins',
      },
      {
        name: 'deep-research',
        description: 'Research harness',
        enabled: true,
        scope: undefined,
        pluginId: undefined,
      },
    ]);
  });

  it('drops disabled skills and dedupes across cwd groups', () => {
    const skills = extractCodexSkillsFromListResponse({
      data: [
        {
          cwd: '/a',
          skills: [
            { name: 'shared-skill', enabled: true },
            { name: 'disabled-skill', enabled: false },
          ],
        },
        { cwd: '/b', skills: [{ name: 'shared-skill', enabled: true }] },
      ],
    });

    expect(skills.map((s) => s.name)).toEqual(['shared-skill']);
  });

  it('tolerates malformed responses without throwing', () => {
    expect(extractCodexSkillsFromListResponse(undefined)).toEqual([]);
    expect(extractCodexSkillsFromListResponse(null)).toEqual([]);
    expect(extractCodexSkillsFromListResponse({})).toEqual([]);
    expect(extractCodexSkillsFromListResponse({ data: 'nope' })).toEqual([]);
    expect(
      extractCodexSkillsFromListResponse({
        data: [{ skills: [null, 42, { name: '' }, { name: '   ' }, 'junk'] }, { cwd: '/x' }],
      })
    ).toEqual([]);
  });
});

describe('CodexAppServerClient', () => {
  it.skipIf(process.platform === 'win32')(
    'uses the supplied env as authoritative and sends skills/list with the requested cwd',
    async () => {
      const command = await createFakeAppServer();
      const previousApiKey = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = 'ambient-daemon-key';
      const client = new CodexAppServerClient({
        command,
        env: {
          HOME: process.env.HOME,
          PATH: process.env.PATH,
        },
      });

      try {
        await expect(client.listSkills(['/work/branch'])).resolves.toEqual([
          {
            name: 'safe-skill',
            description: '{"cwds":["/work/branch"],"forceReload":true}',
            enabled: true,
            scope: undefined,
            pluginId: undefined,
          },
        ]);
      } finally {
        await client.close();
        if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = previousApiKey;
      }
    }
  );
});
