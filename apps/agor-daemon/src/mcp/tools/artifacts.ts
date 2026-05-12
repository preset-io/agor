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
import type {
  AgorGrants,
  AgorRuntimeConfig,
  BoardID,
  SandpackConfig,
  UserRole,
  UUID,
  WorktreeID,
} from '@agor/core/types';
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

const AgorRuntimeSchema = z
  .object({
    enabled: z
      .boolean()
      .optional()
      .describe(
        "Inject the daemon-side `agor-runtime.js` into the served bundle (as an iframe-level `<script>` via Sandpack's `externalResources`). Default: true. Set false to opt the artifact out of agent DOM introspection (e.g. if the artifact's own code conflicts with our message listener)."
      ),
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
- \`requiredEnvVars\`: array of env var NAMES the artifact needs (e.g. ["OPENAI_KEY", "STRIPE_KEY"]). The daemon synthesizes a per-viewer \`.env\` at render time using values from the viewer's stored env vars (Settings → Environment Variables). Names are stored without prefix; the daemon prefixes per template at render time. Currently only the \`react\` / \`react-ts\` mapping is verified end-to-end: those are CRA-backed (sandpack-react v2), so use \`process.env.REACT_APP_X\`. Other templates are best-effort and may need to be audited the first time an artifact publishes against them — the table in apps/agor-docs/pages/guide/artifacts.mdx tracks status. \`vanilla\` / \`vanilla-ts\` have no dotenv path (daemon warns and injects nothing).
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
- Secret VALUES are never sent to the LLM as-is — they're only injected into the served \`.env\` at view time. CAVEAT: if your artifact renders a secret-derived value into the DOM (e.g. \`<div>API: {key}</div>\`), an agent calling \`agor_artifacts_query_dom\` against your own running render WILL see the rendered text. Treat any \`agor_artifacts_query_*\` reply as potentially carrying secret-derived output if the artifact renders one.
- Missing user env vars render as "" — your app should detect that and surface a "configure SOMETHING in Settings" message rather than calling APIs with empty creds.
- For node.js / static templates without a dotenv path, env vars are NOT injected; the daemon emits a warning if you declared any.`,
      inputSchema: z.object({
        folderPath: z.string().describe('Absolute path to folder containing artifact files'),
        boardId: z
          .string()
          .optional()
          .describe(
            'Board to place the artifact on. REQUIRED when creating. IGNORED when updating (artifactId given) — to move an artifact between boards use agor_artifacts_update.'
          ),
        name: z
          .string()
          .optional()
          .describe(
            'Artifact display name. REQUIRED when creating; on update (artifactId given) defaults to the existing name if omitted. PASSING A DIFFERENT NAME ON UPDATE WILL RENAME THE ARTIFACT.'
          ),
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
        agorRuntime: AgorRuntimeSchema.describe(
          'Controls injection of the daemon-side `agor-runtime.js` (which powers agent DOM introspection via agor_artifacts_query_dom). Default: enabled.'
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
      const boardIdRaw = coerceString(args.boardId);
      const resolvedBoardId = boardIdRaw ? await resolveBoardId(ctx, boardIdRaw) : undefined;
      const resolvedArtifactId = coerceString(args.artifactId)
        ? await resolveArtifactId(ctx, coerceString(args.artifactId)!)
        : undefined;
      const artifact = await service.publishArtifact(
        {
          folderPath: coerceString(args.folderPath)!,
          board_id: resolvedBoardId,
          name: coerceString(args.name),
          artifact_id: resolvedArtifactId,
          template: args.template,
          public: args.public,
          sandpack_config: args.sandpackConfig as SandpackConfig | undefined,
          required_env_vars: args.requiredEnvVars,
          agor_grants: args.agorGrants as AgorGrants | undefined,
          agor_runtime: args.agorRuntime as AgorRuntimeConfig | undefined,
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
      // Mirror getStatus shape — `build_status` (not `status`) and `build_errors`
      // (always an array, never undefined) so agents can parse one schema across
      // both tools.
      return textResult({
        build_status: result.status,
        build_errors: result.errors,
      });
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

NOTE: sandpack_error and console_logs require a browser to be viewing the artifact. They are scoped to the calling user's render — you only see your own console output, never another viewer's.`,
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        artifactId: z.string().describe('Artifact ID'),
      }),
    },
    async (args) => {
      const service = ctx.app.service('artifacts') as unknown as ArtifactsService;
      const status = await service.getStatus(coerceString(args.artifactId)!, ctx.userId);
      return textResult(status);
    }
  );

  // Tool 4: agor_artifacts_delete
  server.registerTool(
    'agor_artifacts_delete',
    {
      description:
        "Delete an artifact. Owner or admin only — calling as a different user returns 'Forbidden'. Removes database record and board placement. Does not touch the filesystem.",
      annotations: { destructiveHint: true },
      inputSchema: z.object({
        artifactId: z.string().describe('Artifact ID to delete'),
      }),
    },
    async (args) => {
      const service = ctx.app.service('artifacts') as unknown as ArtifactsService;
      const artifactId = coerceString(args.artifactId)!;

      // deleteArtifact loads the row, runs the owner/admin check, performs
      // the delete, and returns the artifact so we can emit `removed`
      // without a redundant pre-delete fetch. role on AuthenticatedUser is
      // loosely typed as `string`; auth strategies enforce a valid value
      // upstream so the cast to UserRole is honest.
      const artifact = await service.deleteArtifact(
        artifactId,
        ctx.userId,
        ctx.authenticatedUser.role as UserRole
      );
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
        agorRuntime: AgorRuntimeSchema.describe(
          "Replace the artifact's agor_runtime config (controls agor-runtime.js injection)."
        ),
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
          agor_runtime: args.agorRuntime as AgorRuntimeConfig | undefined,
        },
        ctx.userId,
        ctx.authenticatedUser.role as UserRole
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

Writes a small \`agor.artifact.json\` sidecar alongside the source files. The sidecar carries metadata that doesn't fit in the file map (template, sandpack_config, required_env_vars, agor_grants) so a round-trip publish() can preserve it. **Do not delete \`agor.artifact.json\`** — without it, a republish will reset \`required_env_vars\` and \`agor_grants\` to empty. Build tools (Vite/CRA/etc.) ignore the sidecar.

Safety:
- Destination must be inside the target worktree (cannot escape via ".." or absolute paths).
- Default subpath is \`.agor/artifacts/<slug>-<short-id>\` derived from the artifact's name (kebab-cased, ASCII-only). Pass a custom subpath if you want a different location.
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
            'Worktree-relative path for the destination folder. Default: .agor/artifacts/<slug>-<short-id> derived from the artifact name. Must not be absolute or escape the worktree.'
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
        instructions: `Artifact materialized to ${result.destinationPath}. The folder includes \`agor.artifact.json\` — keep it: it carries template/sandpack_config/required_env_vars/agor_grants for round-trip publishing. Edit source files there, then call agor_artifacts_publish with folderPath=${result.destinationPath} and artifactId=${artifactId} to push changes back.`,
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
      try {
        const result = await service.exportToCodeSandbox(artifactId, ctx.userId);
        return textResult(result);
      } catch (err) {
        return textResult({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  );

  // Tool 10: agor_artifacts_query_dom
  server.registerTool(
    'agor_artifacts_query_dom',
    {
      description: `Query the rendered DOM of a running artifact via CSS selector.

Round-trip: this MCP call → daemon → WebSocket → your own browser tab(s) viewing the artifact → Sandpack iframe → \`agor-runtime.js\` (auto-injected at render time) → response back up the chain. Replies carry serialized matches: tag, attributes, textContent, outerHTML.

REQUIREMENTS:
- The artifact must have \`agor_runtime.enabled !== false\` (default is enabled). If the author disabled introspection, the call returns a clean error.
- A browser tab logged in as YOU must be currently viewing the artifact. The daemon scopes responses to the requesting user — another viewer's browser cannot answer your query (and so cannot leak their secret-bearing render).
- If no qualifying tab is open, the call times out (default 5s) with an error suggesting you open the artifact and retry.

Caps: 50 nodes max, 50KB outerHTML per node, 5KB textContent per node. Tightened for context budget.

Use cases:
- "Did my artifact actually render the new heading?" — \`{ selector: 'h1' }\`
- "Inspect a list of cards" — \`{ selector: '.card', multiple: true }\`
- "Get the full document" — use \`{ selector: 'html' }\`, or call \`agor_artifacts_query_document_html\` for an unstructured dump of the entire \`document.documentElement.outerHTML\`.`,
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        artifactId: z.string().describe('Artifact ID (full UUID or short prefix)'),
        selector: z
          .string()
          .describe('CSS selector to match (e.g. "h1", ".card", "[data-test=\'submit\']")'),
        multiple: z
          .boolean()
          .optional()
          .describe('querySelectorAll vs querySelector. Default: false (single match).'),
        maxNodes: z
          .number()
          .optional()
          .describe('Max nodes to return (capped at 50 by the runtime). Default: 50.'),
        timeoutMs: z
          .number()
          .optional()
          .describe('How long to wait for the browser to answer (500-30000). Default: 5000.'),
      }),
    },
    async (args) => {
      const service = ctx.app.service('artifacts') as unknown as ArtifactsService;
      const artifactId = await resolveArtifactId(ctx, coerceString(args.artifactId)!);
      try {
        const result = await service.queryArtifactRuntime({
          artifactId,
          userId: ctx.userId,
          kind: 'query_dom',
          args: {
            selector: coerceString(args.selector),
            multiple: args.multiple,
            maxNodes: args.maxNodes,
          },
          timeoutMs: args.timeoutMs,
        });
        return textResult(result);
      } catch (err) {
        return textResult({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  );

  // Tool 11: agor_artifacts_query_document_html
  server.registerTool(
    'agor_artifacts_query_document_html',
    {
      description: `Return the rendered artifact's full \`document.documentElement.outerHTML\` (unstructured dump).

Same round-trip as agor_artifacts_query_dom: requires \`agor_runtime.enabled\` and a browser tab logged in as YOU currently viewing the artifact.

Capped at 200KB. Truncated output ends with \`... [truncated]\`. For targeted queries prefer agor_artifacts_query_dom with a CSS selector — this tool is the "give me everything" escape hatch when you don't know what to look for yet.`,
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        artifactId: z.string().describe('Artifact ID (full UUID or short prefix)'),
        timeoutMs: z
          .number()
          .optional()
          .describe('How long to wait for the browser to answer (500-30000). Default: 5000.'),
      }),
    },
    async (args) => {
      const service = ctx.app.service('artifacts') as unknown as ArtifactsService;
      const artifactId = await resolveArtifactId(ctx, coerceString(args.artifactId)!);
      try {
        const result = await service.queryArtifactRuntime({
          artifactId,
          userId: ctx.userId,
          kind: 'document_html',
          args: {},
          timeoutMs: args.timeoutMs,
        });
        return textResult(result);
      } catch (err) {
        return textResult({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  );
}
