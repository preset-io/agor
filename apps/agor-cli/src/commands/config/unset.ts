/**
 * `agor config unset <key>` - Unset (clear) configuration value
 */

import { unsetConfigValue } from '@agor/core/config';
import { Args, Command } from '@oclif/core';
import chalk from 'chalk';

export default class ConfigUnset extends Command {
  static description = 'Unset (clear) a configuration value';

  static examples = ['<%= config.bin %> <%= command.id %> daemon.port'];

  static args = {
    key: Args.string({
      description: 'Configuration key in format: section.key (e.g., daemon.port)',
      required: true,
    }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(ConfigUnset);
    const key = args.key;

    try {
      await unsetConfigValue(key);
      this.log(`${chalk.green('✓')} Unset ${chalk.cyan(key)}`);
    } catch (error) {
      this.error(
        `Failed to unset config: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
