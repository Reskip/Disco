import {
  assertManagedAgenticToolInstallReady,
  getAgenticToolInstallDir,
  type InstallableAgenticTool,
  InvalidAgenticToolSelectionManifestError,
  resolveAgenticToolSelectionPolicy,
  resolveManagedAgenticToolVersion,
} from '@disco/core/agentic-integrations';
import type { DiscoConfig } from '@disco/core/config';
import { loadConfig } from '@disco/core/config';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import inquirer from 'inquirer';
import {
  AGENTIC_TOOL_INTEGRATIONS,
  acquireAgenticToolInstallLock,
  installManagedIntegration,
  listManagedDiscoVersions,
  listManagedToolDirectories,
  readManagedIntegrationManifest,
  removeManagedDiscoVersion,
  removeManagedInstallDebris,
  removeManagedIntegration,
  repairManagedIntegrationPermissions,
  validateInteractiveAgenticToolSelection,
  writeAgenticToolSelectionManifest,
} from '../lib/agentic-tool-integrations.js';

export default class Install extends Command {
  static description = 'Select or reconcile agentic tool packages in the local installation';
  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --sync',
  ];
  static flags = {
    sync: Flags.boolean({
      description: 'Reconcile noninteractively without changing the selection',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Install);
    const releaseLock = await acquireAgenticToolInstallLock();
    try {
      await this.reconcile(flags.sync);
    } finally {
      await releaseLock();
    }
  }

  private async reconcile(sync: boolean): Promise<void> {
    const discoVersion = resolveManagedAgenticToolVersion(this.config.version) as string;
    const config = await loadConfig();
    let policy = await resolveInstallSelectionPolicy(config, sync);
    if (policy.mode === 'local-managed' && sync && policy.source === 'missing-manifest') {
      this.error(
        'No locally managed agentic-tool selection exists. Run interactive `disco install` once to choose tools; no packages were changed. For Docker/Kubernetes, declare agentic_tools.installed in config.yaml.'
      );
    }
    if (policy.mode === 'local-managed' && !sync) {
      this.log(chalk.dim('Use ↑/↓ to move, Space to select, and Enter to continue.'));
      const previouslySelected = new Set<InstallableAgenticTool>(
        policy.selected as readonly InstallableAgenticTool[]
      );
      const { selected } = await inquirer.prompt<{ selected: InstallableAgenticTool[] }>([
        {
          type: 'checkbox',
          name: 'selected',
          message: 'Which agentic tools should this deployment support?',
          choices: Object.entries(AGENTIC_TOOL_INTEGRATIONS).map(([value, definition]) => ({
            name: `${definition.displayName} (${definition.packageName}@${discoVersion})`,
            value,
            checked: previouslySelected.has(value as InstallableAgenticTool),
          })),
          validate: validateInteractiveAgenticToolSelection,
        },
      ]);
      await writeAgenticToolSelectionManifest(selected);
      policy = { mode: 'local-managed', selected, source: 'manifest' };
    }
    const configured: readonly InstallableAgenticTool[] = policy.selected;

    this.log(chalk.bold(`Agentic tool package alignment for Disco ${discoVersion}`));
    this.log(
      `Policy: ${policy.mode === 'declarative' ? 'declarative config.yaml' : 'locally managed manifest'}`
    );
    this.log(
      configured.length > 0
        ? `Configured: ${configured.join(', ')}`
        : 'Configured: none (all managed agentic tool packages will be removed)'
    );

    for (const tool of configured) {
      const definition = AGENTIC_TOOL_INTEGRATIONS[tool];
      await repairManagedIntegrationPermissions(tool, discoVersion);
      if (await this.isAligned(tool, discoVersion)) {
        this.log(chalk.green(`✓ ${definition.displayName} is already aligned`));
        continue;
      }
      this.log(chalk.bold(`Installing ${definition.displayName}@${discoVersion}…`));
      await installManagedIntegration(tool, discoVersion);
      this.log(chalk.green(`✓ ${definition.displayName} installed`));
    }

    const installed = await listManagedToolDirectories(discoVersion);
    for (const tool of installed) {
      if (configured.includes(tool)) continue;
      await removeManagedIntegration(tool, discoVersion);
      this.log(
        chalk.green(`✓ Removed unconfigured ${AGENTIC_TOOL_INTEGRATIONS[tool].displayName}`)
      );
    }

    for (const version of await listManagedDiscoVersions()) {
      if (version === discoVersion) continue;
      await removeManagedDiscoVersion(version);
      this.log(chalk.green(`✓ Removed managed tools for stale Disco ${version}`));
    }

    const debris = await removeManagedInstallDebris(discoVersion);
    if (debris.length > 0)
      this.log(chalk.green(`✓ Removed ${debris.length} interrupted install(s)`));
    this.log(chalk.green.bold('Agentic tool packages are aligned.'));
  }

  private async isAligned(tool: InstallableAgenticTool, version: string): Promise<boolean> {
    const manifest = await readManagedIntegrationManifest(tool, version);
    if (!manifest) return false;
    try {
      await assertManagedAgenticToolInstallReady(
        tool,
        version,
        getAgenticToolInstallDir(tool, version)
      );
      return true;
    } catch {
      return false;
    }
  }
}

export async function resolveInstallSelectionPolicy(config: DiscoConfig, sync: boolean) {
  try {
    return await resolveAgenticToolSelectionPolicy(config);
  } catch (error) {
    if (!sync && error instanceof InvalidAgenticToolSelectionManifestError) {
      return {
        mode: 'local-managed',
        selected: [] as InstallableAgenticTool[],
        source: 'missing-manifest' as const,
      };
    }
    throw error;
  }
}
