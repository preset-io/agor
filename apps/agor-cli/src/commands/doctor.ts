import {
  AGENTIC_TOOL_INTEGRATIONS,
  resolveAgenticToolSelectionPolicy,
  resolveManagedAgenticToolVersion,
} from '@agor/core/agentic-integrations';
import {
  getConfigPath,
  loadConfig,
  requireDeploymentId,
  resolveEffectiveConfig,
} from '@agor/core/config';
import { diagnoseGit } from '@agor/git';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { diagnoseAgenticTools } from '../lib/agentic-tool-diagnostics.js';
import { listManagedAgorVersions } from '../lib/agentic-tool-integrations.js';
import {
  describeMissingDeploymentId,
  isMissingDeploymentIdError,
  repairDeploymentId,
} from '../lib/daemon-deployment-config.js';
import { diagnoseWebTerminalRuntime } from '../lib/optional-capabilities.js';
import { diagnoseSandbox, sandboxInstallHint } from '../lib/sandbox-diagnostics.js';

export default class Doctor extends Command {
  static description = 'Check the local Agor installation and its agentic tools';
  static flags = {
    json: Flags.boolean({ description: 'Print machine-readable JSON', default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Doctor);
    const agorVersion = resolveManagedAgenticToolVersion(this.config.version) as string;
    const git = await diagnoseGit();
    const webTerminal = await diagnoseWebTerminalRuntime();
    const agenticTools = await diagnoseAgenticTools(agorVersion);
    const staleVersions = (await listManagedAgorVersions()).filter(
      (version) => version !== agorVersion
    );
    const cfg = await loadConfig();
    const policy = await resolveAgenticToolSelectionPolicy(cfg);
    // Effective config so the sandbox row reflects env overrides
    // (e.g. AGOR_SANDBOX_ENABLED from the `sandbox` .agor.yml variant), matching
    // what the daemon actually runs — not just the raw config.yaml.
    const sandbox = diagnoseSandbox(resolveEffectiveConfig(cfg));

    // `daemon start` refuses to run without this and sends people here, so doctor
    // has to both report it and be able to fix it.
    let deploymentIdPresent = true;
    try {
      requireDeploymentId(cfg);
    } catch (error) {
      if (!isMissingDeploymentIdError(error)) throw error;
      deploymentIdPresent = false;
    }

    if (flags.json) {
      this.log(
        JSON.stringify(
          {
            ok: git.status === 'ready' && deploymentIdPresent,
            git,
            deploymentId: { present: deploymentIdPresent, configPath: getConfigPath() },
            optionalCapabilities: { webTerminal },
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
    this.log(chalk.bold('Agor doctor\n'));
    this.log(`${chalk.green('✓')} Node.js ${process.version}`);
    this.log(`${chalk.green('✓')} Agor CLI is executable`);
    if (git.status === 'ready') {
      this.log(`${chalk.green('✓')} Git ${git.version} is executable (${git.binary})`);
    } else {
      this.log(`${chalk.red('✗')} ${git.detail}`);
    }

    if (deploymentIdPresent) {
      this.log(`${chalk.green('✓')} Deployment ID is set`);
    } else {
      this.log(`${chalk.red('✗')} daemon.deployment_id is missing — the daemon will not start`);
      const repaired = await repairDeploymentId().catch((error: unknown) => {
        this.log('');
        this.log(error instanceof Error ? error.message : String(error));
        return null;
      });
      if (repaired) {
        this.log(`  ${chalk.green('✓')} Wrote deployment_id: ${repaired.deploymentId}`);
        this.log(chalk.dim(`      Backup: ${repaired.backupPath}`));
      } else {
        this.log('');
        this.log(describeMissingDeploymentId(getConfigPath()));
      }
    }

    this.log('');
    this.log(chalk.bold('Optional capabilities'));
    if (webTerminal.status === 'ready') {
      this.log(`  ${chalk.green('✓')} Web terminal runtime: ready`);
    } else {
      this.log(`  ${chalk.yellow('○')} Web terminal runtime: unavailable (optional)`);
      if (webTerminal.detail) this.log(chalk.dim(`      ${webTerminal.detail}`));
      this.log(chalk.dim(`      ${webTerminal.docs}`));
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
      this.log(chalk.yellow(`\n  Stale Agor versions: ${staleVersions.join(', ')}`));
    if (policy.source === 'missing-manifest')
      this.log(chalk.yellow('\n  No local selection manifest. Run interactive `agor install`.'));
    else this.log(chalk.dim('\n  Repair without changing selection: agor install --sync'));
  }
}
