/**
 * Artifact MCP Tools
 *
 * Agent-facing tools for publishing and managing Sandpack artifacts on boards.
 * Artifacts are DB-backed live web applications that render on the board canvas.
 */

import { NotFoundError } from '@agor/core/utils/errors';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ArtifactsService } from '../../services/artifacts.js';
import { resolveArtifactId, resolveBoardId } from '../resolve-ids.js';
import type { McpContext } from '../server.js';
import { coerceString, textResult } from '../server.js';

export function registerArtifactTools(server: McpServer, ctx: McpContext): void {
  // Tool 1: agor_artifacts_publish
  server.registerTool(
    'agor_artifacts_publish',
    {
      description: `Publish a folder as a live Sandpack artifact on a board. Reads all files from the given folder path, serializes them to the database, and places (or updates) the artifact on the board.

If artifact_id is omitted, creates a new artifact.
If artifact_id is provided, updates the existing artifact (must be owned by you).

The folder should contain source files and optionally a sandpack.json manifest. The agent decides where to create the folder — inside the worktree, a temp directory, etc. The folder is only read at publish time; after that, the artifact lives in the database.

Recommended: create the folder inside your worktree so files can be version-controlled.

CONFIG CONVENTION (agor.config.js):
If you include a file named "/agor.config.js", it is treated as a Handlebars template and rendered per-user at view time. This lets artifacts access API credentials and Agor context without hardcoding secrets.

Available template variables:
  {{ user.env.VAR_NAME }} - User's environment variable (configured in Settings > Environment Variables)
  {{ user.id }}           - Current user's ID
  {{ user.name }}         - Current user's display name
  {{ user.email }}        - Current user's email
  {{ agor.apiUrl }}       - Agor daemon URL
  {{ artifact.id }}       - This artifact's ID
  {{ artifact.boardId }}  - Board ID
  {{ board.id }}          - Board ID (same as artifact.boardId)
  {{ board.slug }}        - Board slug (for URL construction)

IMPORTANT:
- Use {{ user.env.X }} for secrets (API keys, tokens). NEVER hardcode sensitive values.
- All users can see the raw template file, but each user's rendered values are private.
- Rendered secrets are injected into the artifact JS at view time. Artifact code CAN access these values, so only use this for artifacts you trust. The security guarantee is that secrets never enter the LLM context or conversation history.
- Missing env vars render as empty string "". Your app should check for empty values and show a helpful message (e.g. "Please configure OPENAI_API_KEY in Settings > Environment Variables") instead of making API calls with empty credentials.

Example /agor.config.js:
  export const apiKey = "{{ user.env.OPENAI_API_KEY }}";
  export const apiUrl = "{{ agor.apiUrl }}";

Then in your app: import { apiKey, apiUrl } from '/agor.config.js';`,
      inputSchema: z.object({
        folderPath: z.string().describe('Absolute path to folder containing artifact files'),
        boardId: z.string().describe('Board to place the artifact on'),
        name: z.string().describe('Artifact display name'),
        artifactId: z
          .string()
          .optional()
          .describe('If provided, update existing artifact (must be owned by you)'),
        template: z
          .enum([
            'react',
            'react-ts',
            'vanilla',
            'vanilla-ts',
            'vue',
            'vue3',
            'svelte',
            'solid',
            'angular',
          ])
          .optional()
          .describe('Sandpack template (default: react)'),
        public: z
          .boolean()
          .optional()
          .describe('Whether the artifact is visible to all board viewers (default: true)'),
        x: z.number().optional().describe('X position on board (default: 0, only used on create)'),
        y: z.number().optional().describe('Y position on board (default: 0, only used on create)'),
        width: z
          .number()
          .optional()
          .describe('Width in pixels (default: 600, only used on create)'),
        height: z
          .number()
          .optional()
          .describe('Height in pixels (default: 400, only used on create)'),
        useLocalBundler: z
          .boolean()
          .optional()
          .describe(
            `Use the daemon's self-hosted Sandpack bundler at /static/sandpack/ instead of the default CodeSandbox hosted bundler. Default: false.

When to set true:
- Daemon is on a private network / VPN with no egress to codesandbox.io
- Air-gapped deployments, compliance constraints, or fully offline demos

REQUIRES the daemon to have been built with \`./build.sh --with-sandpack\`. If the local bundler is not available, artifact creation fails with a clear error.

KNOWN LIMITATIONS of the local bundler (upstream sandpack-bundler v2):
- CommonJS npm packages fail to resolve. Popular examples that break: recharts, lodash (use lodash-es instead), moment. Stick to ESM-only packages when this flag is true.
- Fewer features and slower updates than the hosted bundler. Upstream issues: https://github.com/codesandbox/sandpack-bundler

When in doubt, leave unset — the hosted bundler supports the widest range of packages and is the recommended default.`
          ),
      }),
    },
    async (args) => {
      const service = ctx.app.service('artifacts') as unknown as ArtifactsService;
      const resolvedBoardId = await resolveBoardId(ctx, coerceString(args.boardId)!);
      const resolvedArtifactId = coerceString(args.artifactId)
        ? await resolveArtifactId(ctx, coerceString(args.artifactId)!)
        : undefined;
      const artifact = await service.publish(
        {
          folderPath: coerceString(args.folderPath)!,
          board_id: resolvedBoardId,
          name: coerceString(args.name)!,
          artifact_id: resolvedArtifactId,
          template: args.template,
          public: args.public,
          use_local_bundler: args.useLocalBundler,
          x: args.x,
          y: args.y,
          width: args.width,
          height: args.height,
        },
        ctx.userId
      );

      // Omit files blob from response to avoid context bloat for agents
      const { files: _files, ...artifactSummary } = artifact;
      return textResult({
        artifact: artifactSummary,
        instructions: args.artifactId
          ? 'Artifact updated. Changes are live on the board.'
          : 'Artifact created and placed on the board. To update it later, call agor_artifacts_publish again with the artifact_id.',
      });
    }
  );

  // Tool 2: agor_artifacts_check_build
  server.registerTool(
    'agor_artifacts_check_build',
    {
      description:
        'Check build readiness of artifact files in a folder. Verifies source files exist and are non-empty (does not run a real build or syntax check). Use this before publishing to verify basic structure.',
      inputSchema: z.object({
        folderPath: z
          .string()
          .describe('Absolute path to the folder containing artifact files to check'),
      }),
    },
    async (args) => {
      const service = ctx.app.service('artifacts') as unknown as ArtifactsService;
      const result = await service.checkBuildFromFolder(coerceString(args.folderPath)!);
      return textResult(result);
    }
  );

  // Tool 3: agor_artifacts_status
  server.registerTool(
    'agor_artifacts_status',
    {
      description: `Get artifact build status, Sandpack bundler errors, and recent console logs from the browser runtime. Use this to debug rendering issues.

build_status reflects both file validation AND Sandpack runtime state. If the Sandpack bundler reports an error (e.g. "Could not find module './data'"), build_status will be 'error' even if files were accepted.

Fields:
- build_status: 'success' | 'error' | 'unknown' — reflects the worst of file validation and Sandpack runtime
- build_errors: array of error messages (includes Sandpack errors prefixed with [Sandpack])
- sandpack_error: the raw Sandpack bundler/runtime error object (null if no error)
- sandpack_status: Sandpack bundler status ('idle', 'running', 'timeout', etc.)
- console_logs: console.log/warn/error output from the running app

NOTE: sandpack_error and console_logs require a browser to be viewing the artifact. If no browser is connected, these fields will be empty/null.`,
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        artifactId: z.string().describe('Artifact ID'),
      }),
    },
    async (args) => {
      const service = ctx.app.service('artifacts') as unknown as ArtifactsService;
      const status = await service.getStatus(coerceString(args.artifactId)!);
      return textResult(status);
    }
  );

  // Tool 4: agor_artifacts_delete
  server.registerTool(
    'agor_artifacts_delete',
    {
      description:
        'Delete an artifact. Removes database record and board placement. Does not touch the filesystem.',
      annotations: { destructiveHint: true },
      inputSchema: z.object({
        artifactId: z.string().describe('Artifact ID to delete'),
      }),
    },
    async (args) => {
      const service = ctx.app.service('artifacts') as unknown as ArtifactsService;
      const artifactId = coerceString(args.artifactId)!;

      // Get artifact before deletion for the emit
      const artifact = await service.get(artifactId, ctx.baseServiceParams);
      await service.deleteArtifact(artifactId);
      ctx.app.service('artifacts').emit('removed', artifact);

      return textResult({ success: true, artifactId });
    }
  );

  // Tool 5: agor_artifacts_get
  server.registerTool(
    'agor_artifacts_get',
    {
      description:
        'Get a single artifact by ID, including its full file map (path → content). Use this to read artifact source code from another worktree without filesystem access. Respects visibility: public artifacts are readable by anyone; private artifacts are only readable by their creator.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        artifactId: z.string().describe('Artifact ID (full UUID or short prefix)'),
      }),
    },
    async (args) => {
      const service = ctx.app.service('artifacts') as unknown as ArtifactsService;
      const artifactId = coerceString(args.artifactId)!;

      // Fetch the artifact via the Feathers get() method (inherited from DrizzleService)
      let artifact: Awaited<ReturnType<typeof service.get>>;
      try {
        artifact = await service.get(artifactId, ctx.baseServiceParams);
      } catch (err) {
        if (err instanceof NotFoundError) {
          return textResult({ error: `Artifact ${artifactId} not found` });
        }
        throw err;
      }

      // Visibility check: private artifacts are only visible to their creator
      if (!artifact.public) {
        if (!ctx.userId || !artifact.created_by || artifact.created_by !== ctx.userId) {
          return textResult({ error: `Artifact ${artifactId} not found` });
        }
      }

      // Return metadata (without files blob) + full file map separately
      const { files, ...metadata } = artifact;
      return textResult({
        artifact: metadata,
        files: files ?? {},
      });
    }
  );

  // Tool 6: agor_artifacts_list
  server.registerTool(
    'agor_artifacts_list',
    {
      description:
        'List artifacts, optionally filtered by board. Respects visibility: shows public artifacts plus private artifacts owned by you.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        boardId: z.string().optional().describe('Filter by board ID'),
        limit: z.number().optional().describe('Maximum number of results (default: 50)'),
      }),
    },
    async (args) => {
      const service = ctx.app.service('artifacts') as unknown as ArtifactsService;
      const boardIdRaw = coerceString(args.boardId);
      const boardId = boardIdRaw ? await resolveBoardId(ctx, boardIdRaw) : undefined;
      const limit = typeof args.limit === 'number' ? args.limit : 50;

      let artifactsList: unknown[];
      if (boardId) {
        artifactsList = await service.findByBoardId(boardId as never, ctx.userId);
      } else {
        artifactsList = await service.findVisible(ctx.userId, { limit });
      }

      // Omit files blob from list results to avoid context bloat
      const stripped = (artifactsList as Record<string, unknown>[]).map(
        ({ files: _f, ...rest }) => rest
      );
      return textResult({
        total: stripped.length,
        data: stripped,
      });
    }
  );
}
