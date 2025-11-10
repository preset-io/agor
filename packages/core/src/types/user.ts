import type { UserID } from './id';
import type {
  AgenticToolName,
  CodexApprovalPolicy,
  CodexNetworkAccess,
  CodexSandboxMode,
} from './agentic-tool';
import type { PermissionMode } from './session';

/**
 * User role types
 * - owner: Full system access, can manage all users and settings
 * - admin: Can manage most resources, cannot modify owner
 * - member: Standard user access, can create and manage own sessions
 * - viewer: Read-only access
 */
export type UserRole = 'owner' | 'admin' | 'member' | 'viewer';

/**
 * Model configuration for session creation
 */
export interface DefaultModelConfig {
  /** Model selection mode: alias or exact */
  mode?: 'alias' | 'exact';
  /** Model identifier (alias or exact ID) */
  model?: string;
  /** Thinking mode controls extended thinking token allocation */
  thinkingMode?: 'auto' | 'manual' | 'off';
  /** Manual thinking token budget (used when thinkingMode='manual') */
  manualThinkingTokens?: number;
}

/**
 * Default agentic tool configuration per tool
 */
export interface DefaultAgenticToolConfig {
  /** Default model configuration */
  modelConfig?: DefaultModelConfig;
  /** Default permission mode (Claude/Gemini unified mode) */
  permissionMode?: PermissionMode;
  /** Default MCP server IDs to attach */
  mcpServerIds?: string[];
  /** Codex-specific: sandbox mode */
  codexSandboxMode?: CodexSandboxMode;
  /** Codex-specific: approval policy */
  codexApprovalPolicy?: CodexApprovalPolicy;
  /** Codex-specific: network access */
  codexNetworkAccess?: CodexNetworkAccess;
}

/**
 * Default agentic configuration per tool
 */
export interface DefaultAgenticConfig {
  'claude-code'?: DefaultAgenticToolConfig;
  codex?: DefaultAgenticToolConfig;
  gemini?: DefaultAgenticToolConfig;
  opencode?: DefaultAgenticToolConfig;
}

/**
 * Available task completion chime sounds
 */
export type ChimeSound =
  | 'gentle-chime'
  | 'notification-bell'
  | '8bit-coin'
  | 'retro-coin'
  | 'power-up'
  | 'you-got-mail'
  | 'success-tone';

/**
 * Audio preferences for task completion notifications
 */
export interface AudioPreferences {
  /** Enable/disable task completion chimes */
  enabled: boolean;
  /** Selected chime sound */
  chime: ChimeSound;
  /** Volume level (0.0 to 1.0) */
  volume: number;
  /** Minimum task duration in seconds to play chime (0 = always play) */
  minDurationSeconds: number;
}

/**
 * User preferences structure
 */
export interface UserPreferences {
  audio?: AudioPreferences;
  // Future preferences can be added here
  [key: string]: unknown;
}

/**
 * User type - Authentication and authorization
 */
export interface User {
  user_id: UserID;
  email: string;
  name?: string;
  emoji?: string; // User emoji for visual identity (like boards)
  role: UserRole;
  avatar?: string;
  preferences?: UserPreferences;
  onboarding_completed: boolean;
  created_at: Date;
  updated_at?: Date;
  // API key status (boolean only, never exposes actual keys)
  api_keys?: {
    ANTHROPIC_API_KEY?: boolean; // true = key is set, false/undefined = not set
    OPENAI_API_KEY?: boolean;
    GEMINI_API_KEY?: boolean;
  };
  // Environment variable status (boolean only, never exposes actual values)
  env_vars?: Record<string, boolean>; // { "GITHUB_TOKEN": true, "NPM_TOKEN": false }
  // Default agentic tool configuration (prepopulates session creation forms)
  default_agentic_config?: DefaultAgenticConfig;
}

/**
 * Create user input (password required, not stored in User type)
 */
export interface CreateUserInput {
  email: string;
  password: string;
  name?: string;
  emoji?: string;
  role?: UserRole;
}

/**
 * Update user input
 */
export interface UpdateUserInput {
  email?: string;
  password?: string;
  name?: string;
  emoji?: string;
  role?: UserRole;
  avatar?: string;
  preferences?: UserPreferences;
  onboarding_completed?: boolean;
  // API keys for update (accepts plaintext, encrypted before storage)
  api_keys?: {
    ANTHROPIC_API_KEY?: string | null; // string = set key, null = clear key
    OPENAI_API_KEY?: string | null;
    GEMINI_API_KEY?: string | null;
  };
  // Environment variables for update (accepts plaintext, encrypted before storage)
  env_vars?: Record<string, string | null>; // { "GITHUB_TOKEN": "ghp_...", "NPM_TOKEN": null }
  // Default agentic tool configuration
  default_agentic_config?: DefaultAgenticConfig;
}
