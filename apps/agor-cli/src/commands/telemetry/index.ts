import { loadConfig, saveConfig } from '@agor/core/config';
import {
  AGOR_TELEMETRY_DOCS_URL,
  generateTelemetryInstanceId,
  pruneDefaultOpenSourceTelemetryDestination,
} from '@agor/core/telemetry';
import { Command } from '@oclif/core';
import chalk from 'chalk';

export default class Telemetry extends Command {
  static description = 'Show Agor open-source telemetry status';

  async run(): Promise<void> {
    await this.parse(Telemetry);
    const config = await loadConfig();
    const enabled = config.telemetry?.enabled === true;
    const configured = config.telemetry?.enabled !== undefined;

    this.log(chalk.bold('Agor open-source telemetry'));
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
  const config = await loadConfig();
  config.telemetry = {
    ...config.telemetry,
    enabled,
    instance_id:
      config.telemetry?.instance_id ?? (enabled ? generateTelemetryInstanceId() : undefined),
  };
  await saveConfig(pruneDefaultOpenSourceTelemetryDestination(config));
}
