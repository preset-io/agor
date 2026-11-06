/**
 * `.agor` — a portable, secret-free zip of one or more AI teammates.
 *
 * The pack carries versioned section DTOs, never raw table rows, so packs move
 * between Agor releases and between SQLite and PostgreSQL installs without the
 * exact-migration lock the tenant archive needs. Every entry is listed in
 * `manifest.json` with its size and SHA-256; readers reject anything else.
 *
 * Layout (`<key>` is `t01`…):
 *
 *   manifest.json
 *   teammates/<key>/teammate.json
 *   teammates/<key>/board.json
 *   teammates/<key>/knowledge/manifest.yaml, docs/**.md   (Knowledge repository v2)
 *   teammates/<key>/knowledge/history.json
 *   teammates/<key>/artifacts/<nnnn>.json
 *   teammates/<key>/schedules.json
 *   teammates/<key>/sessions/<nnnn>.json, <nnnn>.messages.jsonl
 *   teammates/<key>/uploads/<upl_ref>.json, <upl_ref>.data
 *   teammates/<key>/git/state.json, repo.bundle, worktree/**
 *   teammates/<key>/sdk-home/claude/**                     (allow-listed)
 */

import { z } from 'zod';

export const AGOR_PACK = {
  format: 'agor-pack',
  version: 1,
  extension: '.agor',
  mimeType: 'application/zip',
  manifestPath: 'manifest.json',
  /** Compressed pack size accepted by the import routes. */
  maxBytes: 2 * 1024 * 1024 * 1024,
  /**
   * Chunk size of the resumable upload (`/agor-pack/uploads/chunked`), small
   * enough for ingress request limits in front of hosted workspaces.
   */
  chunkBytes: 8 * 1024 * 1024,
  maxEntries: 50_000,
  maxEntryBytes: 256 * 1024 * 1024,
  maxUncompressedBytes: 4 * 1024 * 1024 * 1024,
  /** JSON/YAML/Markdown entries are parsed in memory; keep them bounded. */
  maxTextEntryBytes: 64 * 1024 * 1024,
  maxTeammates: 50,
  recentSessionDays: 90,
} as const;

/** Pack sections; an export includes all of them unless a caller narrows the list. */
export const AGOR_PACK_SECTIONS = [
  'board',
  'knowledge',
  'knowledge_history',
  'artifacts',
  'schedules',
  'claude_memory',
  'uploads',
] as const;
export type AgorPackSection = (typeof AGOR_PACK_SECTIONS)[number];

export const AGOR_PACK_SESSION_MODES = ['none', 'last_90_days', 'all'] as const;
export type AgorPackSessionMode = (typeof AGOR_PACK_SESSION_MODES)[number];
/** Session history included when the exporter doesn't choose (UI, CLI, and API). */
export const AGOR_PACK_DEFAULT_SESSION_MODE: AgorPackSessionMode = 'last_90_days';

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const uuid = z.string().uuid();
const isoTimestamp = z.string().min(1).max(64);
const shortText = z.string().max(1_000);
const nonNegativeInt = z.number().int().nonnegative();

export const agorPackTeammateKey = z.string().regex(/^t[0-9]{2,3}$/);

export const agorPackExportRequestSchema = z
  .object({
    branch_ids: z.array(uuid).min(1).max(AGOR_PACK.maxTeammates),
    /** Everything by default; narrowing it is an API/CLI-only option. */
    sections: z
      .array(z.enum(AGOR_PACK_SECTIONS))
      .max(AGOR_PACK_SECTIONS.length)
      .default([...AGOR_PACK_SECTIONS]),
    sessions: z.enum(AGOR_PACK_SESSION_MODES).default(AGOR_PACK_DEFAULT_SESSION_MODE),
    include_others_sessions: z.boolean().default(false),
    /** Sessions to leave out (the preflight's "may contain passwords" list). */
    exclude_session_ids: z.array(uuid).max(100_000).default([]),
  })
  .strict();
/** What a client sends (defaults omitted). */
export type AgorPackExportRequest = z.input<typeof agorPackExportRequestSchema>;
/** A parsed request, defaults applied. */
export type AgorPackExportOptions = z.output<typeof agorPackExportRequestSchema>;

export const agorPackEntrySchema = z
  .object({ path: z.string().min(1).max(1024), bytes: nonNegativeInt, sha256: sha256Hex })
  .strict();
export type AgorPackEntry = z.infer<typeof agorPackEntrySchema>;

/** Environment-variant portability, derived from its lifecycle commands. */
export const AGOR_PACK_ENVIRONMENT_STATUSES = ['ok', 'needs_webhook', 'wont_run_in_cloud'] as const;
export type AgorPackEnvironmentStatus = (typeof AGOR_PACK_ENVIRONMENT_STATUSES)[number];

export const agorPackRequirementsSchema = z
  .object({
    env_vars: z
      .array(
        z
          .object({
            name: z.string().min(1).max(200),
            scope: z.enum(['global', 'session']).nullable(),
            used_by: z.array(shortText).max(100),
          })
          .strict()
      )
      .max(500),
    mcp_servers: z
      .array(
        z
          .object({
            name: z.string().min(1).max(200),
            display_name: shortText.nullable(),
            catalog_entry_name: shortText.nullable(),
            url: z.string().max(2048).nullable(),
            /** True when the server is not a catalog entry and is recreated disabled. */
            custom: z.boolean(),
            used_by: z.array(shortText).max(100),
          })
          .strict()
      )
      .max(200),
    gateway_channels: z
      .array(z.object({ channel_type: shortText, name: shortText }).strict())
      .max(100),
    agentic_tools: z.array(shortText).max(20),
  })
  .strict();
export type AgorPackRequirements = z.infer<typeof agorPackRequirementsSchema>;

/** Knowledge links kept as-is because they point outside the teammate's namespace. */
export const agorPackOutsideLinksSchema = z
  .object({ count: nonNegativeInt, namespaces: z.array(shortText).max(100) })
  .strict();
export type AgorPackOutsideLinks = z.infer<typeof agorPackOutsideLinksSchema>;

/** Archived rows a teammate pack leaves behind (plus Knowledge docs the exporter can't read). */
export const agorPackArchivedSkipsSchema = z
  .object({
    sessions: nonNegativeInt,
    knowledge_documents: nonNegativeInt,
    artifacts: nonNegativeInt,
    private_knowledge_documents: nonNegativeInt.optional(),
  })
  .strict();
export type AgorPackArchivedSkips = z.infer<typeof agorPackArchivedSkipsSchema>;

/**
 * Hosts only reachable on the source network (localhost, RFC 1918 addresses,
 * `*.internal` / `*.local` / `*.lan` names). Agor Cloud can't reach them.
 */
const PRIVATE_HOST =
  /(?<![\w.-])(localhost|\[::1\]|0\.0\.0\.0|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:internal|local|lan|localhost))(?![\w-]|\.[\w-])/i;

/** The first private-network host in `text` (a URL or command), or null. */
export function agorPackPrivateHost(text: string | null | undefined): string | null {
  return text ? (PRIVATE_HOST.exec(text)?.[1] ?? null) : null;
}

/** `pluralize(1, 'artifact')` → "1 artifact"; `pluralize(2, 'artifact')` → "2 artifacts". */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** "12 archived sessions skipped" lines (non-zero counts only). */
export function agorPackArchivedNotes(skips: AgorPackArchivedSkips | null | undefined): string[] {
  if (!skips) return [];
  return [
    skips.sessions ? `${pluralize(skips.sessions, 'archived session')} skipped` : null,
    skips.knowledge_documents
      ? `${pluralize(skips.knowledge_documents, 'archived Knowledge doc')} skipped`
      : null,
    skips.artifacts ? `${pluralize(skips.artifacts, 'archived artifact')} skipped` : null,
    skips.private_knowledge_documents
      ? `${pluralize(skips.private_knowledge_documents, 'private Knowledge doc')} skipped`
      : null,
  ].filter((note): note is string => note !== null);
}

/** "3 links point to knowledge outside this teammate (kept as-is): a, b". */
export function agorPackOutsideLinksNote(
  links: AgorPackOutsideLinks | null | undefined
): string | null {
  if (!links?.count) return null;
  const verb = links.count === 1 ? 'points' : 'point';
  const targets = links.namespaces.length ? `: ${links.namespaces.join(', ')}` : '';
  return `${pluralize(links.count, 'link')} ${verb} to knowledge outside this teammate (kept as-is)${targets}`;
}

/**
 * Section summaries recorded in the manifest so an import dry-run never has to
 * read the payload. Loose on purpose: a section added by a newer release is
 * reported and skipped instead of failing the whole pack.
 */
export const agorPackTeammateSectionsSchema = z.looseObject({
  board: z.object({ objects: nonNegativeInt }).strict().nullable(),
  knowledge: z
    .object({
      documents: nonNegativeInt,
      history_versions: nonNegativeInt,
      outside_links: agorPackOutsideLinksSchema.optional(),
    })
    .strict()
    .nullable(),
  artifacts: nonNegativeInt.nullable(),
  schedules: nonNegativeInt.nullable(),
  claude_memory: z.object({ files: nonNegativeInt, bytes: nonNegativeInt }).strict().nullable(),
  uploads: z
    .object({
      count: nonNegativeInt,
      bytes: nonNegativeInt,
      /** Attachments over `AGOR_PACK.maxEntryBytes`, left out (absent in older packs). */
      too_large: nonNegativeInt.optional(),
    })
    .strict()
    .nullable(),
  sessions: z
    .object({
      mode: z.enum(AGOR_PACK_SESSION_MODES),
      count: nonNegativeInt,
      messages: nonNegativeInt,
      others_included: z.boolean(),
      redacted_values: nonNegativeInt,
      /** Sessions with a redacted value (absent in older packs). */
      flagged: nonNegativeInt.optional(),
    })
    .strict()
    .nullable(),
  git: z
    .object({
      mode: z.enum(['remote', 'bundle']),
      head_sha: z.string().max(64).nullable(),
      unpushed_commits: nonNegativeInt,
      dirty_files: nonNegativeInt,
      deleted_files: nonNegativeInt,
      bundle: z.boolean(),
      skipped_files: z.array(shortText).max(200),
    })
    .strict()
    .nullable(),
  /** Absent in packs from releases that did not skip archived rows. */
  archived_skipped: agorPackArchivedSkipsSchema.optional(),
});
export type AgorPackTeammateSections = z.infer<typeof agorPackTeammateSectionsSchema>;

export const agorPackTeammateSummarySchema = z
  .object({
    key: agorPackTeammateKey,
    display_name: z.string().min(1).max(200),
    emoji: z.string().max(32).nullable(),
    source_branch_id: uuid,
    branch_name: z.string().min(1).max(255),
    repo: z
      .object({
        slug: z.string().min(1).max(255),
        remote_url: z.string().max(2048).nullable(),
        local_home: z.boolean(),
      })
      .strict(),
    sections: agorPackTeammateSectionsSchema,
    requirements: agorPackRequirementsSchema,
    environment: z
      .object({
        variant: shortText.nullable(),
        variants: z
          .array(
            z
              .object({
                name: shortText,
                status: z.enum(AGOR_PACK_ENVIRONMENT_STATUSES),
                match: shortText.nullable(),
              })
              .strict()
          )
          .max(50),
      })
      .strict(),
    warnings: z.array(shortText).max(100),
  })
  .strict();
export type AgorPackTeammateSummary = z.infer<typeof agorPackTeammateSummarySchema>;

export const agorPackManifestSchema = z
  .object({
    format: z.literal(AGOR_PACK.format),
    version: z.literal(AGOR_PACK.version),
    pack_id: uuid,
    created_at: isoTimestamp,
    source: z
      .object({
        agor_version: z.string().max(64),
        instance_label: shortText.nullable(),
        exported_by: z
          .object({ user_id: uuid, email: shortText.nullable(), name: shortText.nullable() })
          .strict(),
      })
      .strict(),
    options: z
      .object({
        sections: z.array(z.enum(AGOR_PACK_SECTIONS)),
        sessions: z.enum(AGOR_PACK_SESSION_MODES),
        include_others_sessions: z.boolean(),
      })
      .strict(),
    teammates: z.array(agorPackTeammateSummarySchema).min(1).max(AGOR_PACK.maxTeammates),
    entries: z.array(agorPackEntrySchema).max(AGOR_PACK.maxEntries),
    /** SHA-256 over the canonical entry list; the import idempotency key. */
    content_sha256: sha256Hex,
  })
  .strict();
export type AgorPackManifest = z.infer<typeof agorPackManifestSchema>;

/** Who originally authored an imported row. Metadata only — never ownership. */
export const agorPackAuthorSchema = z
  .object({ name: shortText.nullable(), email: shortText.nullable() })
  .strict();
export type AgorPackAuthor = z.infer<typeof agorPackAuthorSchema>;

const jsonRecord = z.record(z.string(), z.unknown());

export const agorPackTeammateFileSchema = z
  .object({
    version: z.literal(1),
    teammate: z
      .object({
        displayName: z.string().min(1).max(200),
        emoji: z.string().max(32).optional(),
        frameworkRepo: z.string().max(255).optional(),
        frameworkVersion: z.string().max(255).optional(),
      })
      .strict(),
    branch: z
      .object({
        name: z.string().min(1).max(255),
        ref: z.string().min(1).max(255),
        notes: z.string().max(100_000).nullable(),
        environment_variant: shortText.nullable(),
        custom_context: jsonRecord.nullable(),
      })
      .strict(),
    repo: z
      .object({
        slug: z.string().min(1).max(255),
        name: shortText.nullable(),
        remote_url: z.string().max(2048).nullable(),
        default_branch: shortText.nullable(),
        local_home: z.boolean(),
        environment: z.unknown().nullable(),
      })
      .strict(),
    /** Custom (non-catalog) MCP servers, secrets removed; recreated disabled. */
    mcp_servers: z
      .array(
        z
          .object({
            name: z.string().min(1).max(200),
            display_name: shortText.nullable(),
            description: z.string().max(10_000).nullable(),
            transport: z.enum(['stdio', 'http', 'sse']),
            url: z.string().max(2048).nullable(),
            command: z.string().max(4096).nullable(),
            args: z.array(z.string().max(4096)).max(100).nullable(),
            env_names: z.array(z.string().max(200)).max(200),
            header_names: z.array(z.string().max(200)).max(200),
            /** Absent in older packs (recreated global). */
            scope: z.enum(['global', 'session']).optional(),
            /**
             * Auth shape without secret values: secret fields survive only as
             * `{{ user.env.NAME }}` references. Absent in older packs.
             */
            auth: z
              .record(z.string().max(200), z.union([z.string().max(4096), z.boolean()]))
              .nullable()
              .optional(),
          })
          .strict()
      )
      .max(100),
    /**
     * Claude Code keys auto-memory by working directory
     * (`projects/<slug>/memory`); the importer renames this slug to the new
     * branch path's slug.
     */
    claude_project_slug: z.string().max(4096).nullable(),
    originally_by: agorPackAuthorSchema,
  })
  .strict();
export type AgorPackTeammateFile = z.infer<typeof agorPackTeammateFileSchema>;

export const agorPackBoardFileSchema = z
  .object({
    version: z.literal(1),
    /** `BoardExportBlob` (validated by `BoardRepository.validateBoardBlob`). */
    board: jsonRecord,
    /** Zone the teammate card was pinned to (board object id) and its position. */
    placement: z
      .object({
        zone_object_id: z.string().max(200).nullable(),
        position: z.object({ x: z.number(), y: z.number() }).strict(),
      })
      .strict()
      .nullable(),
    /** Board artifact object id → pack artifact file (`artifacts/<nnnn>.json`). */
    artifact_objects: z.record(z.string().max(200), z.string().regex(/^[0-9]{4}$/)),
  })
  .strict();
export type AgorPackBoardFile = z.infer<typeof agorPackBoardFileSchema>;

export const agorPackArtifactFileSchema = z
  .object({
    version: z.literal(1),
    name: z.string().min(1).max(500),
    description: z.string().max(10_000).nullable(),
    template: z.string().min(1).max(64),
    files: z.record(z.string().max(1024), z.string()).nullable(),
    dependencies: z.record(z.string().max(500), z.string().max(500)).nullable(),
    entry: z.string().max(1024).nullable(),
    sandpack_config: jsonRecord.nullable(),
    required_env_vars: z.array(z.string().max(200)).max(200).nullable(),
    agor_runtime: jsonRecord.nullable(),
    /** Grants are workspace-local authority; dropped on import and reported. */
    had_agor_grants: z.boolean(),
    originally_by: agorPackAuthorSchema,
  })
  .strict();
export type AgorPackArtifactFile = z.infer<typeof agorPackArtifactFileSchema>;

export const agorPackScheduleSchema = z
  .object({
    name: z.string().min(1).max(500),
    description: z.string().max(10_000).nullable(),
    cron_expression: z.string().min(1).max(200),
    timezone_mode: z.string().max(32),
    timezone: z.string().max(100).nullable(),
    prompt: z.string().max(1_000_000),
    /** Inline tool config; preset/default references are resolved by name on import. */
    agentic_tool_config: jsonRecord,
    preset_name: z.string().max(500).nullable(),
    allow_concurrent_runs: z.boolean(),
    retention: nonNegativeInt,
    /** MCP servers by name; resolved on import, unresolved ones are reported. */
    mcp_server_names: z.array(z.string().max(200)).max(100),
    was_enabled: z.boolean(),
    originally_by: agorPackAuthorSchema,
  })
  .strict();
export type AgorPackSchedule = z.infer<typeof agorPackScheduleSchema>;

export const agorPackSchedulesFileSchema = z
  .object({ version: z.literal(1), schedules: z.array(agorPackScheduleSchema).max(500) })
  .strict();

export const agorPackTaskSchema = z
  .object({
    source_task_id: uuid,
    full_prompt: z.string(),
    status: z.string().max(32),
    model: z.string().max(200).nullable(),
    created_at: isoTimestamp,
    completed_at: isoTimestamp.nullable(),
    duration_ms: z.number().nonnegative().nullable(),
    message_range: jsonRecord.nullable(),
  })
  .strict();
export type AgorPackTask = z.infer<typeof agorPackTaskSchema>;

export const agorPackSessionFileSchema = z
  .object({
    version: z.literal(1),
    session: z
      .object({
        source_session_id: uuid,
        title: z.string().max(10_000).nullable(),
        description: z.string().max(100_000).nullable(),
        agentic_tool: z.string().min(1).max(64),
        model_config: jsonRecord.nullable(),
        created_at: isoTimestamp,
        last_updated: isoTimestamp,
        parent_source_session_id: uuid.nullable(),
        forked_from_source_session_id: uuid.nullable(),
        originally_by: agorPackAuthorSchema,
      })
      .strict(),
    tasks: z.array(agorPackTaskSchema).max(100_000),
    /** Secret-shaped values redacted from this session (absent in older packs). */
    redacted_values: nonNegativeInt.optional(),
  })
  .strict();
export type AgorPackSessionFile = z.infer<typeof agorPackSessionFileSchema>;

/** One line of `sessions/<nnnn>.messages.jsonl`. */
export const agorPackMessageSchema = z
  .object({
    source_message_id: uuid,
    source_task_id: uuid.nullable(),
    type: z.string().min(1).max(64),
    role: z.string().min(1).max(64),
    index: nonNegativeInt,
    timestamp: isoTimestamp,
    content_preview: z.string(),
    content: z.unknown(),
    tool_uses: z.array(z.unknown()).nullable(),
    parent_tool_use_id: z.string().max(200).nullable(),
    metadata: jsonRecord.nullable(),
  })
  .strict();
export type AgorPackMessage = z.infer<typeof agorPackMessageSchema>;

export const agorPackUploadFileSchema = z
  .object({
    version: z.literal(1),
    ref: z.string().regex(/^upl_[0-9a-f-]{36}$/),
    source_session_id: uuid,
    name: z.string().min(1).max(500),
    mime_type: z.string().min(1).max(200),
    size: nonNegativeInt,
    created_at: isoTimestamp,
  })
  .strict();
export type AgorPackUploadFile = z.infer<typeof agorPackUploadFileSchema>;

export const agorPackKnowledgeHistorySchema = z
  .object({
    version: z.literal(1),
    documents: z
      .array(
        z
          .object({
            path: z.string().min(1).max(1024),
            versions: z
              .array(
                z
                  .object({
                    version_number: z.number().int().positive(),
                    title: z.string().max(1000).nullable(),
                    content: z.string(),
                    change_summary: z.string().max(10_000).nullable(),
                    created_at: isoTimestamp,
                    originally_by: agorPackAuthorSchema,
                  })
                  .strict()
              )
              .max(1_000),
          })
          .strict()
      )
      .max(10_000),
  })
  .strict();
export type AgorPackKnowledgeHistory = z.infer<typeof agorPackKnowledgeHistorySchema>;

export const agorPackGitStateSchema = z
  .object({
    version: z.literal(1),
    head_sha: z.string().max(64).nullable(),
    ref: z.string().max(255).nullable(),
    /** Tracked files deleted in the working tree (applied after the bundle). */
    deleted: z.array(z.string().max(4096)).max(50_000),
  })
  .strict();
export type AgorPackGitState = z.infer<typeof agorPackGitStateSchema>;

// ---------------------------------------------------------------------------
// Import contract
// ---------------------------------------------------------------------------

export const AGOR_PACK_IMPORT_STATUSES = ['staged', 'applying', 'applied', 'failed'] as const;
export type AgorPackImportStatus = (typeof AGOR_PACK_IMPORT_STATUSES)[number];

export const agorPackApplyRequestSchema = z
  .object({
    teammates: z.array(agorPackTeammateKey).min(1).max(AGOR_PACK.maxTeammates),
    /** `new` creates a board per teammate; otherwise an existing board id. */
    board_id: uuid.nullable().default(null),
    /** Leave out sessions the export flagged (a value was redacted). */
    skip_flagged_sessions: z.boolean().default(false),
  })
  .strict();
export type AgorPackApplyRequest = z.input<typeof agorPackApplyRequestSchema>;
export type AgorPackApplyOptions = z.output<typeof agorPackApplyRequestSchema>;

export type AgorPackFilesystemStatus = 'pending' | 'ready' | 'failed' | 'skipped';

export interface AgorPackTeammateResult {
  key: string;
  display_name: string;
  branch_id: string;
  board_id: string;
  knowledge_namespace_id: string | null;
  filesystem: AgorPackFilesystemStatus;
  filesystem_error?: string;
  remap: {
    artifacts: Record<string, string>;
    schedules: string[];
    sessions: Record<string, string>;
    uploads: string[];
  };
  warnings: string[];
}

/** Dry-run checks against the destination workspace. */
export interface AgorPackDryRunTeammate {
  key: string;
  display_name: string;
  repo_status: 'existing' | 'clone' | 'framework';
  already_imported_branch_id: string | null;
  warnings: string[];
}

/**
 * An apply claim not refreshed for this long belongs to a dead worker: it can
 * be taken over. (Its staged pack expires one blob TTL after the last
 * heartbeat.)
 */
export const AGOR_PACK_CLAIM_STALE_MS = 10 * 60 * 1000;

/**
 * Apply plan of a teammate that is not imported yet: every id its rows get
 * (and its branch name), allocated once and saved on the receipt before any
 * row is created. Each create uses its planned id and adopts a row that
 * already exists, so a retry after any crash never makes a second copy.
 */
export interface AgorPackTeammateProgress {
  repo_id: string;
  board_id: string;
  branch_id: string;
  branch_name: string;
  /** Artifact sequence in the pack → planned artifact id. */
  artifacts: Record<string, string>;
  /** Schedule index in the pack → planned schedule id. */
  schedules: Record<string, string>;
  /** Pack attachment ref → planned new ref (rewritten into messages). */
  upload_refs: Record<string, string>;
  /** Knowledge has no row id of its own; this flag commits with its writes. */
  knowledge_done: boolean;
  /** `sessions` holds the planned session ids. */
  remap: AgorPackTeammateResult['remap'];
  warnings: string[];
}

export interface AgorPackImport {
  import_id: string;
  status: AgorPackImportStatus;
  content_sha256: string;
  manifest: AgorPackManifest;
  dry_run: AgorPackDryRunTeammate[];
  results: AgorPackTeammateResult[];
  error: string | null;
  created_at: string;
  applied_at: string | null;
}

// ---------------------------------------------------------------------------
// Resumable upload (`/agor-pack/uploads/chunked`)
//
//   POST /agor-pack/uploads/chunked                    { size, sha256 } → state
//   GET  /agor-pack/uploads/chunked/:uploadId          state (what to resend)
//   PUT  /agor-pack/uploads/chunked/:uploadId/:index   raw chunk bytes → state
//   POST /agor-pack/uploads/chunked/:uploadId/complete → dry-run receipt
//
// Chunk `i` covers bytes [i * chunk_size, min(size, (i + 1) * chunk_size)).
// The upload id is derived from (size, sha256), so starting the same file
// again resumes it; a PUT of a chunk the server has is a no-op.
// ---------------------------------------------------------------------------

export const agorPackChunkedUploadInitSchema = z
  .object({ size: z.number().int().positive(), sha256: sha256Hex })
  .strict();
export type AgorPackChunkedUploadInit = z.infer<typeof agorPackChunkedUploadInitSchema>;

export interface AgorPackChunkedUpload {
  upload_id: string;
  size: number;
  sha256: string;
  chunk_size: number;
  chunks: number;
  /** Chunk indexes the server has, ascending. */
  received: number[];
  /** Set once the upload completed: its dry-run receipt. */
  import_id: string | null;
}

/** Number of chunks of a `size`-byte upload. */
export function agorPackChunkCount(size: number, chunkSize: number = AGOR_PACK.chunkBytes): number {
  return Math.ceil(size / chunkSize);
}

/** Byte length of chunk `index` (the last one may be shorter). */
export function agorPackChunkLength(
  size: number,
  index: number,
  chunkSize: number = AGOR_PACK.chunkBytes
): number {
  return Math.max(0, Math.min(chunkSize, size - index * chunkSize));
}

/** Where an imported teammate came from (on the imported branch). */
export interface AgorPackImportedFrom {
  pack_id: string;
  source_branch_id: string;
  originally_by: AgorPackAuthor;
  imported_at: string;
  /** The receipt (absent on teammates imported before it was recorded). */
  import_id?: string;
  /** What to reconnect (names only), for Finish setup. */
  requirements?: AgorPackRequirements;
}

/** `Branch.agor_pack`: server-managed, never exposed to prompt templates. */
export interface AgorPackBranchState {
  imported_from?: AgorPackImportedFrom;
  switch_over?: AgorPackSwitchOverState | null;
}

/** Recorded on a source branch by "Switch over"; cleared by Undo. */
export interface AgorPackSwitchOverState {
  switched_at: string;
  switched_by: string;
  disabled_schedule_ids: string[];
  disabled_channel_ids: string[];
}

/** Session counts (or estimated bytes) by owner and age. */
export interface AgorPackSessionTally {
  own: number;
  others: number;
  recent_own: number;
  recent_others: number;
}

/** A session whose history has secret-shaped text the export would redact. */
export interface AgorPackFlaggedSession {
  session_id: string;
  title: string | null;
  own: boolean;
  recent: boolean;
}

export interface AgorPackPreflightTeammate {
  branch_id: string;
  display_name: string;
  local_home: boolean;
  remote_url: string | null;
  sessions: AgorPackSessionTally;
  /** Estimated uncompressed size of that session history. */
  session_bytes: AgorPackSessionTally;
  /** Estimated size of everything else (artifacts, Knowledge, schedules). */
  other_bytes: number;
  flagged_sessions: AgorPackFlaggedSession[];
  /** The teammate has a board the exporter can view (it goes into the pack). */
  board: boolean;
  /** Attachments over `AGOR_PACK.maxEntryBytes`; an export leaves them out. */
  large_attachments: Array<{ name: string; size: number; own: boolean; recent: boolean }>;
  schedules: number;
  artifacts: number;
  knowledge_documents: number;
  knowledge_outside_links: AgorPackOutsideLinks;
  /** Archived rows on the teammate that an export leaves out. */
  archived: AgorPackArchivedSkips;
  requirements: AgorPackRequirements;
  environment: AgorPackTeammateSummary['environment'];
  switch_over: AgorPackSwitchOverState | null;
  warnings: string[];
}
