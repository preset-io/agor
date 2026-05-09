/**
 * Artifact MCP Tools
 *
 * Agent-facing tools for publishing and managing Sandpack artifacts on boards.
 * Artifacts are DB-backed live web applications that render on the board canvas.
 *
 * The format is intentionally small: a file map plus declarative metadata
 * (`required_env_vars`, `agor_grants`, `sandpack_config`). The daemon
 * synthesizes a per-viewer `.env` and resolves daemon-supplied capabilities
 * at render time. There is no Handlebars layer, no per-fetch JS rendering,
 * and no `sandpack.json`/`agor.config.js` sidecar.
 */

import { WorktreeRepository } from '@agor/core/db';
import type { AgorGrants, BoardID, SandpackConfig, UUID, WorktreeID } from '@agor/core/types';
import { NotFoundError } from '@agor/core/utils/errors';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ArtifactsService } from '../../services/artifacts.js';
import { hasWorktreePermission } from '../../utils/worktree-authorization.js';
import { resolveArtifactId, resolveBoardId, resolveWorktreeId } from '../resolve-ids.js';
import type { McpContext } from '../server.js';
import { coerceString, textResult } from '../server.js';

const SANDPACK_TEMPLATES = [
  'react',
  'react-ts',
  'vanilla',
  'vanilla-ts',
  'vue',
  'vue3',
  'svelte',
  'solid',
  'angular',
] as const;

const SandpackConfigSchema = z
  .object({
    template: z.enum(SANDPACK_TEMPLATES).optional(),
    customSetup: z
      .object({
        dependencies: z.record(z.string(), z.string()).optional(),
        devDependencies: z.record(z.string(), z.string()).optional(),
        entry: z.string().optional(),
        environment: z.string().optional(),
      })
      .optional(),
    theme: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
    options: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()
  .optional();

const AgorGrantsSchema = z
  .object({
    agor_token: z.boolean().optional(),
    agor_api_url: z.boolean().optional(),
    agor_user_email: z.boolean().optional(),
    agor_artifact_id: z.boolean().optional(),
    agor_board_id: z.boolean().optional(),
    agor_proxies: z.array(z.string()).optional(),
  })
  .optional();

export function registerArtifactTools(server: McpServer, ctx: McpContext): void {
  // Tool 1: agor_artifacts_publish
  server.registerTool(
    'agor_artifacts_publish',
    {
      description: `Publish a folder as a live Sandpack artifact on a board. Reads files from the given folder, serializes them to the database, and places (or updates) the artifact on the board.

If artifactId is omitted, creates a new artifact.
If artifactId is provided, updates the existing artifact (must be owned by you).

The folder should contain ordinary source files (no \`sandpack.json\`, no \`agor.config.js\`). The agent decides where to create the folder — inside the worktree, a temp directory, etc. The folder is only read at publish time; after that, the artifact lives in the database.

Recommended: create the folder inside your worktree so files can be version-controlled.

DECLARATIVE CONFIG:
- \`requiredEnvVars\`: array of env var NAMES the artifact needs (e.g. ["OPENAI_KEY", "STRIPE_KEY"]). The daemon synthesizes a per-viewer \`.env\` at render time using values from the viewer's stored env vars (Settings → Environment Variables). Names are stored without prefix; the daemon prefixes per template (Vite → \`VITE_\`, CRA → \`REACT_APP_\`, etc.). Reference these in your code via \`import.meta.env.VITE_X\` (Vite) or \`process.env.X\` (Node).
- \`agorGrants\`: declarative daemon capabilities. Each grant maps to a fixed env var:
    \`agor_token: true\`     → mints a 15-min daemon JWT for the viewer; injected as \`AGOR_TOKEN\`. ARTIFACT-SCOPED CONSENT ONLY — author/instance grants don't auto-cover this.
    \`agor_api_url: true\`   → injects the daemon URL as \`AGOR_API_URL\`.
    \`agor_user_email: true\` → injects viewer's email as \`AGOR_USER_EMAIL\`.
    \`agor_artifact_id: true\` → \`AGOR_ARTIFACT_ID\` (informational, no consent).
    \`agor_board_id: true\`   → \`AGOR_BOARD_ID\` (informational, no consent).
    \`agor_proxies: ["openai", ...]\` → injects \`AGOR_PROXY_OPENAI\` etc. for HTTP proxy URLs.
- \`sandpackConfig\`: author-controlled SandpackProvider config (template, customSetup, theme, options). Sanitized on write — UI-affecting / private-account props are stripped.

CONSENT MODEL (TOFU): when the viewer is NOT the artifact author, the daemon does NOT inject env vars or grants without an explicit trust grant. Untrusted artifacts render with empty env values and a "Trust to render with secrets" badge.

IMPORTANT:
- Secrets never enter the LLM context. Env values are only injected into the served \`.env\` at view time.
- Missing user env vars render as "" — your app should detect that and surface a "configure SOMETHING in Settings" message rather than calling APIs with empty creds.
- For node.js / static templates without a dotenv path, env vars are NOT injected; the daemon emits a warning if you declared any.`,
      inputSchema: z.object({
        folderPath: z.string().describe('Absolute path to folder containing artifact files'),
        boardId: z.string().describe('Board to place the artifact on'),
        name: z.string().describe('Artifact display name'),
        artifactId: z
          .string()
          .optional()
          .describe('If provided, update existing artifact (must be owned by you)'),
        template: z
          .enum(SANDPACK_TEMPLATES)
          .optional()
          .describe(
            'Sandpack template (default: react). Also settable via sandpackConfig.template.'
          ),
        public: z
          .boolean()
          .optional()
          .describe('Whether the artifact is visible to all board viewers (default: true)'),
        sandpackConfig: SandpackConfigSchema.describe(
          'Author-controlled Sandpack provider config (sanitized on write).'
        ),
        requiredEnvVars: z
          .array(z.string())
          .optional()
          .describe(
            'Env var NAMES (no prefix) the artifact needs. Daemon synthesizes a per-viewer .env at render time.'
          ),
        agorGrants: AgorGrantsSchema.describe(
          'Daemon capabilities to inject. See tool description for the full list.'
        ),
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
          sandpack_config: args.sandpackConfig as SandpackConfig | undefined,
          required_env_vars: args.requiredEnvVars,
          agor_grants: args.agorGrants as AgorGrants | undefined,
          x: args.x,
          y: args.y,
          width: args.width,
          height: args.height,
        },
        ctx.userId
      );

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
        'Get a single artifact by ID, including its full file map (path → content) and declarative metadata (sandpack_config, required_env_vars, agor_grants). Use this to read artifact source code from another worktree without filesystem access. Respects visibility: public artifacts are readable by anyone; private artifacts are only readable by their creator.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        artifactId: z.string().describe('Artifact ID (full UUID or short prefix)'),
      }),
    },
    async (args) => {
      const service = ctx.app.service('artifacts') as unknown as ArtifactsService;
      const artifactId = coerceString(args.artifactId)!;

      let artifact: Awaited<ReturnType<typeof service.get>>;
      try {
        artifact = await service.get(artifactId, ctx.baseServiceParams);
      } catch (err) {
        if (err instanceof NotFoundError) {
          return textResult({ error: `Artifact ${artifactId} not found` });
        }
        throw err;
      }

      if (!service.isVisibleTo(artifact, ctx.userId)) {
        return textResult({ error: `Artifact ${artifactId} not found` });
      }

      const { files, ...metadata } = artifact;
      return textResult({
        artifact: metadata,
        files: files ?? {},
      });
    }
  );

  // Tool 6: agor_artifacts_update
  server.registerTool(
    'agor_artifacts_update',
    {
      description: `Update artifact metadata without re-reading files from disk. Use this to move an artifact to a different board, rename it, toggle visibility, archive it, reposition its board placement, or update its declarative config (requiredEnvVars / agorGrants / sandpackConfig).

For file/content changes, use agor_artifacts_publish (which re-reads a folder and updates the stored files).

Placement (x, y, width, height) is preserved across board moves unless you explicitly override it.

Caller must own the artifact (or be an admin).`,
      inputSchema: z.object({
        artifactId: z.string().describe('Artifact ID to update (full UUID or short prefix)'),
        boardId: z.string().optional().describe('Move the artifact to a different board'),
        name: z.string().optional().describe('Rename the artifact'),
        description: z.string().optional().describe('Update the description'),
        public: z
          .boolean()
          .optional()
          .describe('Change visibility (true = visible to all board viewers, false = owner only)'),
        archived: z.boolean().optional().describe('Archive or unarchive the artifact'),
        x: z.number().optional().describe('New X position on board'),
        y: z.number().optional().describe('New Y position on board'),
        width: z.number().optional().describe('New width in pixels'),
        height: z.number().optional().describe('New height in pixels'),
        sandpackConfig: SandpackConfigSchema.describe(
          "Replace the artifact's sandpack_config (sanitized on write)."
        ),
        requiredEnvVars: z
          .array(z.string())
          .optional()
          .describe("Replace the artifact's required_env_vars list."),
        agorGrants: AgorGrantsSchema.describe("Replace the artifact's agor_grants object."),
      }),
    },
    async (args) => {
      const service = ctx.app.service('artifacts') as unknown as ArtifactsService;
      const artifactId = await resolveArtifactId(ctx, coerceString(args.artifactId)!);

      const boardIdInput = coerceString(args.boardId);
      const resolvedBoardId = boardIdInput ? await resolveBoardId(ctx, boardIdInput) : undefined;

      const updated = await service.updateMetadata(
        artifactId,
        {
          name: coerceString(args.name),
          description: coerceString(args.description),
          public: args.public,
          archived: args.archived,
          board_id: resolvedBoardId as BoardID | undefined,
          x: args.x,
          y: args.y,
          width: args.width,
          height: args.height,
          sandpack_config: args.sandpackConfig as SandpackConfig | undefined,
          required_env_vars: args.requiredEnvVars,
          agor_grants: args.agorGrants as AgorGrants | undefined,
        },
        ctx.userId
      );

      const { files: _files, ...artifactSummary } = updated;
      return textResult({
        artifact: artifactSummary,
        instructions: 'Artifact metadata updated.',
      });
    }
  );

  // Tool 7: agor_artifacts_land
  server.registerTool(
    'agor_artifacts_land',
    {
      description: `Materialize an artifact's stored files to disk inside a worktree. Inverse of agor_artifacts_publish.

Use this when you want to tweak an artifact's code: land it into a worktree, edit the files locally, then call agor_artifacts_publish with the same artifactId to push the changes back.

Writes a small \`agor.artifact.json\` sidecar alongside the source files. The sidecar carries metadata that doesn't fit in the file map (template, sandpack_config, required_env_vars, agor_grants) so a round-trip publish() can preserve it. Build tools (Vite/CRA/etc.) ignore the sidecar.

Safety:
- Destination must be inside the target worktree (cannot escape via ".." or absolute paths).
- Default subpath is \`.agor/artifacts/<artifact-id>\` (inside the worktree). Pass a custom subpath if you want a different location.
- Refuses to write to an existing destination unless overwrite=true is passed.
- overwrite=true removes the destination directory first (symlinks are unlinked, not followed).

Visibility: public artifacts are readable by anyone; private artifacts are only landable by their owner.`,
      inputSchema: z.object({
        artifactId: z.string().describe('Artifact ID to materialize (full UUID or short prefix)'),
        worktreeId: z.string().describe('Destination worktree ID (full UUID or short prefix)'),
        subpath: z
          .string()
          .optional()
          .describe(
            'Worktree-relative path for the destination folder. Default: .agor/artifacts/<artifact-id>. Must not be absolute or escape the worktree.'
          ),
        overwrite: z
          .boolean()
          .optional()
          .describe('Remove the destination folder first if it exists. Default: false.'),
      }),
    },
    async (args) => {
      const service = ctx.app.service('artifacts') as unknown as ArtifactsService;
      const artifactId = await resolveArtifactId(ctx, coerceString(args.artifactId)!);
      const worktreeId = await resolveWorktreeId(ctx, coerceString(args.worktreeId)!);

      let artifact: Awaited<ReturnType<typeof service.get>>;
      try {
        artifact = await service.get(artifactId, ctx.baseServiceParams);
      } catch (err) {
        if (err instanceof NotFoundError) {
          return textResult({ error: `Artifact ${artifactId} not found` });
        }
        throw err;
      }
      if (!service.isVisibleTo(artifact, ctx.userId)) {
        return textResult({ error: `Artifact ${artifactId} not found` });
      }

      const worktree = (await ctx.app
        .service('worktrees')
        .get(worktreeId, ctx.baseServiceParams)) as {
        worktree_id: string;
        path: string;
        others_can?: 'none' | 'view' | 'session' | 'prompt' | 'all';
      };

      const worktreeRepo = new WorktreeRepository(ctx.db);
      const worktreeIdBranded = worktree.worktree_id as WorktreeID;
      const userIdBranded = ctx.userId as UUID;
      const isOwner = await worktreeRepo.isOwner(worktreeIdBranded, userIdBranded);
      const fullWorktree = await worktreeRepo.findById(worktreeIdBranded);
      if (!fullWorktree) {
        return textResult({ error: `Worktree ${worktreeId} not found` });
      }
      const canWrite = hasWorktreePermission(
        fullWorktree,
        userIdBranded,
        isOwner,
        'session',
        ctx.authenticatedUser.role
      );
      if (!canWrite) {
        return textResult({
          error: `Forbidden: 'session' permission or higher is required to land artifacts into worktree ${worktreeId}`,
        });
      }

      const result = await service.land(artifactId, worktree.path, {
        subpath: coerceString(args.subpath),
        overwrite: args.overwrite,
      });

      return textResult({
        artifactId,
        worktreeId: worktree.worktree_id,
        destinationPath: result.destinationPath,
        fileCount: result.fileCount,
        bytesWritten: result.bytesWritten,
        instructions: `Artifact materialized to ${result.destinationPath}. Edit files there, then call agor_artifacts_publish with folderPath=${result.destinationPath} and artifactId=${artifactId} to push changes back.`,
      });
    }
  );

  // Tool 8: agor_artifacts_list
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

      const stripped = (artifactsList as Record<string, unknown>[]).map(
        ({ files: _f, ...rest }) => rest
      );
      return textResult({
        total: stripped.length,
        data: stripped,
      });
    }
  );

  // Tool 9: agor_artifacts_export_codesandbox
  server.registerTool(
    'agor_artifacts_export_codesandbox',
    {
      description: `Export an artifact to CodeSandbox via their "define API". Returns a sandbox URL and ID. Useful for sharing or demoing — the artifact runs in CodeSandbox's standard environment, not Agor.

CAVEAT: daemon-supplied capabilities (\`AGOR_TOKEN\`, \`AGOR_PROXY_*\`, etc.) won't work on CodeSandbox. The exported sandbox can read \`required_env_vars\` from CodeSandbox's "Secret Keys" UI — the names match because both sides use the same prefix-per-template convention (Vite → \`VITE_\`, CRA → \`REACT_APP_\`, etc.).`,
      inputSchema: z.object({
        artifactId: z.string().describe('Artifact ID to export (full UUID or short prefix)'),
      }),
    },
    async (args) => {
      const service = ctx.app.service('artifacts') as unknown as ArtifactsService;
      const artifactId = await resolveArtifactId(ctx, coerceString(args.artifactId)!);

      let artifact: Awaited<ReturnType<typeof service.get>>;
      try {
        artifact = await service.get(artifactId, ctx.baseServiceParams);
      } catch (err) {
        if (err instanceof NotFoundError) {
          return textResult({ error: `Artifact ${artifactId} not found` });
        }
        throw err;
      }
      if (!service.isVisibleTo(artifact, ctx.userId)) {
        return textResult({ error: `Artifact ${artifactId} not found` });
      }
      if (!artifact.files || Object.keys(artifact.files).length === 0) {
        return textResult({ error: `Artifact ${artifactId} has no files to export` });
      }

      // Build the CodeSandbox "define" payload. Strip leading slashes from
      // file keys (CodeSandbox expects "src/index.js", not "/src/index.js").
      // The agor.config.js / agor.artifact.json sidecars (if any made it
      // into the file map for any reason) are dropped — they'd be broken
      // outside Agor.
      const filesPayload: Record<string, { content: string }> = {};
      for (const [filePath, content] of Object.entries(artifact.files)) {
        const stripped = filePath.startsWith('/') ? filePath.slice(1) : filePath;
        if (stripped === 'agor.config.js' || stripped === 'agor.artifact.json') continue;
        if (stripped === '.env') continue;
        filesPayload[stripped] = { content };
      }

      const definePayload = {
        files: filesPayload,
        template: artifact.sandpack_config?.template ?? artifact.template,
      };

      const res = await fetch('https://codesandbox.io/api/v1/sandboxes/define?json=1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(definePayload),
      });
      if (!res.ok) {
        const detail = await res.text();
        return textResult({
          error: `CodeSandbox define API failed: ${res.status} ${res.statusText}`,
          detail,
        });
      }
      const body = (await res.json()) as { sandbox_id?: string };
      const sandboxId = body.sandbox_id;
      if (!sandboxId) {
        return textResult({
          error: 'CodeSandbox returned a 200 with no sandbox_id',
          response: body,
        });
      }
      const url = `https://codesandbox.io/s/${sandboxId}`;

      const requiredVars = artifact.required_env_vars ?? [];
      const note = requiredVars.length
        ? `This artifact declares required_env_vars=${JSON.stringify(requiredVars)}. Set the prefixed names (VITE_${requiredVars[0]}, etc.) in CodeSandbox → Settings → Secret Keys to make them available at runtime.`
        : 'No required env vars to configure.';

      return textResult({
        artifactId,
        sandboxId,
        url,
        note,
      });
    }
  );
}
