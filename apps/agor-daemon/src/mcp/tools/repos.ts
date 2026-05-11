import { extractSlugFromUrl, isValidGitUrl, isValidSlug } from '@agor/core/config';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ReposServiceImpl } from '../../declarations.js';
import type { McpContext } from '../server.js';
import { coerceString, textResult } from '../server.js';

export function registerRepoTools(server: McpServer, ctx: McpContext): void {
  // Tool 1: agor_repos_list
  server.registerTool(
    'agor_repos_list',
    {
      description: 'List all repositories accessible to the current user',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        slug: z.string().optional().describe('Filter by repository slug'),
        limit: z.number().optional().describe('Maximum number of results (default: 50)'),
      }),
    },
    async (args) => {
      const query: Record<string, unknown> = {};
      if (args.slug) query.slug = args.slug;
      if (args.limit) query.$limit = args.limit;
      const repos = await ctx.app.service('repos').find({ query, ...ctx.baseServiceParams });
      return textResult(repos);
    }
  );

  // Tool 2: agor_repos_get
  server.registerTool(
    'agor_repos_get',
    {
      description:
        'Get detailed information about a specific repository, including async clone state. ' +
        'For repos created via agor_repos_create_remote, check `clone_status` ' +
        '(`cloning` | `ready` | `failed`). On `failed`, `clone_error.category` ' +
        '(`auth_failed` | `not_found` | `network` | `unknown`) tells you what went wrong; ' +
        '`auth_failed` usually means the calling user has not configured a `GITHUB_TOKEN` ' +
        'in Settings → API Keys (or it has expired/lost access).',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        repoId: z.string().describe('Repository ID (UUIDv7 or short ID)'),
      }),
    },
    async (args) => {
      const repo = await ctx.app.service('repos').get(args.repoId, ctx.baseServiceParams);
      return textResult(repo);
    }
  );

  // Tool 3: agor_repos_create_remote
  server.registerTool(
    'agor_repos_create_remote',
    {
      description:
        'Clone a remote repository into Agor. Returns immediately with `{ status: "pending", ' +
        'slug, repo_id }` while the clone runs in the background. Poll `agor_repos_get(repo_id)` ' +
        'until `clone_status` is `ready` (success) or `failed` (see `clone_error` for details). ' +
        'Private repos require the calling user to have `GITHUB_TOKEN` configured in ' +
        'Settings → API Keys; without it, the clone will fail with `clone_error.category: ' +
        '"auth_failed"`. Retrying after a failed clone is supported — the previous failed row ' +
        'is replaced.',
      inputSchema: z.object({
        url: z
          .string()
          .describe(
            'Git remote URL (https://github.com/user/repo.git or git@github.com:user/repo.git)'
          ),
        slug: z
          .string()
          .optional()
          .describe(
            'URL-friendly slug for the repository in org/name format (e.g., "myorg/myapp"). Required.'
          ),
        name: z
          .string()
          .optional()
          .describe(
            'Human-readable name for the repository. If not provided, defaults to the slug.'
          ),
        default_branch: z
          .string()
          .optional()
          .describe(
            "Pin a non-default branch as the repo's default (overrides origin/HEAD). " +
              'Used when the repository\'s "default" should be a long-lived feature branch ' +
              "rather than whatever the remote's HEAD points at."
          ),
      }),
    },
    async (args) => {
      const url = coerceString(args.url);
      if (!url) throw new Error('url is required');
      if (!isValidGitUrl(url)) throw new Error('url must be a valid git URL (https:// or git@)');

      let slug = coerceString(args.slug);
      if (!slug) {
        try {
          slug = extractSlugFromUrl(url);
        } catch {
          throw new Error('Could not derive slug from URL. Please provide a slug explicitly.');
        }
      }
      if (!isValidSlug(slug)) throw new Error('slug must be in org/name format');

      const name = coerceString(args.name);
      const defaultBranch = coerceString(args.default_branch);
      const reposService = ctx.app.service('repos') as unknown as ReposServiceImpl;
      const result = await reposService.cloneRepository(
        { url, slug, name, ...(defaultBranch ? { default_branch: defaultBranch } : {}) },
        ctx.baseServiceParams
      );
      return textResult(result);
    }
  );

  // Tool 4: agor_repos_create_local
  server.registerTool(
    'agor_repos_create_local',
    {
      description: 'Register an existing local git repository with Agor',
      inputSchema: z.object({
        path: z
          .string()
          .describe('Absolute path to the local git repository. Supports ~ for home directory.'),
        slug: z
          .string()
          .optional()
          .describe(
            'URL-friendly slug for the repository (e.g., "local/myapp"). If not provided, will be auto-derived from the repository name.'
          ),
      }),
    },
    async (args) => {
      const path = coerceString(args.path);
      if (!path) throw new Error('path is required');
      const slug = coerceString(args.slug);
      const reposService = ctx.app.service('repos') as unknown as ReposServiceImpl;
      const repo = await reposService.addLocalRepository({ path, slug }, ctx.baseServiceParams);
      return textResult(repo);
    }
  );

  // Tool 5: agor_repos_update
  //
  // Patch repo metadata after creation. Validation + uniqueness checks live
  // on the service (`ReposService.updateMetadata`) so REST / UI / direct
  // callers can't drift from this surface.
  server.registerTool(
    'agor_repos_update',
    {
      description:
        "Patch a repository's metadata (name, slug, repo_type, remote_url, default_branch). " +
        'Useful for correcting metadata after a `create_local` workaround — e.g. flipping ' +
        '`repo_type: "local" → "remote"` so the repo is treated as a managed clone. ' +
        'Note: changing `slug` updates the DB only; the on-disk directory at ' +
        '~/.agor/repos/<slug> is NOT moved.',
      inputSchema: z.object({
        repoId: z.string().describe('Repository ID (UUIDv7 or short ID)'),
        name: z.string().optional().describe('Human-readable name'),
        slug: z
          .string()
          .optional()
          .describe('URL-friendly slug in org/name format. Must be unique across all repos.'),
        repo_type: z
          .enum(['remote', 'local'])
          .optional()
          .describe(
            'Repository management type. Switching to "remote" requires `remote_url` (in this patch or already set on the repo).'
          ),
        remote_url: z
          .string()
          .optional()
          .describe('Git remote URL. Required when `repo_type` is "remote".'),
        default_branch: z
          .string()
          .optional()
          .describe(
            'Default branch name used as the source for new worktrees that do not specify a sourceBranch.'
          ),
      }),
    },
    async (args) => {
      const repoId = coerceString(args.repoId);
      if (!repoId) throw new Error('repoId is required');

      const patch: Parameters<ReposServiceImpl['updateMetadata']>[1] = {};
      const name = coerceString(args.name);
      if (name !== undefined) patch.name = name;
      const slug = coerceString(args.slug);
      if (slug !== undefined) patch.slug = slug;
      const repoType = coerceString(args.repo_type);
      if (repoType === 'remote' || repoType === 'local') patch.repo_type = repoType;
      const remoteUrl = coerceString(args.remote_url);
      if (remoteUrl !== undefined) patch.remote_url = remoteUrl;
      const defaultBranch = coerceString(args.default_branch);
      if (defaultBranch !== undefined) patch.default_branch = defaultBranch;

      const reposService = ctx.app.service('repos') as unknown as ReposServiceImpl;
      const updated = await reposService.updateMetadata(repoId, patch, ctx.baseServiceParams);
      return textResult(updated);
    }
  );
}
