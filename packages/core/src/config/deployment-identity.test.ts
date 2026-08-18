import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateConfigDeploymentId, requireDeploymentId } from './config-manager';

describe('deployment identity', () => {
  it('requires a valid UUID', () => {
    expect(() => requireDeploymentId({ daemon: { port: 3030 } })).toThrow('daemon.deployment_id');
    expect(() => requireDeploymentId({ daemon: { deployment_id: 'not-a-uuid' } })).toThrow(
      'valid UUID'
    );
    expect(
      requireDeploymentId({ daemon: { deployment_id: '019c1234-5678-7123-8123-123456789abc' } })
    ).toBe('019c1234-5678-7123-8123-123456789abc');
  });

  it('backs up and explicitly rewrites a legacy config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agor-deployment-id-'));
    const path = join(dir, 'config.yaml');
    await writeFile(path, '# operator comment\ndaemon:\n  port: 4040\n', 'utf8');
    const deploymentId = '019c1234-5678-7123-8123-123456789abc';

    const result = await migrateConfigDeploymentId(path, deploymentId);

    expect(result.deploymentId).toBe(deploymentId);
    expect(await readFile(result.backupPath, 'utf8')).toContain('# operator comment');
    expect(await readFile(path, 'utf8')).toContain(`deployment_id: ${deploymentId}`);
  });
});
