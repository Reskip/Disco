import {
  AGENTIC_TOOL_INTEGRATIONS,
  resolveAgenticToolSelectionPolicy,
  resolveManagedAgenticToolVersion,
} from '@disco/core/agentic-integrations';
import { loadConfig, resolveEffectiveConfig } from '@disco/core/config';
import { diagnoseGit } from '@disco/git';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { diagnoseAgenticTools } from '../lib/agentic-tool-diagnostics.js';
import { listManagedDiscoVersions } from '../lib/agentic-tool-integrations.js';
import { diagnoseSandbox, sandboxInstallHint } from '../lib/sandbox-diagnostics.js';

export default class Doctor extends Command {
  static description = 'Check the local Disco installation and its agentic tools';
  static flags = {
    json: Flags.boolean({ description: 'Print machine-readable JSON', default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Doctor);
    const discoVersion = resolveManagedAgenticToolVersion(this.config.version) as string;
    const git = await diagnoseGit();
    const agenticTools = await diagnoseAgenticTools(discoVersion);
    const staleVersions = (await listManagedDiscoVersions()).filter(
      (version) => version !== discoVersion
    );
    const cfg = await loadConfig();
    const policy = await resolveAgenticToolSelectionPolicy(cfg);
    // Effective config so the sandbox row reflects env overrides
    // (e.g. DISCO_SANDBOX_ENABLED from the `sandbox` .disco.yml variant), matching
    // what the daemon actually runs — not just the raw config.yaml.
    const sandbox = diagnoseSandbox(resolveEffectiveConfig(cfg));
    if (flags.json) {
      this.log(
        JSON.stringify(
          {
            ok: git.status === 'ready',
            git,
            policy,
            sandbox,
            staleVersions,
            agenticTools,
          },
          null,
          2
        )
      );
      return;
    }
    this.log(chalk.bold('Disco doctor\n'));
    this.log(`${chalk.green('✓')} Node.js ${process.version}`);
    this.log(`${chalk.green('✓')} Disco CLI is executable`);
    if (git.status === 'ready') {
      this.log(`${chalk.green('✓')} Git ${git.version} is executable (${git.binary})`);
    } else {
      this.log(`${chalk.red('✗')} ${git.detail}`);
    }
    this.log('');
    this.log(chalk.bold('Agentic tools'));
    this.log(`  Policy: ${policy.mode}; source: ${policy.source}`);
    const selected = new Set(policy.selected);
    for (const item of agenticTools) {
      const marker =
        item.status === 'ready'
          ? chalk.green('✓')
          : selected.has(item.id)
            ? chalk.red('✗')
            : chalk.dim('○');
      this.log(
        `  ${marker} ${AGENTIC_TOOL_INTEGRATIONS[item.id].displayName}: ${item.status}${selected.has(item.id) ? ' (selected)' : ''}`
      );
      if (item.detail && selected.has(item.id)) this.log(chalk.dim(`      ${item.detail}`));
    }
    this.log('');
    this.log(chalk.bold('Executor sandbox (SRT)'));
    if (!sandbox.enabled) {
      this.log(
        chalk.dim(
          '  ○ Disabled (execution.sandbox.enabled: false). Agents have open filesystem access.'
        )
      );
    } else if (!sandbox.supported) {
      this.log(
        chalk.red(`  ✗ Enabled but unsupported on ${sandbox.platform} (SRT needs Linux or macOS).`)
      );
    } else {
      for (const dep of sandbox.deps) {
        const marker = dep.present ? chalk.green('✓') : chalk.red('✗');
        const label = dep.note ? `${dep.name} (${dep.note})` : dep.name;
        this.log(`  ${marker} ${label}${dep.present ? '' : ' — MISSING'}`);
      }
      this.log(
        sandbox.ok
          ? chalk.green('  ✓ Sandbox enabled and ready')
          : chalk.red('  ✗ Sandbox enabled but dependencies are missing')
      );
      if (!sandbox.ok) {
        const hint = sandboxInstallHint(sandbox.platform);
        if (hint) this.log(chalk.dim(`      ${hint}`));
      }
    }

    if (staleVersions.length > 0)
      this.log(chalk.yellow(`\n  Stale Disco versions: ${staleVersions.join(', ')}`));
    if (policy.source === 'missing-manifest')
      this.log(chalk.yellow('\n  No local selection manifest. Run interactive `disco install`.'));
    else this.log(chalk.dim('\n  Repair without changing selection: disco install --sync'));
  }
}
