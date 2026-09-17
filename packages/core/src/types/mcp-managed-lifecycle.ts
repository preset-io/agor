/** DB-only source-runtime lifecycle reports. They are not portable authority certificates. */
import type { MCPManagedOAuthRetirementStatus } from './mcp-managed-oauth';

export interface MCPManagedOAuthRetirementRequest {
  tenant_id: string;
  gate_generation: string;
  /** Correlation only; the live write-gate generation, not this echo, fences authority. */
  operation_id: string;
}
export interface MCPManagedOAuthRetirementReport
  extends MCPManagedOAuthRetirementRequest,
    MCPManagedOAuthRetirementStatus {
  version: 1;
}
export interface MCPManagedOAuthRetirementTargets {
  version: 1;
  tenant_ids: string[];
  next_after: string | null;
}

export interface MCPManagedOAuthCellRetirementRequest {
  cell_id: string;
  operation_id: string;
}
export interface MCPManagedOAuthCellRetirementReport extends MCPManagedOAuthCellRetirementRequest {
  version: 1;
  gate_generation: string;
}
export interface MCPManagedOAuthCellRetirementFence extends MCPManagedOAuthCellRetirementRequest {
  gate_generation: string;
}
