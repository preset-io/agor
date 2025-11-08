// src/types/ui.ts
// UI-specific types for view modes and component states
// (SessionViewMode moved to @agor/core/types/ui.ts)

/**
 * UI-only type for agent selection (different from AgenticTool which has UUIDv7 ID)
 */
export interface AgenticToolOption {
  id: string; // AgenticToolName as string
  name: string;
  icon: string;
  version?: string;
  description?: string;
  beta?: boolean; // Show beta badge for experimental features
}
