import type { AgenticToolModelConfigurationPolicy } from '@agor/core/models/browser';
import type {
  AgenticToolCapabilities,
  AgenticToolName,
  ApiKeyName,
  PersistedAgenticToolName,
} from '@agor/core/types';

/**
 * How the env var(s) in a {@link ConfigHomeOverride} interpret the path they are
 * pointed at. The distinction matters because the tools disagree:
 * - `config-dir`: the variable IS the config directory itself. Point it at the
 *   relocated home directly (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
 *   `CODEX_SQLITE_HOME`, `COPILOT_HOME`, `COPILOT_CACHE_HOME`).
 * - `home-root`: the variable is a home/base root the tool appends its own
 *   subdirectory to. Point it at the parent so the appended subdir lands inside
 *   the relocated home (`GEMINI_CLI_HOME` → the CLI appends `.gemini`; the
 *   `XDG_*` roots → OpenCode appends `opencode/`).
 */
export type ConfigHomeSemantics = 'config-dir' | 'home-root';

/**
 * Per-tool recipe for relocating a tool's SDK/config home via environment
 * variables. Recorded here (Phase 2) but not yet applied at runtime; a later
 * phase reads it to point the listed vars at a branch-scoped directory. Modeled
 * as a list because some tools (OpenCode's `XDG_*` set) need several vars set
 * together. The absence of this field on an integration is what makes its
 * derived {@link AgenticToolCapabilities.supportsConfigHomeOverride} `false`.
 */
export interface ConfigHomeOverride {
  /** How the listed vars interpret the path they receive. */
  semantics: ConfigHomeSemantics;
  /** Env var name(s) that must all be pointed at the relocated home. */
  envVars: readonly string[];
}

export interface AgenticToolIntegration {
  name: AgenticToolName;
  displayName: string;
  capabilities: AgenticToolCapabilities;
  authentication: 'api-key' | 'runtime-managed';
  apiKeyName?: ApiKeyName;
  keyCreationUrl?: string;
  billingUrl?: string;
  sdkVersion?: string;
  unverifiedTerminationReason?: string;
  /**
   * Env-var mapping for relocating this tool's SDK/config home. Absent when the
   * tool has no reliable relocation mechanism — that absence drives the derived
   * `capabilities.supportsConfigHomeOverride` flag (see `defineIntegration`).
   */
  configHomeOverride?: ConfigHomeOverride;
  /** Integration-owned model resolution and persisted-shape policy. */
  modelConfiguration?: AgenticToolModelConfigurationPolicy;
}

export type AgenticToolIntegrationRegistry = Readonly<
  Record<AgenticToolName, AgenticToolIntegration>
>;

export type AgenticToolDisplayNames = Readonly<Record<PersistedAgenticToolName, string>>;
