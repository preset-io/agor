/**
 * `agor config get <key>` - Get specific config value
 */

import { getConfigValue } from '@agor/core/config';
import { Args, Command } from '@oclif/core';

export default class ConfigGet extends Command {
  static description = 'Get a configuration value';

  static examples = [
    '<%= config.bin %> <%= command.id %> defaults.board',
    '<%= config.bin %> <%= command.id %> defaults.agent',
    '<%= config.bin %> <%= command.id %> daemon.port',
  ];

  static args = {
    key: Args.string({
      description: 'Configuration key in format: section.key (e.g., daemon.port)',
      required: true,
    }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(ConfigGet);
    const key = args.key;

    try {
      const value = await getConfigValue(key);

      if (value !== undefined) {
        this.log(String(value));
      } else {
        // No value set - exit with code 1 (useful for scripting)
        process.exit(1);
      }
    } catch (error) {
      this.error(`Failed to get config: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
