import { loadConfig } from '@disco/core/config';
import { DISCO_TELEMETRY_DOCS_URL } from '@disco/core/telemetry';
import { Command } from '@oclif/core';
import chalk from 'chalk';

export default class Telemetry extends Command {
  static description = 'Show Disco community telemetry status';

  async run(): Promise<void> {
    await this.parse(Telemetry);
    const config = await loadConfig();
    const enabled = config.telemetry?.enabled === true;
    const configured = config.telemetry?.enabled !== undefined;

    this.log(chalk.bold('Disco community telemetry'));
    const status = enabled
      ? chalk.green('enabled')
      : chalk.yellow(configured ? 'disabled' : 'not configured');
    this.log(`Status: ${status}`);
    this.log(`Docs:   ${DISCO_TELEMETRY_DOCS_URL}`);
    this.log('');
    this.log('Configure with DISCO_TELEMETRY=1/0 or telemetry.enabled in config.yaml.');
    this.log('Test delivery with: disco telemetry test');
  }
}

export async function setTelemetryEnabled(enabled: boolean): Promise<void> {
  throw new Error(
    `Telemetry was not changed. Set DISCO_TELEMETRY=${enabled ? '1' : '0'} in the deployment environment, or edit telemetry.enabled in config.yaml through your config-management workflow and restart Disco.`
  );
}
