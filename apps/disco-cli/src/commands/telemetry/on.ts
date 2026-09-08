import { DISCO_TELEMETRY_DOCS_URL } from '@disco/core/telemetry';
import { Command } from '@oclif/core';
import chalk from 'chalk';
import { setTelemetryEnabled } from './index.js';

export default class TelemetryOn extends Command {
  static description = 'Enable Disco community telemetry';

  async run(): Promise<void> {
    await this.parse(TelemetryOn);
    await setTelemetryEnabled(true);
    this.log(chalk.green('✓ Disco community telemetry enabled'));
    this.log(chalk.gray(`Learn more: ${DISCO_TELEMETRY_DOCS_URL}`));
  }
}
