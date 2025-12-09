/**
 * ID Type Definitions
 *
 * Centralized type definitions for UUIDv7 identifiers used across all Agor entities.
 *
 * @see context/concepts/id-management.md
 * @see src/lib/ids.ts
 */

/**
 * UUIDv7 identifier (36 characters including hyphens)
 *
 * Format: 01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f
 *
 * Structure:
 * - First 48 bits: Unix timestamp in milliseconds
 * - Next 12 bits: Random sequence for monotonic ordering
 * - Last 62 bits: Random data for uniqueness
 *
 * Properties:
 * - Globally unique (2^122 possible values)
 * - Time-ordered (sortable by creation time)
 * - Excellent database index performance
 * - Standard compliant (RFC 9562)
 *
 * @example
 * const sessionId: UUID = "01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f";
 */
export type UUID = string & { readonly __brand: 'UUID' };

/**
 * Short ID prefix (8-16 characters, no hyphens)
 *
 * Used for display in UI/CLI and user input.
 * Maps to full UUID via prefix matching.
 *
 * Collision probability with 8-char prefix:
 * - < 1% with 10,000 entities
 * - ~50% with 65,536 entities (birthday paradox)
 *
 * When collisions occur, expand to 12 or 16 characters.
 *
 * @example
 * const short: ShortID = "01933e4a";       // 8 chars (default)
 * const longer: ShortID = "01933e4a7b89";  // 12 chars (for disambiguation)
 */
export type ShortID = string;

/**
 * Any length ID prefix for matching
 *
 * Used internally for flexible ID resolution.
 * Can be any partial prefix of a UUID (with or without hyphens).
 */
export type IDPrefix = string;

// ============================================================================
// Entity-Specific ID Types
// ============================================================================

/**
 * Session identifier
 *
 * Uniquely identifies a session across all boards and agents.
 *
 * @example
 * const sessionId: SessionID = "01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f";
 */
export type SessionID = UUID;

/**
 * Task identifier
 *
 * Uniquely identifies a task within the global task space.
 * Tasks are scoped to sessions via the `session_id` foreign key.
 *
 * @example
 * const taskId: TaskID = "0193a1b2-3c4d-7e5f-a8f3-9d2e1c4b5a6f";
 */
export type TaskID = UUID;

/**
 * Board identifier
 *
 * Uniquely identifies a board (collection of sessions).
 *
 * @example
 * const boardId: BoardID = "01935abc-def1-7234-a8f3-9d2e1c4b5a6f";
 */
export type BoardID = UUID;

/**
 * Agentic tool identifier
 *
 * Uniquely identifies an agentic coding tool configuration.
 *
 * @example
 * const agenticToolId: AgenticToolID = "01938abc-def1-7234-a8f3-9d2e1c4b5a6f";
 */
export type AgenticToolID = UUID;

/**
 * Message identifier
 *
 * Uniquely identifies a message in a conversation.
 * Messages are scoped to sessions via the `session_id` foreign key.
 *
 * @example
 * const messageId: MessageID = "0193d1e2-3f4a-7b5c-a8f3-9d2e1c4b5a6f";
 */
export type MessageID = UUID;

/**
 * User identifier
 *
 * Uniquely identifies a user in the system.
 *
 * @example
 * const userId: UserID = "0193f1a2-3b4c-7d5e-a8f3-9d2e1c4b5a6f";
 */
export type UserID = UUID;

/**
 * Worktree identifier
 *
 * Uniquely identifies a git worktree (isolated work context).
 *
 * @example
 * const worktreeId: WorktreeID = "0193g1h2-3i4j-7k5l-a8f3-9d2e1c4b5a6f";
 */
export type WorktreeID = UUID;

/**
 * Repository identifier
 *
 * Uniquely identifies a git repository registered with Agor.
 *
 * @example
 * const repoId: RepoID = "0193m1n2-3o4p-7q5r-a8f3-9d2e1c4b5a6f";
 */
export type RepoID = UUID;

/**
 * Comment identifier
 *
 * Uniquely identifies a board comment (human-to-human conversation).
 * Comments can be attached to boards, sessions, tasks, messages, or worktrees.
 *
 * @example
 * const commentId: CommentID = "0193h1i2-3j4k-7l5m-a8f3-9d2e1c4b5a6f";
 */
export type CommentID = UUID;

/**
 * Note: Concepts and Reports use file paths as identifiers, not UUIDs.
 *
 * - Concepts: ConceptPath (e.g., "core.md", "explorations/cli.md")
 * - Reports: ReportPath (e.g., "<session-id>/<task-id>.md")
 *
 * See: src/types/concept.ts and src/types/report.ts
 */
