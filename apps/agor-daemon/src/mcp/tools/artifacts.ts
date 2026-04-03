/**
 * Artifact MCP Tools
 *
 * Agent-facing tools for creating and managing Sandpack artifacts on boards.
 * Artifacts are filesystem-backed live web applications that render on the board canvas.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ArtifactsService } from '../../services/artifacts.js';
import type { McpContext } from '../server.js';
import { coerceString, textResult } from '../server.js';

export function registerArtifactTools(server: McpServer, ctx: McpContext): void {
  // Tool 1: agor_artifacts_create
  server.registerTool(
    'agor_artifacts_create',
    {
      description:
        'Create a live web application artifact on a board. Scaffolds a folder in the worktree at .agor/artifacts/{id}/, writes initial files, and places it on the board. The artifact renders in-browser using Sandpack. After creation, you can edit files in the returned path using normal file tools, then call agor_artifacts_refresh to push changes to the board.',
      inputSchema: z.object({
        name: z.string().describe('Artifact display name'),
        boardId: z.string().describe('Board to place the artifact on'),
        worktreeId: z.string().describe('Worktree where artifact files are stored'),
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
          .default('react')
          .describe('Sandpack template (default: react)'),
        files: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            'Initial file map: path -> code content. e.g. { "/App.js": "export default ..." }. If omitted, default template files are used.'
          ),
        dependencies: z
          .record(z.string(), z.string())
          .optional()
          .describe('NPM dependencies beyond template defaults, e.g. { "recharts": "^2.0.0" }'),
        entry: z.string().optional().describe('Entry file path (default: determined by template)'),
        x: z.number().default(0).describe('X position on board'),
        y: z.number().default(0).describe('Y position on board'),
        width: z.number().default(600).describe('Width in pixels (default: 600)'),
        height: z.number().default(400).describe('Height in pixels (default: 400)'),
      }),
    },
    async (args) => {
      const service = ctx.app.service('artifacts') as unknown as ArtifactsService;
      const artifact = await service.createArtifact(
        {
          name: coerceString(args.name)!,
          board_id: coerceString(args.boardId)!,
          worktree_id: coerceString(args.worktreeId)!,
          template: args.template,
          files: args.files as Record<string, string> | undefined,
          dependencies: args.dependencies as Record<string, string> | undefined,
          entry: coerceString(args.entry),
          x: args.x,
          y: args.y,
          width: args.width,
          height: args.height,
        },
        ctx.userId
      );

      ctx.app.service('artifacts').emit('created', artifact);

      // Return artifact with the filesystem path for the agent to edit
      const worktree = await ctx.app
        .service('worktrees')
        .get(artifact.worktree_id, ctx.baseServiceParams);
      return textResult({
        artifact,
        path: `${worktree.path}/${artifact.path}`,
        instructions:
          'Edit files in the path above using normal file tools. Call agor_artifacts_refresh when done to push changes to the board.',
      });
    }
  );

  // Tool 2: agor_artifacts_check_build
  server.registerTool(
    'agor_artifacts_check_build',
    {
      description:
        'Check build readiness of an artifact. Verifies source files exist and are non-empty (does not run a real build or syntax check). Use this after editing files to verify basic structure before refreshing.',
      inputSchema: z.object({
        artifactId: z.string().describe('Artifact ID'),
      }),
    },
    async (args) => {
      const service = ctx.app.service('artifacts') as unknown as ArtifactsService;
      const result = await service.checkBuild(coerceString(args.artifactId)!);
      return textResult(result);
    }
  );

  // Tool 3: agor_artifacts_refresh
  server.registerTool(
    'agor_artifacts_refresh',
    {
      description:
        'Refresh an artifact after making file changes. Re-reads the filesystem, computes a new content hash, and notifies connected browser clients to reload the preview. Call this after editing files.',
      inputSchema: z.object({
        artifactId: z.string().describe('Artifact ID'),
      }),
    },
    async (args) => {
      const service = ctx.app.service('artifacts') as unknown as ArtifactsService;
      const artifact = await service.refresh(coerceString(args.artifactId)!);
      ctx.app.service('artifacts').emit('patched', artifact);
      return textResult(artifact);
    }
  );

  // Tool 4: agor_artifacts_status
  server.registerTool(
    'agor_artifacts_status',
    {
      description:
        'Get artifact build status and recent console logs from the browser runtime. Use this to debug rendering issues. Console logs are captured from the Sandpack iframe in connected browsers.',
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

  // Tool 5: agor_artifacts_delete
  server.registerTool(
    'agor_artifacts_delete',
    {
      description:
        'Delete an artifact. Removes filesystem files, database record, and board placement.',
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

  // Tool 6: agor_artifacts_list
  server.registerTool(
    'agor_artifacts_list',
    {
      description: 'List artifacts, optionally filtered by board.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        boardId: z.string().optional().describe('Filter by board ID'),
        limit: z.number().optional().describe('Maximum number of results (default: 50)'),
      }),
    },
    async (args) => {
      const service = ctx.app.service('artifacts') as unknown as ArtifactsService;
      const boardId = coerceString(args.boardId);
      const limit = typeof args.limit === 'number' ? args.limit : 50;

      let artifactsList: unknown[];
      if (boardId) {
        artifactsList = await service.findByBoardId(boardId as never);
      } else {
        const result = await service.find({
          query: { $limit: limit },
        } as never);
        artifactsList =
          'data' in result ? (result as { data: unknown[] }).data : (result as unknown[]);
      }

      return textResult({
        total: Array.isArray(artifactsList) ? artifactsList.length : 0,
        data: artifactsList,
      });
    }
  );
}
