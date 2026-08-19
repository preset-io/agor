import inquirer from 'inquirer';
import { probeAgorDaemon } from './daemon-probe.js';

/**
 * Last-resort upgrade bridge for daemons from before managed instance IDs.
 * Never signals solely because a port responds: the operator must explicitly
 * accept the PID after Agor health has been established at the expected URL.
 */
export async function confirmLegacyManagedDaemonStop(
  pid: number,
  daemonUrl: string
): Promise<void> {
  const probe = await probeAgorDaemon(daemonUrl);
  if (!probe.running) {
    throw new Error(
      `Refusing to signal legacy PID ${pid}: no Agor daemon was found at ${daemonUrl}. Inspect the PID manually.`
    );
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      `PID ${pid} predates daemon ownership records and cannot be verified automatically. Re-run interactively after inspecting the process.`
    );
  }
  const { stop } = await inquirer.prompt<{ stop: boolean }>([
    {
      type: 'confirm',
      name: 'stop',
      default: false,
      message: `Legacy Agor daemon detected at ${daemonUrl}. Stop PID ${pid}? Confirm only after verifying this process belongs to Agor.`,
    },
  ]);
  if (!stop) throw new Error(`Refusing to signal unverified legacy PID ${pid}.`);
}
