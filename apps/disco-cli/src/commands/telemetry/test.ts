import { platform } from 'node:os';
import { loadConfig } from '@disco/core/config';
import {
  createOpenSourceTelemetryLogger,
  generateTelemetryInstanceId,
  isTelemetryFullyDisabledByEnv,
  loadOpenSourceTelemetryDiscoVersion,
} from '@disco/core/telemetry';
import { Command } from '@oclif/core';
import chalk from 'chalk';

export default class TelemetryTest extends Command {
  static description = 'Send a one-off community telemetry test event';

  async run(): Promise<void> {
    await this.parse(TelemetryTest);

    if (isTelemetryFullyDisabledByEnv()) {
      this.error('Community telemetry is fully disabled by DISCO_TELEMETRY=0 or DO_NOT_TRACK=1', {
        exit: 2,
      });
    }

    const config = await loadConfig();
    if (config.telemetry?.enabled !== true) {
      this.error(
        'Community telemetry is disabled. Set DISCO_TELEMETRY=1 or telemetry.enabled: true and restart first.',
        {
          exit: 2,
        }
      );
    }

    if (!config.telemetry.instance_id) {
      config.telemetry.instance_id = generateTelemetryInstanceId();
    }

    const logger = createOpenSourceTelemetryLogger(config);
    if (!logger.isEnabled()) {
      this.error('Community telemetry is not configured with a valid destination.', {
        exit: 2,
      });
    }

    logger.track({
      event: 'telemetry.test',
      properties: {
        disco_version: await loadOpenSourceTelemetryDiscoVersion(
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
