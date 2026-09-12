import type { DatadogTracer } from '../tracing/datadog';
import type { BranchID, TenantID } from '../types';

export interface WorkspaceScope {
  tenantId: TenantID;
  branchId: BranchID;
}
export interface Entry {
  kind: 'file' | 'directory' | 'symlink';
  hash: string;
  mode: number;
  size: number;
  target?: string;
  /** Tracked repository configuration admitted at extraction, retained across Git-less restore. */
  repositoryConfig?: true;
}
export type Tree = Record<string, Entry>;
export interface Mutation {
  path: string;
  operation: 'create' | 'replace' | 'delete' | 'rename' | 'mode';
  before?: Entry;
  after?: Entry;
  from?: string;
}
export interface ToolTicket {
  executorId: string;
  toolId: string;
  key: string;
  baseRevision: number;
  epoch: number;
  startedAt: number;
  expiresAt: number;
}
export interface ConflictPath {
  path: string;
  operation: Mutation['operation'];
  baseHash: string | null;
  currentHash: string | null;
  proposedHash: string | null;
}
export type CommitOutcome =
  | { status: 'committed'; revision: number }
  | {
      status: 'conflict';
      baseRevision: number;
      currentRevision: number;
      paths: ConflictPath[];
      executorId: string;
      toolId: string;
    };
export interface Receipt {
  ticket: ToolTicket;
  completedAt: number;
  mutations: Mutation[];
  outcome: CommitOutcome;
}
export interface WorkspaceState {
  schema: 1;
  authority?: 'worker-sql';
  scope: WorkspaceScope;
  revision: number;
  epoch: number;
  host: string | null;
  leaseUntil: number;
  tree: Tree;
  /** Tombstones are retained: delete/recreate must not defeat stale-writer checks. */
  versions: Record<string, number>;
  active: Record<string, ToolTicket>;
  receipts: Record<string, Receipt>;
  retiredExecutors?: Record<string, true>;
  maintenance?: string;
  checkpoint?: { hash: string; revision: number };
  updatedAt: number;
}
export interface WorkspaceMetadata {
  /** Must use the metadata store's clock, not a worker-supplied timestamp. */
  read(): Promise<{ state: WorkspaceState | null; now: number }>;
  /** Pure callback, under an exclusive SQL row lock. No filesystem/network work. */
  mutate<T>(
    work: (state: WorkspaceState | null, now: number) => { state: WorkspaceState; result: T }
  ): Promise<T>;
}
export interface WorkspaceBlobs {
  /** Immutable, tenant-scoped content addressed objects. put verifies hash. */
  put(hash: string, content: Buffer): Promise<void>;
  get(hash: string): Promise<Buffer>;
}
export interface WorkspaceMetric {
  name: string;
  value: number;
  outcome: 'ok' | 'error' | 'conflict';
}
export interface WorkspaceOptions {
  root: string;
  host: string;
  leaseMs: number;
  toolLeaseMs: number;
  clone: 'reflink' | 'copy';
  maximumBytes: number;
  maximumFiles: number;
  minimumFreeBytes: number;
  minimumFreeInodes: number;
  maximumActiveTools: number;
  maximumReceipts: number;
  exclude: string[];
  tracer?: DatadogTracer;
  observe?: (metric: WorkspaceMetric, context: Record<string, unknown>) => void;
}
export class WorkspaceError extends Error {
  constructor(
    readonly code:
      | 'FENCED'
      | 'BUSY'
      | 'CONFLICT'
      | 'CAPACITY'
      | 'CORRUPT'
      | 'UNSUPPORTED'
      | 'INVALID',
    message: string
  ) {
    super(message);
  }
}
