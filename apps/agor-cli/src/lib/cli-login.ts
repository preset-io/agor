/**
 * Browser-assisted `agor login` helpers.
 *
 * The CLI names the key it asks the browser to mint `agor-cli-<host>-<id>`. The
 * random id is created once per machine and kept next to `cli-token`, so two
 * machines that share a hostname never replace each other's CLI key, while a
 * re-login on the same machine replaces its own.
 */

import { randomBytes } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { ensureAgorHome, getAgorHome } from '@agor/core/config';

const MACHINE_ID_FILE = 'cli-machine-id';
const MACHINE_ID = /^[a-f0-9]{6}$/;
const MAX_HOST_SLUG = 40;

/** Lowercase `[a-z0-9-]` slug of the hostname, safe for the key name the UI accepts. */
export function hostSlug(host: string): string {
  const slug = host
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_HOST_SLUG)
    .replace(/-+$/g, '');
  return slug || 'machine';
}

/** Stable per-machine id, created on first use (mode 0600 under the Agor home). */
export async function getMachineId(agorHome = getAgorHome()): Promise<string> {
  const file = join(agorHome, MACHINE_ID_FILE);
  try {
    const existing = (await readFile(file, 'utf8')).trim();
    if (MACHINE_ID.test(existing)) return existing;
  } catch {
    // Missing or unreadable: create a fresh id below.
  }
  const id = randomBytes(3).toString('hex');
  await ensureAgorHome(agorHome);
  await writeFile(file, `${id}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
  return id;
}

export async function cliKeyName(agorHome?: string): Promise<string> {
  return `agor-cli-${hostSlug(hostname())}-${await getMachineId(agorHome)}`;
}

/** Browser page that mints this machine's CLI key. */
export function cliLoginPageUrl(uiBaseUrl: string, keyName: string): string {
  const url = new URL(`${uiBaseUrl.replace(/\/$/, '')}/cli-login`);
  url.searchParams.set('name', keyName);
  return url.toString();
}
