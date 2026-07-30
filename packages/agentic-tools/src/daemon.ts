import type { AgorConfig } from '@agor/core/config';
import type { AgenticToolName, Session } from '@agor/core/types';
import {
  assertOpenCodeExecutionAllowed,
  resolveOpenCodeTaskCredentialNamespace,
} from '../opencode/daemon/index.js';

type ExecutionAdmission = (input: {
  tenantId: string | undefined;
  config: Pick<AgorConfig, 'multi_tenancy'>;
}) => void;

const EXECUTION_ADMISSION: Partial<Record<AgenticToolName, ExecutionAdmission>> = {
  opencode: assertOpenCodeExecutionAllowed,
};

export async function admitAgenticToolExecutor<T>(
  input: {
    tool: AgenticToolName;
    tenantId: string | undefined;
    config: Pick<AgorConfig, 'multi_tenancy'>;
  },
  admitted: () => Promise<T>
): Promise<T> {
  const admission = EXECUTION_ADMISSION[input.tool];
  admission?.({ tenantId: input.tenantId, config: input.config });
  return admitted();
}

type ExecutorPayloadContribution = (input: {
  tenantId: string;
  session: Pick<Session, 'created_by' | 'unix_username'>;
  homeDir: string;
}) => Record<string, unknown>;

const EXECUTOR_PAYLOAD: Partial<Record<AgenticToolName, ExecutorPayloadContribution>> = {
  opencode: (input) => ({
    dataHome: resolveOpenCodeTaskCredentialNamespace(input).dataHome,
  }),
};

export function getAgenticToolExecutorPayload(
  tool: AgenticToolName,
  input: Parameters<ExecutorPayloadContribution>[0]
): Record<string, unknown> {
  return EXECUTOR_PAYLOAD[tool]?.(input) ?? {};
}

export * from '../opencode/daemon/index.js';
