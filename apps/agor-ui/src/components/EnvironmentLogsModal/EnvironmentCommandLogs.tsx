import { type BranchEnvironmentInstance, hasActiveEnvironmentCommand } from '@agor/core/types';
import { Collapse, Space, Typography, theme } from 'antd';
import { getEnvironmentCommandStatus } from '../../utils/environmentCommand';
import { Ansi } from '../AnsiText';
import { CompactNotice } from '../CompactNotice';
import { DIDNT_FINISH, ENVIRONMENT_REPORTED_ERROR } from '../EnvironmentPill/environmentStatusCopy';

function CommandOutput({ environment }: { environment: BranchEnvironmentInstance }) {
  const { token } = theme.useToken();
  const attempt = environment.command_attempt;
  const active = hasActiveEnvironmentCommand(environment);
  // A previous result can remain while a new command is in flight.
  const result = active ? undefined : environment.last_command;
  const output = attempt?.output || result?.output;
  const unconfirmed = result?.status === 'unknown' || (!active && !!attempt && !result);
  // `last_error` isn't command output, and it's stale once the status leaves `error`.
  const reportedError =
    !attempt && !result && environment.status === 'error' ? environment.last_error : undefined;
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
      {unconfirmed ? (
        <CompactNotice
          type="warning"
          message="Agor couldn't confirm how this command ended. The output may be incomplete."
          details={result?.message ? [{ label: 'Result', value: result.message }] : undefined}
        />
      ) : result?.status === 'failed' ? (
        <CompactNotice
          type="error"
          message={DIDNT_FINISH[result.action]}
          details={
            result.message ? [{ label: 'Output', value: result.message, code: true }] : undefined
          }
        />
      ) : reportedError ? (
        <CompactNotice
          type="error"
          message={ENVIRONMENT_REPORTED_ERROR}
          details={[{ label: 'Error', value: reportedError, code: true }]}
        />
      ) : (
        result?.message && <Typography.Text>{result.message}</Typography.Text>
      )}
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
  const staleError =
    !environment?.command_attempt && !environment?.last_command && environment?.status !== 'error';
  const status = staleError ? null : getEnvironmentCommandStatus(environment);
  if (!environment) return <Typography.Text type="secondary">No command history.</Typography.Text>;
  return (
    <Space orientation="vertical" style={{ width: '100%', minWidth: 0 }}>
      {status && (
        <>
          {status.type === 'info' && <Typography.Text strong>{status.text}</Typography.Text>}
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
