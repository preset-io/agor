import { type BranchEnvironmentInstance, hasActiveEnvironmentCommand } from '@agor/core/types';
import { Alert, Collapse, Space, Typography, theme } from 'antd';
import { getEnvironmentCommandStatus } from '../../utils/environmentCommand';
import { Ansi } from '../AnsiText';

function CommandOutput({ environment }: { environment: BranchEnvironmentInstance }) {
  const { token } = theme.useToken();
  const attempt = environment.command_attempt;
  const active = hasActiveEnvironmentCommand(environment);
  // A previous result can remain while a new command is in flight.
  const result = active ? undefined : environment.last_command;
  const output = attempt?.output || result?.output || (!attempt && environment.last_error);
  const timestamp = attempt?.requested_at ?? result?.timestamp;
  return (
    <Space orientation="vertical" style={{ width: '100%', minWidth: 0 }}>
      {timestamp && (
        <Typography.Text type="secondary">{new Date(timestamp).toLocaleString()}</Typography.Text>
      )}
      {active && attempt && (
        <Typography.Text type="secondary">
          Result deadline: {new Date(attempt.result_deadline).toLocaleString()}
        </Typography.Text>
      )}
      {result?.message && <Typography.Text>{result.message}</Typography.Text>}
      {(attempt?.output_truncated || result?.output_truncated) && (
        <Typography.Text type="warning">Command output truncated.</Typography.Text>
      )}
      <pre
        style={{
          margin: 0,
          padding: token.paddingSM,
          background: token.colorFillAlter,
          borderRadius: token.borderRadius,
          maxHeight: '45vh',
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          fontSize: token.fontSizeSM,
        }}
      >
        {output ? <Ansi>{output}</Ansi> : 'No command output received.'}
      </pre>
    </Space>
  );
}

export function EnvironmentCommandLogs({
  environment,
}: {
  environment?: BranchEnvironmentInstance;
}) {
  const status = getEnvironmentCommandStatus(environment);
  if (!environment) return <Typography.Text type="secondary">No command history.</Typography.Text>;
  return (
    <Space orientation="vertical" style={{ width: '100%', minWidth: 0 }}>
      {status && (
        <>
          <Typography.Text strong>{status.text}</Typography.Text>
          {status.type === 'warning' && (
            <Alert
              type="warning"
              showIcon
              title="Output may be incomplete. Check provider state before retrying."
            />
          )}
          <CommandOutput environment={environment} />
        </>
      )}
      {!!environment.command_history?.length && (
        <Collapse
          size="small"
          items={environment.command_history.map(({ attempt, result }) => {
            const previous: BranchEnvironmentInstance = {
              status: 'stopped',
              command_attempt: attempt,
              last_command: result,
            };
            return {
              key: attempt.id,
              label: `Previous ${getEnvironmentCommandStatus(previous)?.text.toLowerCase()} · ${new Date(attempt.requested_at).toLocaleString()}`,
              children: <CommandOutput environment={previous} />,
            };
          })}
        />
      )}
      {!status && !environment.command_history?.length && (
        <Typography.Text type="secondary">No command history.</Typography.Text>
      )}
    </Space>
  );
}
