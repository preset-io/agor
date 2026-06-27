import { AGOR_TELEMETRY_DOCS_URL } from '@agor/core/telemetry';
import { Command } from '@oclif/core';
import chalk from 'chalk';
import { setTelemetryEnabled } from './index.js';

export default class TelemetryOn extends Command {
  static description = 'Enable Agor open-source telemetry';

  async run(): Promise<void> {
    await this.parse(TelemetryOn);
    await setTelemetryEnabled(true);
    this.log(chalk.green('✓ Agor open-source telemetry enabled'));
    this.log(chalk.gray(`Learn more: ${AGOR_TELEMETRY_DOCS_URL}`));
  }
}
