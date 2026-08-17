/**
 * Base Command - Shared logic for all Agor CLI commands
 *
 * Reduces boilerplate by providing common functionality like daemon connection checking.
 */

import type { AgorClient } from '@agor-live/client';
import { createRestClient, getApiKeyFromEnv } from '@agor-live/client';
import { Command } from '@oclif/core';
import chalk from 'chalk';
import { loadToken } from './lib/auth';
import { probeAgorDaemon } from './lib/daemon-probe.js';

/**
 * Base command with daemon connection utilities
 */
export abstract class BaseCommand extends Command {
  protected daemonUrl: string | null = null;

  /**
   * Connect to daemon (checks if running first)
   *
   * @returns Feathers client instance
   */
  protected async connectToDaemon(): Promise<AgorClient> {
    const storedAuth = await loadToken();
    const apiKey = getApiKeyFromEnv();
    if (!storedAuth && !apiKey) {
      this.error(
        chalk.red('✗ Not authenticated') +
          '\n\n' +
          chalk.dim('Run:') +
          '\n  ' +
          chalk.cyan('agor login --url <daemon-url>')
      );
    }
    const environmentTarget =
      apiKey && process.env.DAEMON_URL && process.env.AGOR_DEPLOYMENT_ID
        ? {
            url: process.env.DAEMON_URL.replace(/\/$/, ''),
            origin: new URL(process.env.DAEMON_URL).origin,
            deploymentId: process.env.AGOR_DEPLOYMENT_ID,
          }
        : null;
    const target = apiKey ? environmentTarget : storedAuth?.target;
    if (!target) {
      this.error('Environment API-key authentication requires DAEMON_URL and AGOR_DEPLOYMENT_ID.');
    }
    const daemonUrl = target.url;
    this.daemonUrl = daemonUrl;
    const probe = await probeAgorDaemon(daemonUrl);

    if (!probe.running) {
      this.log(
        chalk.red('✗ Daemon not running') +
          '\n\n' +
          chalk.bold('To start the daemon:') +
          '\n  ' +
          chalk.cyan('cd apps/agor-daemon && pnpm dev') +
          '\n\n' +
          chalk.bold('To configure daemon URL:') +
          '\n  ' +
          chalk.cyan('set DAEMON_URL=<url>, or edit ~/.agor/config.yaml') +
          '\n  ' +
          chalk.gray(`Current: ${this.daemonUrl}`)
      );
      this.exit(1);
    }

    // Check for API key auth (takes precedence over stored JWT)
    if (probe.deploymentId !== target.deploymentId) {
      this.error(
        `The daemon identity at ${daemonUrl} changed. Run agor login --url ${daemonUrl} again.`
      );
    }
    if (apiKey) {
      return await createRestClient(daemonUrl, apiKey ?? undefined);
    }

    // Create REST-only client (prevents hanging processes)
    const client = await createRestClient(daemonUrl);

    // Load stored authentication token
    try {
      await client.authenticate({
        strategy: 'jwt',
        accessToken: storedAuth!.accessToken,
      });
    } catch (_error) {
      // Token invalid or expired - clear it and show login prompt
      const { clearToken } = await import('./lib/auth');
      await clearToken();
      this.error(
        chalk.red('✗ Authentication failed') +
          '\n\n' +
          chalk.dim('Your session has expired or is invalid.') +
          '\n' +
          chalk.dim('Please login again:') +
          '\n  ' +
          chalk.cyan('agor login')
      );
    }

    return client;
  }

  /**
   * Cleanup client connection
   *
   * Ensures socket is properly closed to prevent hanging processes
   */
  protected async cleanupClient(client: AgorClient): Promise<void> {
    // Disable reconnection before closing to prevent new connection attempts
    client.io.io.opts.reconnection = false;

    // Remove all event listeners to prevent them from keeping process alive
    client.io.removeAllListeners();

    // Close the socket connection
    client.io.close();

    // Give a brief moment for cleanup, then force exit
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}
