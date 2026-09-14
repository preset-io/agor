import { RepoRepository } from '@agor/core/db';
import { feathers } from '@agor/core/feathers';
import type { Application, AuthenticatedParams, RepoEnvironment } from '@agor/core/types';
import { expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { requireAdminForEnvConfig } from '../utils/authorization';
import { ReposService } from './repos';

dbTest(
  'YAML Save replaces configuration through the real repo service without changing other metadata',
  async ({ db }) => {
    const repository = new RepoRepository(db);
    const repo = await repository.create({
      slug: 'yaml-save',
      name: 'YAML Save',
      repo_type: 'local',
      local_path: '/tmp/yaml-save',
      environment: {
        version: 2,
        default: 'keep',
        variants: {
          keep: {
            start: 'echo start',
            stop: 'echo stop',
            logs: 'echo old logs',
            health: 'https://example.invalid/health',
          },
          remove: { start: 'echo temporary', stop: 'echo stop' },
        },
        template_overrides: { host: { ip_address: '127.0.0.1' } },
      },
    });
    const app = feathers() as Application;
    app.set('config', {});
    app.use('repos', new ReposService(db, app));
    const service = app.service('repos');
    service.hooks({ before: { patch: [requireAdminForEnvConfig()] } });
    const params = (role: string) => ({ provider: 'rest', user: { role } }) as AuthenticatedParams;
    const environment: RepoEnvironment = {
      version: 2,
      default: 'keep',
      variants: { keep: { start: 'echo replacement', stop: 'echo stop' } },
    };

    await expect(service.patch(repo.repo_id, { environment }, params('member'))).rejects.toThrow(
      /admin/
    );
    expect((await repository.findById(repo.repo_id))?.environment).toEqual(repo.environment);
    const result = await service.patch(
      repo.repo_id,
      { environment, name: 'Renamed' },
      params('admin')
    );
    const stored = await repository.findById(repo.repo_id);
    expect(result).toMatchObject({ environment, name: 'Renamed', local_path: '/tmp/yaml-save' });
    expect(stored?.environment).toEqual(environment);
    expect(stored?.environment_config).toEqual({
      up_command: 'echo replacement',
      down_command: 'echo stop',
    });
    await service.patch(repo.repo_id, { name: 'Metadata only' }, params('member'));
    expect((await repository.findById(repo.repo_id))?.environment).toEqual(environment);
  }
);
