import { loadConfig } from '@agor/core/config';
import { AGOR_TELEMETRY_DOCS_URL } from '@agor/core/telemetry';
import { Command } from '@oclif/core';
import chalk from 'chalk';

export default class Telemetry extends Command {
  static description = 'Show Agor community telemetry status';

  async run(): Promise<void> {
    await this.parse(Telemetry);
    const config = await loadConfig();
    const enabled = config.telemetry?.enabled === true;
    const configured = config.telemetry?.enabled !== undefined;

    this.log(chalk.bold('Agor community telemetry'));
    const status = enabled
      ? chalk.green('enabled')
      : chalk.yellow(configured ? 'disabled' : 'not configured');
    this.log(`Status: ${status}`);
    this.log(`Docs:   ${AGOR_TELEMETRY_DOCS_URL}`);
    this.log('');
    this.log('Commands:');
    this.log('  agor telemetry on');
    this.log('  agor telemetry off');
    this.log('  agor telemetry test');
  }
}

export async function setTelemetryEnabled(enabled: boolean): Promise<void> {
  throw new Error(
    `Telemetry was not changed. Set AGOR_TELEMETRY=${enabled ? '1' : '0'} in the deployment environment, or edit telemetry.enabled in config.yaml through your config-management workflow and restart Agor.`
  );
}
