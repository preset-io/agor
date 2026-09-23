/**
 * `agor login` - Authenticate with daemon
 *
 * Prompts for email/password and stores JWT token for future CLI commands
 */

import { access } from 'node:fs/promises';
import {
  getConfigPath,
  loadConfig,
  requireDeploymentId,
  resolveDaemonUrl,
} from '@agor/core/config';
import { normalizeHttpBaseUrl } from '@agor/core/utils/url';
import { createRestClient } from '@agor-live/client';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { saveToken } from '../lib/auth';
import { probeAgorDaemon } from '../lib/daemon-probe';

export default class Login extends Command {
  static description = 'Select and authenticate with a deployment';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --email user@example.com',
    '<%= config.bin %> <%= command.id %> --url https://my-workspace.example.com --api-key',
    'pbpaste | <%= config.bin %> <%= command.id %> --url https://my-workspace.example.com --api-key',
  ];

  static flags = {
    email: Flags.string({
      char: 'e',
      description: 'Email address',
    }),
    password: Flags.string({
      char: 'p',
      description: 'Password (will prompt if not provided)',
    }),
    url: Flags.string({ description: 'Daemon URL to authenticate with' }),
    local: Flags.boolean({ description: 'Use the daemon from the local effective config' }),
    'api-key': Flags.boolean({
      description:
        'Authenticate with a personal API key (prompted, or read from stdin). Use this for deployments that sign in with Google/SSO.',
      exclusive: ['email', 'password'],
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Login);

    if (flags.url && flags.local) this.error('Use either --url or --local, not both.');
    // An explicit remote target must not depend on the state of an unrelated
    // local installation. Only inspect local config when it can affect target
    // selection.
    const shouldInspectLocalConfig = !flags.url;
    const hasLocalConfig = shouldInspectLocalConfig
      ? await access(getConfigPath()).then(
          () => true,
          () => false
        )
      : false;
    let localSelected = flags.local;
    const localConfig = hasLocalConfig ? await loadConfig() : null;
    let daemonUrl = flags.url
      ? normalizeHttpBaseUrl(flags.url, 'Daemon URL')
      : localConfig
        ? resolveDaemonUrl(localConfig)
        : '';
    if (!flags.url && !flags.local) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        this.error('Non-interactive login requires --url <daemon-url> or --local.');
      }
      const useLocal = hasLocalConfig
        ? (
            await inquirer.prompt<{ useLocal: boolean }>([
              {
                type: 'confirm',
                name: 'useLocal',
                default: true,
                message: `Local deployment detected at ${daemonUrl}. Use it?`,
              },
            ])
          ).useLocal
        : false;
      if (!useLocal) {
        const answer = await inquirer.prompt<{ url: string }>([
          {
            type: 'input',
            name: 'url',
            message: 'Daemon URL',
            validate: (value: string) => Boolean(value.trim()),
          },
        ]);
        daemonUrl = normalizeHttpBaseUrl(answer.url, 'Daemon URL');
      } else {
        localSelected = true;
      }
    }
    if (flags.local && !hasLocalConfig) this.error(`No local config found at ${getConfigPath()}.`);

    if (flags['api-key'] && !isLoopbackOrHttps(daemonUrl)) {
      this.error(
        `${chalk.red('✗ Refusing to send an API key over plain HTTP')}\n\nUse an https:// URL (or a localhost daemon).`
      );
    }

    // Check if daemon is running
    const probe = await probeAgorDaemon(daemonUrl);
    if (!probe.running) {
      this.error(
        localSelected
          ? `${chalk.red('✗ Local deployment is not reachable')}\n\nStart it with:\n  ${chalk.cyan('agor daemon start')}`
          : `${chalk.red('✗ Deployment is not reachable')}\n\nTarget: ${chalk.cyan(daemonUrl)}\nCheck the URL and confirm that the deployment is running.`
      );
    }
    if (!probe.deploymentId) {
      this.error(
        `The daemon at ${daemonUrl} does not expose a deployment ID and is incompatible with this CLI. Upgrade the daemon before logging in.`
      );
    }
    if (localSelected) {
      const localDeploymentId = requireDeploymentId(localConfig ?? (await loadConfig()));
      if (probe.deploymentId !== localDeploymentId) {
        this.error(
          `The daemon at ${daemonUrl} is deployment ${probe.deploymentId}, but the local config is ${localDeploymentId}. Refusing to log in as local.`
        );
      }
    }

    if (flags['api-key']) {
      await this.loginWithApiKey(daemonUrl, probe.deploymentId);
      return;
    }

    // Get credentials (prompt if not provided)
    let email = flags.email;
    let password = flags.password;

    if (!email || !password) {
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'email',
          message: 'Email',
          default: email,
          validate: (input: string) => {
            if (!input?.includes('@')) {
              return 'Please enter a valid email address';
            }
            return true;
          },
        },
        {
          type: 'password',
          name: 'password',
          message: 'Password',
          mask: '*',
          validate: (input: string) => {
            if (!input) {
              return 'Password is required';
            }
            return true;
          },
        },
      ]);

      email = answers.email;
      password = answers.password;
    }

    // Create REST-only client (prevents hanging)
    const client = await createRestClient(daemonUrl);

    try {
      this.log(chalk.dim('Authenticating...'));

      // Authenticate with local strategy
      const authResult = await client.authenticate({
        strategy: 'local',
        email,
        password,
      });

      if (!authResult.accessToken || !authResult.user) {
        this.error('Authentication failed - no token returned');
      }

      // Calculate token expiry (7 days from now, matching daemon config)
      const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;

      // Save token to disk
      await saveToken({
        version: 2,
        target: {
          url: normalizeHttpBaseUrl(daemonUrl, 'Daemon URL'),
          origin: new URL(daemonUrl).origin,
          deploymentId: probe.deploymentId,
        },
        accessToken: authResult.accessToken,
        user: {
          user_id: authResult.user.user_id,
          email: authResult.user.email,
          // biome-ignore lint/suspicious/noExplicitAny: AuthenticatedUser type doesn't include name, but it's returned
          name: (authResult.user as any).name,
          role: authResult.user.role || 'viewer',
        },
        expiresAt,
      });

      this.log('');
      this.log(chalk.green('✓ Logged in successfully'));
      this.log('');
      this.log(chalk.dim('User:'), chalk.cyan(authResult.user.email));
      // biome-ignore lint/suspicious/noExplicitAny: AuthenticatedUser type doesn't include name, but it's returned
      const userName = (authResult.user as any).name;
      if (userName) {
        this.log(chalk.dim('Name:'), userName);
      }
      this.log(chalk.dim('Role:'), authResult.user.role || 'viewer');
      this.log('');
      this.log(chalk.dim('Token saved to ~/.agor/cli-token'));
      this.log(chalk.dim('Token expires in 7 days'));
      this.log('');

      // Cleanup socket connection
      client.io.io.opts.reconnection = false;
      client.io.removeAllListeners();
      client.io.close();
      return;
    } catch (error) {
      // Cleanup socket connection
      client.io.io.opts.reconnection = false;
      client.io.removeAllListeners();
      client.io.close();

      const errorMessage = error instanceof Error ? error.message : String(error);

      if (errorMessage.includes('Invalid login') || errorMessage.includes('NotFound')) {
        this.error(chalk.red('✗ Invalid email or password'));
      }

      this.error(chalk.red(`✗ Authentication failed: ${errorMessage}`));
    }
  }

  /**
   * Validate a personal API key against the selected deployment and store it.
   *
   * The key is never exchanged for browser tokens: it is sent as a bearer on
   * every request, so deleting it in the UI revokes this CLI immediately. The
   * server binds the key to the workspace URL it was created in; the tenant
   * returned here is recorded for display only.
   */
  private async loginWithApiKey(daemonUrl: string, deploymentId: string): Promise<void> {
    const apiKey = await readApiKey();
    if (!apiKey.startsWith(API_KEY_PREFIX)) {
      this.error(
        `${chalk.red('✗ Invalid API key format')}\n\nPersonal API keys start with ${API_KEY_PREFIX}.`
      );
    }

    const client = await createRestClient(daemonUrl, apiKey);
    let me: ApiKeyIdentity;
    try {
      this.log(chalk.dim('Verifying API key...'));
      me = (await client.service('api/v1/user/me').find()) as unknown as ApiKeyIdentity;
    } catch (error) {
      const status = (error as { code?: unknown }).code;
      if (status === 401 || status === 403) {
        this.error(
          `${chalk.red('✗ API key rejected')}\n\nCheck that the key was created in the workspace at ${daemonUrl} and has not been deleted.`
        );
      }
      this.error(
        `${chalk.red('✗ Could not verify API key')}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!me?.user_id || !me.email) {
      this.error('Authentication failed - the daemon did not return the key owner');
    }

    const target = normalizeHttpBaseUrl(daemonUrl, 'Daemon URL');
    await saveToken({
      version: 3,
      kind: 'api-key',
      target: {
        url: target,
        origin: new URL(target).origin,
        deploymentId,
        ...(me.tenant_id ? { tenantId: me.tenant_id } : {}),
      },
      apiKey,
      user: {
        user_id: me.user_id,
        email: me.email,
        ...(me.name ? { name: me.name } : {}),
        role: me.role || 'viewer',
      },
    });

    this.log('');
    this.log(chalk.green('✓ Logged in with API key'));
    this.log('');
    this.log(chalk.dim('User:'), chalk.cyan(me.email));
    if (me.name) this.log(chalk.dim('Name:'), me.name);
    this.log(chalk.dim('Role:'), me.role || 'viewer');
    if (me.tenant_id) this.log(chalk.dim('Workspace:'), me.tenant_id);
    this.log('');
    this.log(chalk.dim('API key saved to ~/.agor/cli-token (mode 0600)'));
    this.log(chalk.dim('Delete the key in Settings → API Keys to revoke this login.'));
    this.log('');
  }
}

const API_KEY_PREFIX = 'agor_sk_';

interface ApiKeyIdentity {
  user_id: string;
  email: string;
  name?: string;
  role?: string;
  tenant_id?: string;
}

function isLoopbackOrHttps(url: string): boolean {
  const parsed = new URL(url);
  if (parsed.protocol === 'https:') return true;
  return ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
}

/** Masked prompt on a TTY; otherwise the whole of stdin (never argv). */
async function readApiKey(): Promise<string> {
  if (process.stdin.isTTY) {
    const { apiKey } = await inquirer.prompt<{ apiKey: string }>([
      {
        type: 'password',
        name: 'apiKey',
        message: 'API key',
        mask: '*',
        validate: (input: string) => (input.trim() ? true : 'API key is required'),
      },
    ]);
    return apiKey.trim();
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8').trim();
}
