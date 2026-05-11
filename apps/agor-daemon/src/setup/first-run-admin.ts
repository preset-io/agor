/**
 * First-run admin bootstrap (daemon-side orchestrator)
 *
 * Owns the filesystem and stderr-UX concerns that the pure-DB
 * `bootstrapFirstRunAdmin` deliberately leaves out:
 *   - Path resolution (`~/.agor/admin-credentials`)
 *   - Atomic credential-file creation (O_EXCL, mode 0600)
 *   - Rollback (unlink credentials file) if user creation fails
 *   - Pretty-print of the result to stderr so operators see the password once
 *
 * The atomicity contract: the credentials file is written *before* the
 * admin row is created. If the file write fails, no admin exists, daemon
 * exits, operator investigates. If user creation fails *after* file write,
 * we unlink the file so the next start has a clean slate.
 */

import { close, open, unlink, write } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AgorConfig } from '@agor/core/config';
import {
  type AdminBootstrapResult,
  BOOTSTRAP_ADMIN_EMAIL,
  bootstrapFirstRunAdmin,
  createUser,
  type Database,
  generateAdminPassword,
} from '@agor/core/db';

const openP = promisify(open);
const writeP = promisify(write);
const closeP = promisify(close);
const unlinkP = promisify(unlink);

const ADMIN_CREDENTIALS_FILENAME = 'admin-credentials';

/** Where the generated admin password is persisted on first run. */
export function getAdminCredentialsPath(baseDir: string = join(homedir(), '.agor')): string {
  return join(baseDir, ADMIN_CREDENTIALS_FILENAME);
}

/**
 * Atomically create the credentials file with mode 0600. Uses `O_EXCL` so we
 * refuse to clobber an existing file — an operator who already has stored
 * admin credentials elsewhere must remove the file manually before we
 * regenerate. This avoids the failure mode "credentials file existed with a
 * password we silently overwrote."
 */
async function writeCredentialsExclusive(
  path: string,
  email: string,
  password: string
): Promise<void> {
  const body = [
    '# Agor admin credentials (auto-generated on first run)',
    '#',
    '# Use these to log in at the UI. You will be prompted to change the',
    '# password on first login. This file is mode 0600 — keep it that way.',
    '',
    `email: ${email}`,
    `password: ${password}`,
    '',
  ].join('\n');

  // O_WRONLY | O_CREAT | O_EXCL — fails if the file already exists.
  // Equivalent to `wx` mode in fs.writeFile, but writeFile doesn't expose the
  // mode parameter at create time on all platforms; using `open` directly is
  // the portable way to get both O_EXCL and mode 0600 in one syscall.
  let fd: number;
  try {
    fd = (await openP(path, 'wx', 0o600)) as unknown as number;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      // Pre-existing credentials file with zero users in the DB is an
      // operator-recoverable but ambiguous state — we refuse to clobber
      // an existing file in case the operator already stored it elsewhere.
      throw new Error(
        [
          `Refusing to bootstrap admin: credentials file already exists at ${path}`,
          'but the users table is empty.',
          '',
          'This usually means a previous bootstrap left a credentials file behind',
          'while the database was reset. To proceed:',
          `  - If you still have the password: keep ${path} as-is and create the`,
          `    admin manually (\`agor user create-admin\`), or restore the DB.`,
          `  - If the password is lost: delete ${path} and restart the daemon`,
          '    to regenerate.',
        ].join('\n')
      );
    }
    throw err;
  }
  try {
    await writeP(fd, body);
  } finally {
    await closeP(fd);
  }
}

/** Best-effort cleanup; swallows ENOENT and logs anything else. */
async function safeUnlink(path: string): Promise<void> {
  try {
    await unlinkP(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.error(`[bootstrap] Failed to unlink ${path}:`, err);
    }
  }
}

/**
 * Result of the daemon-side bootstrap, augmented with the path where
 * credentials landed (if any).
 */
export interface DaemonBootstrapResult extends AdminBootstrapResult {
  /** Path the credentials file was written to. Only set when `createdAdmin` is true. */
  credentialsPath?: string;
}

/**
 * Run the first-run admin bootstrap with filesystem-aware credential
 * persistence and rollback. Idempotent — safe on every daemon start.
 *
 * Atomicity:
 *   1. Generate the password.
 *   2. Open the credentials file with O_CREAT|O_EXCL|O_WRONLY mode 0600.
 *      Fails fast if the file already exists.
 *   3. Create the admin user with that password.
 *   4. On user-creation failure, unlink the credentials file so the next
 *      start is clean.
 *
 * The `credentialsBaseDir` option exists for tests. Production code should
 * accept the `~/.agor` default.
 */
export async function runFirstRunAdminBootstrap(
  db: Database,
  options: { credentialsBaseDir?: string } = {}
): Promise<DaemonBootstrapResult> {
  const credentialsPath = getAdminCredentialsPath(options.credentialsBaseDir);
  let credentialsWritten = false;

  const result = await bootstrapFirstRunAdmin(db, async () => {
    const password = generateAdminPassword();
    await writeCredentialsExclusive(credentialsPath, BOOTSTRAP_ADMIN_EMAIL, password);
    credentialsWritten = true;
    try {
      return await createUser(db, {
        email: BOOTSTRAP_ADMIN_EMAIL,
        password,
        name: 'Admin',
        role: 'admin',
        // Forces the operator to set their own password after first login.
        // Without this the printed/persisted cleartext stays valid forever.
        must_change_password: true,
      });
    } catch (err) {
      // Roll back the credentials file — otherwise the next start would
      // refuse to bootstrap (O_EXCL) even though no admin exists.
      await safeUnlink(credentialsPath);
      credentialsWritten = false;
      throw err;
    }
  });

  return {
    ...result,
    credentialsPath: credentialsWritten ? credentialsPath : undefined,
  };
}

/**
 * Pretty-print the bootstrap result to stderr. Centralized so the daemon
 * always renders the same message.
 */
export function logFirstRunAdminBootstrap(result: DaemonBootstrapResult): void {
  if (result.createdAdmin && result.credentialsPath && result.admin) {
    process.stderr.write('\n');
    process.stderr.write('================================================================\n');
    process.stderr.write('🔐  First-run admin user created\n');
    process.stderr.write('----------------------------------------------------------------\n');
    process.stderr.write(`    Email:     ${result.admin.email}\n`);
    process.stderr.write(`    Password:  see ${result.credentialsPath} (mode 0600)\n`);
    process.stderr.write('\n');
    process.stderr.write('    You will be prompted to change the password on first login.\n');
    process.stderr.write('================================================================\n');
    process.stderr.write('\n');
  }
  if (result.reattributedCount > 0 && result.admin) {
    process.stderr.write(
      `🧹 Re-attributed ${result.reattributedCount} legacy anonymous row(s) → ${result.admin.email}\n`
    );
  }
}

/**
 * Keys that used to control the (now-removed) anonymous-mode path. Surfaced
 * as deprecation warnings on startup so operators upgrading from an older
 * release see a clear migration note instead of a silent ignore.
 */
const DEPRECATED_ANONYMOUS_KEYS = ['allowAnonymous', 'requireAuth'] as const;

/**
 * Print a clear stderr banner if the loaded config still carries leftover
 * keys from the anonymous-mode path. The keys themselves have no runtime
 * effect anymore — this is purely an operator-UX nudge.
 *
 * Detected separately from the `AgorConfig` type because we deliberately
 * removed these fields from the interface; we reach into the raw object via
 * a Record cast to see what the YAML file actually contained.
 */
export function warnDeprecatedAnonymousConfig(config: AgorConfig): void {
  const daemon = (config as { daemon?: Record<string, unknown> }).daemon;
  if (!daemon) return;

  const present = DEPRECATED_ANONYMOUS_KEYS.filter((key) => Object.hasOwn(daemon, key));
  if (present.length === 0) return;

  const lines: string[] = [
    '',
    '================================================================',
    '⚠️  DEPRECATED CONFIG KEYS DETECTED',
    '----------------------------------------------------------------',
    '  Your config.yaml contains:',
  ];
  for (const key of present) {
    lines.push(`    daemon.${key}: ${String(daemon[key])}`);
  }
  lines.push(
    '',
    '  These keys no longer have any effect. Authentication is now',
    '  always required — anonymous mode was removed.',
    '',
    '  Action: remove these keys from your config.yaml at your',
    '  convenience. If you previously ran anonymously, the daemon',
    `  has auto-generated admin credentials at ${getAdminCredentialsPath()}`,
    '  (printed below if just created on this start).',
    '================================================================',
    ''
  );
  process.stderr.write(lines.join('\n'));
}
