import { platform } from 'node:os';
import { loadConfig, saveConfig } from '@agor/core/config';
import {
  createOpenSourceTelemetryLogger,
  generateTelemetryInstanceId,
  isTelemetryFullyDisabledByEnv,
  loadOpenSourceTelemetryAgorVersion,
  pruneDefaultOpenSourceTelemetryDestination,
} from '@agor/core/telemetry';
import { Command } from '@oclif/core';
import chalk from 'chalk';

export default class TelemetryTest extends Command {
  static description = 'Send a one-off open-source telemetry test event';

  async run(): Promise<void> {
    await this.parse(TelemetryTest);

    if (isTelemetryFullyDisabledByEnv()) {
      this.error('Open-source telemetry is fully disabled by AGOR_TELEMETRY=0 or DO_NOT_TRACK=1', {
        exit: 2,
      });
    }

    const config = await loadConfig();
    if (config.telemetry?.enabled !== true) {
      this.error('Open-source telemetry is disabled. Run `agor telemetry on` first.', {
        exit: 2,
      });
    }

    if (!config.telemetry.instance_id) {
      config.telemetry.instance_id = generateTelemetryInstanceId();
      await saveConfig(pruneDefaultOpenSourceTelemetryDestination(config));
    }

    const logger = createOpenSourceTelemetryLogger(config);
    if (!logger.isEnabled()) {
      this.error('Open-source telemetry is not configured with a valid destination.', {
        exit: 2,
      });
    }

    logger.track({
      event: 'telemetry.test',
      properties: {
        agor_version: await loadOpenSourceTelemetryAgorVersion(
          this.config.version,
          import.meta.url
        ),
        source: 'cli',
        os_family: platform(),
        node_major: Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10),
      },
    });
    await logger.flush();

    this.log(chalk.green('✓ Sent telemetry.test'));
  }
}
