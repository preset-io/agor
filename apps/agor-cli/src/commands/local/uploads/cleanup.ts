import { pathToFileURL } from 'node:url';
import { loadConfig } from '@agor/core/config';
import { createDatabase, getDatabaseUrl } from '@agor/core/db';
import { Command, Flags } from '@oclif/core';
import { getDaemonUploadsMaintenanceModulePath, isInstalledPackage } from '../../../lib/context.js';

async function loadCleanup(): Promise<
  typeof import('@agor/daemon/uploads-maintenance').cleanupExpiredUploads
> {
  if (!isInstalledPackage()) {
    return (await import('@agor/daemon/uploads-maintenance')).cleanupExpiredUploads;
  }
  const modulePath = getDaemonUploadsMaintenanceModulePath();
  if (!modulePath) throw new Error('Failed to locate bundled upload maintenance module');
  return (
    (await import(
      pathToFileURL(modulePath).href
    )) as typeof import('@agor/daemon/uploads-maintenance')
  ).cleanupExpiredUploads;
}

export default class LocalUploadsCleanup extends Command {
  static override summary = 'Delete expired local upload data';
  static override description =
    'Delete expired upload metadata and exact storage objects using deployment-local credentials';

  static override examples = [
    '<%= config.bin %> <%= command.id %> --dry-run',
    '<%= config.bin %> <%= command.id %> --tenant-id acme --limit 500',
    '<%= config.bin %> <%= command.id %> --all-tenants --limit 500',
  ];

  static override flags = {
    'tenant-id': Flags.string({
      description: 'Clean one tenant (required in multi-tenant mode unless --all-tenants is used)',
    }),
    'all-tenants': Flags.boolean({
      description: 'Discover and clean tenants with expired uploads (PostgreSQL only)',
      default: false,
    }),
    limit: Flags.integer({
      description: 'Maximum expired uploads to process in this invocation',
      default: 500,
      min: 1,
      max: 10_000,
    }),
    'dry-run': Flags.boolean({
      char: 'n',
      description: 'Report expired uploads without deleting metadata or bytes',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(LocalUploadsCleanup);
    try {
      const cleanupExpiredUploads = await loadCleanup();
      const result = await cleanupExpiredUploads({
        db: createDatabase({ url: getDatabaseUrl() }),
        config: await loadConfig(),
        tenantId: flags['tenant-id'],
        allTenants: flags['all-tenants'],
        limit: flags.limit,
        dryRun: flags['dry-run'],
      });
      await new Promise<void>((resolve, reject) => {
        process.stdout.write(`${JSON.stringify(result)}\n`, (error) =>
          error ? reject(error) : resolve()
        );
      });
      process.exit(result.failed > 0 ? 1 : 0);
    } catch (error) {
      this.error(error instanceof Error ? error.message : String(error));
    }
  }
}
