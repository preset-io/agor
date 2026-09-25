/**
 * `agor login` - Authenticate with daemon
 *
 * Prompts for email/password and stores JWT token for future CLI commands
 */

import { access } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import {
  getConfigPath,
  loadConfig,
  requireDeploymentId,
  resolveDaemonUrl,
} from '@agor/core/config';
import {
  type CurrentUserIdentity,
  isUserApiKeySource,
  PERSONAL_API_KEY_PREFIX,
  USER_IDENTITY_SERVICE_PATH,
} from '@agor/core/types';
import { normalizeHttpBaseUrl } from '@agor/core/utils/url';
import { createRestClient } from '@agor-live/client';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { saveToken } from '../lib/auth';
import { openInBrowser } from '../lib/browser';
import { cliKeyName, cliLoginPageUrl } from '../lib/cli-login';
import { getUIUrl } from '../lib/context';
import { probeAgorDaemon } from '../lib/daemon-probe';

export default class Login extends Command {
  static description = 'Select and authenticate with a deployment';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --email user@example.com',
    '<%= config.bin %> <%= command.id %> --url https://my-workspace.example.com',
    '<%= config.bin %> <%= command.id %> --url https://my-workspace.example.com --web',
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
    web: Flags.boolean({
      description:
        'Sign in through the browser: approve a key for this machine and paste it back. Default for deployments without password login (Google/SSO).',
      exclusive: ['email', 'password', 'api-key'],
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

    if ((flags['api-key'] || flags.web) && !isLoopbackOrHttps(daemonUrl)) {
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
      await this.loginWithApiKey(daemonUrl, probe.deploymentId, await readApiKey());
      return;
    }
    // Deployments without password login (Agor Cloud's Google/SSO launch)
    // default to the browser flow unless the caller asked for a password.
    const useWeb = flags.web || (!flags.email && !flags.password && probe.localAuth === 'disabled');
    if (useWeb) {
      if (!isLoopbackOrHttps(daemonUrl)) {
        this.error(
          `${chalk.red('✗ Refusing to send an API key over plain HTTP')}\n\nUse an https:// URL (or a localhost daemon).`
        );
      }
      await this.loginWithBrowser(daemonUrl, probe.deploymentId, Boolean(localSelected));
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
   * Browser step: open the workspace's `/cli-login` page, where the signed-in
   * user explicitly creates a key tagged for this machine (replacing this
   * machine's previous one), then paste it here. Signed-out users go through the
   * deployment's normal sign-in and are returned to the same page.
   */
  private async loginWithBrowser(
    daemonUrl: string,
    deploymentId: string,
    localDevelopmentTarget: boolean
  ): Promise<void> {
    const pageUrl = cliLoginPageUrl(
      getUIUrl(daemonUrl, localDevelopmentTarget),
      await cliKeyName()
    );
    this.log('');
    this.log('To sign in, open this page, click Create CLI key, then paste the key here:');
    this.log(`  ${chalk.cyan(pageUrl)}`);
    this.log('');
    if (process.stdin.isTTY && (await openInBrowser(pageUrl))) {
      this.log(chalk.dim('Opened in your browser.'));
    }
    await this.loginWithApiKey(daemonUrl, deploymentId, await readApiKey());
  }

  /**
   * Validate a personal API key against the selected deployment and store it.
   *
   * The key is never exchanged for browser tokens: it is sent as a bearer on
   * every request, so deleting it in the UI revokes this CLI immediately. The
   * server binds the key to the workspace URL it was created in; the tenant
   * returned here is recorded for display only.
   */
  private async loginWithApiKey(
    daemonUrl: string,
    deploymentId: string,
    apiKey: string
  ): Promise<void> {
    if (!apiKey.startsWith(PERSONAL_API_KEY_PREFIX)) {
      this.error(
        `${chalk.red('✗ Invalid API key format')}\n\nPersonal API keys start with ${PERSONAL_API_KEY_PREFIX}.`
      );
    }

    const client = await createRestClient(daemonUrl, apiKey);
    let me: CurrentUserIdentity;
    try {
      this.log(chalk.dim('Verifying API key...'));
      me = (await client
        .service(USER_IDENTITY_SERVICE_PATH)
        .find()) as unknown as CurrentUserIdentity;
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
      ...(me.api_key_id ? { apiKeyId: me.api_key_id } : {}),
      ...(isUserApiKeySource(me.api_key_source) ? { apiKeySource: me.api_key_source } : {}),
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
    this.log(
      chalk.dim(
        me.api_key_source === 'cli_login'
          ? 'Run agor logout to sign out and delete this key, or delete it in User settings → API tokens.'
          : 'Delete the key in User settings → API tokens to revoke this login.'
      )
    );
    this.log('');
  }
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
        message: 'Paste your API key',
        mask: '*',
        validate: (input: string) => (input.trim() ? true : 'API key is required'),
      },
    ]);
    return apiKey.trim();
  }
  // Piped or non-TTY input: the key is the first non-empty line, so a paste
  // followed by Enter works without Ctrl-D.
  const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of lines) {
      if (line.trim()) return line.trim();
    }
    return '';
  } finally {
    lines.close();
  }
}
