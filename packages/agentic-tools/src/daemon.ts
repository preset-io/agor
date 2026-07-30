import { OPENCODE_DAEMON_CONTRIBUTION } from '@agor/agentic-tool-opencode/daemon';
import type { AgorConfig } from '@agor/core/config';
import type { AgenticToolName, Session } from '@agor/core/types';

type ExecutionAdmission = (input: {
  tenantId: string | undefined;
  config: Pick<AgorConfig, 'multi_tenancy'>;
}) => void;

const EXECUTION_ADMISSION: Partial<Record<AgenticToolName, ExecutionAdmission>> = {
  [OPENCODE_DAEMON_CONTRIBUTION.name]: OPENCODE_DAEMON_CONTRIBUTION.admitExecutor,
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
  [OPENCODE_DAEMON_CONTRIBUTION.name]: OPENCODE_DAEMON_CONTRIBUTION.getExecutorPayload,
};

export function getAgenticToolExecutorPayload(
  tool: AgenticToolName,
  input: Parameters<ExecutorPayloadContribution>[0]
): Record<string, unknown> {
  return EXECUTOR_PAYLOAD[tool]?.(input) ?? {};
}

export * from '@agor/agentic-tool-opencode/daemon';
