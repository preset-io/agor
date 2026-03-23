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
      description: 'Get detailed information about a specific repository',
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
        'Clone a remote repository into Agor. Returns immediately with pending status - repository will be created asynchronously.',
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
      const reposService = ctx.app.service('repos') as unknown as ReposServiceImpl;
      const result = await reposService.cloneRepository({ url, slug, name }, ctx.baseServiceParams);
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
}
