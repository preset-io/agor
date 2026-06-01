/**
 * Tests for renderBranchSnapshot (env command variants).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { registerHandlebarsHelpers } from '../templates/handlebars-helpers';
import type { RepoEnvironment } from '../types/branch';
import { renderBranchSnapshot } from './render-snapshot';

const branch = {
  branch_unique_id: 7,
  name: 'feat-auth',
  path: '/tmp/feat-auth',
  custom_context: { app_name: 'custom-app' },
};

beforeAll(() => {
  // Required once per process so `{{add ...}}` etc. are available.
  registerHandlebarsHelpers();
});

describe('renderBranchSnapshot', () => {
  it('returns null when repo has no environment config', () => {
    const snapshot = renderBranchSnapshot({ slug: 'r' }, branch);
    expect(snapshot).toBeNull();
  });

  it('renders the default variant when no variantName is given', () => {
    const env: RepoEnvironment = {
      version: 2,
      default: 'dev',
      variants: {
        dev: {
          start: 'pnpm dev --port={{add 3000 branch.unique_id}}',
          stop: 'pkill -f pnpm',
        },
        e2e: {
          start: 'pnpm e2e',
          stop: 'pnpm e2e:stop',
        },
      },
    };

    const snapshot = renderBranchSnapshot({ slug: 'r', environment: env }, branch);
    expect(snapshot).toEqual({
      variant: 'dev',
      start: 'pnpm dev --port=3007',
      stop: 'pkill -f pnpm',
    });
  });

  it('renders an explicitly-named variant', () => {
    const env: RepoEnvironment = {
      version: 2,
      default: 'dev',
      variants: {
        dev: { start: 'pnpm dev', stop: 'pkill pnpm' },
        e2e: {
          start: 'pnpm e2e',
          stop: 'pnpm e2e:stop',
          health: 'http://localhost:{{add 4000 branch.unique_id}}/health',
        },
      },
    };

    const snapshot = renderBranchSnapshot({ slug: 'r', environment: env }, branch, 'e2e');
    expect(snapshot).toEqual({
      variant: 'e2e',
      start: 'pnpm e2e',
      stop: 'pnpm e2e:stop',
      health: 'http://localhost:4007/health',
    });
  });

  it('throws when the named variant does not exist', () => {
    const env: RepoEnvironment = {
      version: 2,
      default: 'dev',
      variants: { dev: { start: 'x', stop: 'y' } },
    };
    expect(() => renderBranchSnapshot({ slug: 'r', environment: env }, branch, 'ghost')).toThrow(
      /Unknown environment variant/
    );
  });

  it('resolves single-level extends before templating', () => {
    const env: RepoEnvironment = {
      version: 2,
      default: 'dev',
      variants: {
        base: {
          start: 'pnpm dev',
          stop: 'pkill pnpm',
          health: 'http://localhost:3000/health',
          logs: 'tail -n 100 base.log',
        },
        dev: {
          extends: 'base',
          // Only override health; start/stop/logs inherited.
          health: 'http://localhost:{{add 3000 branch.unique_id}}/dev-health',
        },
      },
    };

    const snapshot = renderBranchSnapshot({ slug: 'r', environment: env }, branch, 'dev');
    expect(snapshot).toEqual({
      variant: 'dev',
      start: 'pnpm dev',
      stop: 'pkill pnpm',
      health: 'http://localhost:3007/dev-health',
      logs: 'tail -n 100 base.log',
    });
  });

  it('applies template_overrides into the render context', () => {
    const env: RepoEnvironment = {
      version: 2,
      default: 'dev',
      variants: {
        dev: {
          start: 'echo {{deployment.region}} {{branch.name}}',
          stop: 'stop',
        },
      },
      template_overrides: {
        deployment: { region: 'us-west-2' },
      },
    };

    const snapshot = renderBranchSnapshot({ slug: 'r', environment: env }, branch);
    expect(snapshot?.start).toBe('echo us-west-2 feat-auth');
  });

  it('template_overrides do NOT clobber branch custom.* context', () => {
    const env: RepoEnvironment = {
      version: 2,
      default: 'dev',
      variants: {
        dev: {
          start: 'echo {{custom.app_name}}',
          stop: 'stop',
        },
      },
      // An override tries to shadow `custom.app_name` — branch custom must win.
      template_overrides: {
        custom: { app_name: 'overridden' },
      },
    };

    const snapshot = renderBranchSnapshot({ slug: 'r', environment: env }, branch);
    expect(snapshot?.start).toBe('echo custom-app');
  });

  it('deep-merges template_overrides into nested context', () => {
    const env: RepoEnvironment = {
      version: 2,
      default: 'dev',
      variants: {
        dev: {
          start: 'echo {{repo.slug}} {{deployment.region}}',
          stop: 'stop',
        },
      },
      template_overrides: {
        deployment: { region: 'eu-central-1' },
      },
    };

    const snapshot = renderBranchSnapshot({ slug: 'myrepo', environment: env }, branch);
    expect(snapshot?.start).toBe('echo myrepo eu-central-1');
  });
});
