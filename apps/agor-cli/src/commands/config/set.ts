/**
 * `agor config set <key> <value>` - Set configuration value
 */

import { setConfigValue } from '@agor/core/config';
import { Args, Command } from '@oclif/core';
import chalk from 'chalk';

export default class ConfigSet extends Command {
  static description = 'Set a configuration value';

  static examples = [
    '<%= config.bin %> <%= command.id %> daemon.port 4000',
    '<%= config.bin %> <%= command.id %> daemon.port 4000',
  ];

  static args = {
    key: Args.string({
      description: 'Configuration key in format: section.key (e.g., daemon.port)',
      required: true,
    }),
    value: Args.string({
      description: 'Value to set',
      required: true,
    }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(ConfigSet);
    const key = args.key as string;
    const rawValue = args.value as string;

    // Parse value to correct type (boolean, number, or string)
    let value: string | boolean | number = rawValue;

    // Convert boolean strings
    if (rawValue === 'true') {
      value = true;
    } else if (rawValue === 'false') {
      value = false;
    } else if (/^-?\d+$/.test(rawValue)) {
      // Convert integers
      value = Number.parseInt(rawValue, 10);
    } else if (/^-?\d+\.\d+$/.test(rawValue)) {
      // Convert floats
      value = Number.parseFloat(rawValue);
    }

    try {
      await setConfigValue(key, value);

      // Mask API keys in output
      const displayValue =
        (key.includes('API_KEY') || key.includes('TOKEN')) && typeof value === 'string'
          ? `${value.substring(0, 10)}...`
          : String(value);

      this.log(`${chalk.green('✓')} Set ${chalk.cyan(key)} = ${chalk.yellow(displayValue)}`);
    } catch (error) {
      this.error(`Failed to set config: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
