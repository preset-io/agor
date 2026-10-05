import type { Repo, UUID } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { ownedDbTest as dbTest } from '../test-helpers';
import { BranchRepository } from './branches';
import { RepoRepository } from './repos';

const data: Partial<Repo> = {
  slug: 'synthetic/framework',
  repo_type: 'remote',
  remote_url: 'https://example.invalid/synthetic/framework.git',
  local_path: '/tmp/synthetic/framework',
  default_branch: 'main',
};

describe('clone reservation and in-place recovery', () => {
  dbTest('fresh, repeated and concurrent callers share one attempt', async ({ db }) => {
    const repository = new RepoRepository(db);
    const results = await Promise.all(Array.from({ length: 4 }, () => repository.claimClone(data)));
    expect(results.filter((r) => r.acquired)).toHaveLength(1);
    expect(new Set(results.map((r) => r.repo.repo_id)).size).toBe(1);
    expect(new Set(results.map((r) => r.repo.clone_generation)).size).toBe(1);
    expect(results[0].repo.clone_status).toBe('cloning');
    const { repo } = results[0];
    await repository.update(repo.repo_id, {
      clone_status: 'ready',
      clone_generation: repo.clone_generation,
    });
    expect(await repository.claimClone(data)).toMatchObject({
      acquired: false,
      repo: { clone_status: 'ready' },
    });
    expect(await repository.count()).toBe(1);
  });

  dbTest(
    'failed legacy repo with branches retries without deletion or lost settings',
    async ({ db }) => {
      const repository = new RepoRepository(db);
      const original = await repository.create({
        ...data,
        clone_status: 'failed',
        name: 'Existing team repo',
        clone_error: { exit_code: 1, category: 'network', message: 'synthetic failure' },
        environment: {
          version: 2,
          default: 'default',
          variants: { default: { start: 'run', stop: 'stop' } },
        },
      });
      const branches = new BranchRepository(db);
      const branch = await branches.create({
        repo_id: original.repo_id,
        created_by: 'test-user' as UUID,
        name: 'existing-work',
        ref: 'main',
        branch_unique_id: 1234,
        path: '/tmp/synthetic/work',
      });
      const results = await Promise.all([repository.claimClone(data), repository.claimClone(data)]);
      expect(results.filter((r) => r.acquired)).toHaveLength(1);
      const claimed = results.find((r) => r.acquired)!.repo;
      expect(claimed).toMatchObject({
        repo_id: original.repo_id,
        local_path: original.local_path,
        name: original.name,
        environment: original.environment,
        clone_status: 'cloning',
      });
      expect(claimed.clone_error).toBeUndefined();
      expect(await branches.findById(branch.branch_id)).toMatchObject({
        repo_id: original.repo_id,
      });
      await expect(repository.delete(original.repo_id)).rejects.toThrow('Permanently delete');
    }
  );

  dbTest(
    'stale worker and onExit failures cannot overwrite the retry or its success',
    async ({ db }) => {
      const repository = new RepoRepository(db);
      const { repo: first } = await repository.claimClone(data);
      await repository.update(first.repo_id, {
        clone_generation: first.clone_generation,
        clone_status: 'failed',
      });
      const { repo: retry } = await repository.claimClone(data);
      expect(retry.clone_generation).not.toBe(first.clone_generation);
      for (const clone_generation of [first.clone_generation, undefined]) {
        const ignored = await repository.update(first.repo_id, {
          clone_generation,
          clone_status: 'failed',
          default_branch: 'stale',
          clone_error: { category: 'unknown', exit_code: 7, message: 'old worker' },
        });
        expect(ignored).toMatchObject({
          clone_status: 'cloning',
          default_branch: 'main',
          clone_generation: retry.clone_generation,
        });
      }
      await repository.update(first.repo_id, {
        clone_status: 'ready',
        clone_generation: retry.clone_generation,
      });
      expect(
        await repository.update(first.repo_id, {
          clone_status: 'failed',
          clone_generation: retry.clone_generation,
        })
      ).toMatchObject({ clone_status: 'ready' });
      await expect(repository.update(first.repo_id, { clone_generation: 999 })).rejects.toThrow(
        'only be changed'
      );
    }
  );

  dbTest('slug collision with another remote or a local repo never replaces it', async ({ db }) => {
    const repository = new RepoRepository(db);
    const { repo } = await repository.claimClone(data);
    await expect(
      repository.claimClone({ ...data, remote_url: 'https://example.invalid/other.git' })
    ).rejects.toThrow('different source');
    expect((await repository.findById(repo.repo_id))?.remote_url).toBe(data.remote_url);
    await repository.create({ ...data, slug: 'local/framework', repo_type: 'local' });
    await expect(repository.claimClone({ ...data, slug: 'local/framework' })).rejects.toThrow(
      'different source'
    );
  });
});
