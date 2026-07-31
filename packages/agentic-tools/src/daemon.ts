import { OPENCODE_DAEMON_CONTRIBUTION } from '@agor/agentic-tool-opencode/daemon';
import type { AgorConfig } from '@agor/core/config';
import type { AgenticToolName, Session } from '@agor/core/types';

type ExecutionAdmission = (input: {
  tenantId: string | undefined;
  config: Pick<AgorConfig, 'execution' | 'multi_tenancy'>;
}) => void;

type ExecutorPayloadContribution = (input: {
  tenantId: string;
  session: Pick<Session, 'created_by' | 'unix_username'>;
  homeDir: string;
}) => Record<string, unknown>;

interface DaemonAgenticToolIntegration {
  admitExecutor?: ExecutionAdmission;
  getExecutorPayload?: ExecutorPayloadContribution;
}

const DAEMON_INTEGRATIONS: Partial<Record<AgenticToolName, DaemonAgenticToolIntegration>> = {
  [OPENCODE_DAEMON_CONTRIBUTION.name]: OPENCODE_DAEMON_CONTRIBUTION,
};

export async function admitAgenticToolExecutor<T>(
  input: {
    tool: AgenticToolName;
    tenantId: string | undefined;
    config: Pick<AgorConfig, 'execution' | 'multi_tenancy'>;
  },
  admitted: () => Promise<T>
): Promise<T> {
  DAEMON_INTEGRATIONS[input.tool]?.admitExecutor?.({
    tenantId: input.tenantId,
    config: input.config,
  });
  return admitted();
}

export function getAgenticToolExecutorPayload(
  tool: AgenticToolName,
  input: Parameters<ExecutorPayloadContribution>[0]
): Record<string, unknown> {
  return DAEMON_INTEGRATIONS[tool]?.getExecutorPayload?.(input) ?? {};
}
