import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cliLoginPageUrl, getMachineId, hostSlug } from './cli-login';

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function agorHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'agor-cli-login-'));
  homes.push(home);
  return join(home, '.agor');
}

describe('CLI login helpers', () => {
  it.each([
    ['Maxs-MacBook-Pro.local', 'maxs-macbook-pro-local'],
    ['  weird__host!!  ', 'weird-host'],
    ['ÜNICODE-box', 'nicode-box'],
    ['---', 'machine'],
    ['a'.repeat(80), 'a'.repeat(40)],
  ])('slugs hostname %j as %j', (input, expected) => {
    expect(hostSlug(input)).toBe(expected);
    expect(`agor-cli-${hostSlug(input)}-abc123`).toMatch(/^agor-cli-[a-z0-9][a-z0-9-]{0,80}$/);
  });

  it('creates one private machine id and reuses it', async () => {
    const home = await agorHome();
    const first = await getMachineId(home);
    expect(first).toMatch(/^[a-f0-9]{6}$/);
    expect(await getMachineId(home)).toBe(first);
    expect((await stat(join(home, 'cli-machine-id'))).mode & 0o777).toBe(0o600);
  });

  it('replaces a corrupted machine id instead of trusting it', async () => {
    const home = await agorHome();
    await getMachineId(home);
    await writeFile(join(home, 'cli-machine-id'), 'not-an-id; rm -rf /\n');
    const replaced = await getMachineId(home);
    expect(replaced).toMatch(/^[a-f0-9]{6}$/);
    expect((await readFile(join(home, 'cli-machine-id'), 'utf8')).trim()).toBe(replaced);
  });

  it('builds the login page URL under the UI base path', () => {
    expect(cliLoginPageUrl('https://ws.example.com/ui/', 'agor-cli-box-abc123')).toBe(
      'https://ws.example.com/ui/cli-login?name=agor-cli-box-abc123'
    );
  });
});
