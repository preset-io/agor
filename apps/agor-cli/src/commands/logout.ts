/**
 * `agor logout` - Clear the stored login
 *
 * Password logins only remove the local token. A key minted for this machine by
 * the browser login (`cli_login`) is also deleted on the server, so the machine
 * loses access immediately; `--keep-key` skips that. If that delete fails (for
 * example the server is unreachable), the local login is kept so the key is not
 * orphaned while still live; `--force` removes the local login anyway. Keys
 * created by hand in settings are never deleted here because they may be used
 * elsewhere.
 */

import { USER_API_KEYS_SERVICE_PATH } from '@agor/core/types';
import { createRestClient } from '@agor-live/client';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { clearToken, loadToken, type StoredApiKeyAuth } from '../lib/auth';

type RevokeOutcome = { ok: true; note: string } | { ok: false; reason: string };

export default class Logout extends Command {
  static description = 'Clear the current deployment connection';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --keep-key',
    '<%= config.bin %> <%= command.id %> --force',
  ];

  static flags = {
    'keep-key': Flags.boolean({
      description: "Keep this machine's CLI key on the server; only remove the local login",
    }),
    force: Flags.boolean({
      description: "Remove the local login even if this machine's CLI key could not be deleted",
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Logout);
    const storedAuth = await loadToken();

    if (!storedAuth) {
      this.log(chalk.dim('Not currently logged in'));
      return;
    }

    let serverNote: string | null = null;
    if (storedAuth.version === 3) {
      const outcome = await this.revokeCliKey(storedAuth, flags['keep-key']);
      if (outcome.ok) {
        serverNote = outcome.note;
      } else if (flags.force) {
        this.warn(
          `Could not delete this machine's CLI key on the server (${outcome.reason}). It is still valid; delete it in User settings → API tokens.`
        );
        serverNote = 'The local login was removed anyway (--force).';
      } else {
        this.error(
          `Could not delete this machine's CLI key on the server (${outcome.reason}). You are still logged in. Retry when the server is reachable, or run \`agor logout --force\` to remove the local login and delete the key in User settings → API tokens.`,
          { exit: 1 }
        );
      }
    }

    await clearToken();

    this.log('');
    this.log(chalk.green('✓ Logged out successfully'));
    this.log('');
    this.log(chalk.dim('Token removed from ~/.agor/cli-token'));
    if (serverNote) this.log(chalk.dim(serverNote));
    this.log('');
  }

  /** Deletes this machine's `cli_login` key on the server, when there is one. */
  private async revokeCliKey(auth: StoredApiKeyAuth, keepKey: boolean): Promise<RevokeOutcome> {
    if (auth.apiKeySource !== 'cli_login' || !auth.apiKeyId) {
      return {
        ok: true,
        note: 'The API key was not deleted (it may be used elsewhere). Delete it in User settings → API tokens if needed.',
      };
    }
    if (keepKey) {
      return { ok: true, note: "This machine's CLI key was kept on the server (--keep-key)." };
    }
    try {
      const client = await createRestClient(auth.target.url, auth.apiKey);
      await client.service(USER_API_KEYS_SERVICE_PATH).remove(auth.apiKeyId);
      return { ok: true, note: "This machine's CLI key was deleted on the server." };
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === 401 || code === 404) {
        return { ok: true, note: "This machine's CLI key was already revoked on the server." };
      }
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }
}
