import { Command } from '@oclif/core';
import chalk from 'chalk';
import { setTelemetryEnabled } from './index.js';

export default class TelemetryOff extends Command {
  static description = 'Disable Agor community telemetry';

  async run(): Promise<void> {
    await this.parse(TelemetryOff);
    await setTelemetryEnabled(false);
    this.log(chalk.green('✓ Agor community telemetry disabled'));
  }
}
