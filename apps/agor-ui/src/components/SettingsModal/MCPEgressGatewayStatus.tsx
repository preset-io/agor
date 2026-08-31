import { Alert, Button, Flex, Modal, Select, Space, Tag, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';

type GatewayMode = 'off' | 'observe' | 'compatibility' | 'enforced';

interface GatewayStatus {
  mode: GatewayMode;
  supported_transports: string[];
  unsupported_transports: string[];
  in_flight_requests: number;
  provider_in_flight_requests: number;
  reserved_requests: number;
  oldest_request_ms: number;
  excluded_servers: Array<{
    mcp_server_id: string;
    name: string;
    reason: string;
    recovery: string;
  }>;
  excluded_servers_truncated: boolean;
  admission_available: boolean | null;
  operator: boolean;
  guarantee: string;
}

interface Props {
  client: import('@agor-live/client').AgorClient | null;
  connectionReady: boolean;
}

const modeCopy: Record<
  GatewayMode,
  { title: string; description: string; type: 'info' | 'warning' | 'success' }
> = {
  off: {
    title: 'MCP gateway is off',
    description: 'Executors receive direct MCP configuration and reusable credentials.',
    type: 'warning',
  },
  observe: {
    title: 'MCP gateway is observing',
    description:
      'Direct credentials still reach executors; observations do not provide revocation.',
    type: 'warning',
  },
  compatibility: {
    title: 'MCP gateway compatibility rollout',
    description:
      'Eligible bounded Streamable HTTP servers use task-scoped daemon capabilities. Ineligible servers are omitted rather than receiving credentials.',
    type: 'info',
  },
  enforced: {
    title: 'MCP gateway is enforced',
    description:
      'Only eligible bounded Streamable HTTP servers are projected. All stdio and unsupported transports fail closed.',
    type: 'success',
  },
};

function service(client: Props['client'], path: string) {
  return client?.service(path as never) as unknown as {
    find?: () => Promise<unknown>;
    patch?: (id: null, data: unknown) => Promise<unknown>;
  };
}

export function MCPEgressGatewayStatus({ client, connectionReady }: Props) {
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const gatewayService = service(client, 'mcp-egress/status');
    if (!client || !connectionReady || typeof gatewayService?.find !== 'function') return;
    setBusy(true);
    try {
      setStatus((await gatewayService.find()) as GatewayStatus);
      setError(null);
    } catch {
      setError(
        'Gateway status is unavailable. Mediated MCP calls fail closed when admission cannot be checked.'
      );
    } finally {
      setBusy(false);
    }
  }, [client, connectionReady]);

  useEffect(() => {
    setStatus(null);
    void refresh();
  }, [refresh]);

  if (!status && !error) return null;
  if (error) {
    return (
      <Alert
        role="status"
        aria-live="polite"
        type="warning"
        showIcon
        title="MCP gateway status unavailable"
        description={
          <Space orientation="vertical">
            <span>{error}</span>
            <Button
              loading={busy}
              onClick={() => void refresh()}
              aria-label="Retry MCP gateway status"
            >
              Retry
            </Button>
          </Space>
        }
        style={{ marginBottom: 16 }}
      />
    );
  }
  if (!status) return null;
  if (
    !status.operator &&
    status.mode === 'off' &&
    status.in_flight_requests === 0 &&
    status.excluded_servers.length === 0
  ) {
    return null;
  }

  const copy = modeCopy[status.mode];
  const applyMode = async (
    mode: GatewayMode,
    acknowledgeRawSecretDowngrade = false,
    verifiedLegacyExecutorsFenced = false
  ) => {
    const gatewayService = service(client, 'mcp-egress/status');
    if (typeof gatewayService?.patch !== 'function') return;
    setBusy(true);
    try {
      await gatewayService.patch(null, {
        mode,
        ...(acknowledgeRawSecretDowngrade ? { acknowledge_raw_secret_downgrade: true } : {}),
        ...(verifiedLegacyExecutorsFenced ? { verified_legacy_executors_fenced: true } : {}),
      });
      setActionError(null);
      await refresh();
    } catch {
      setActionError('The rollout change was refused. Review daemon logs and retry.');
    } finally {
      setBusy(false);
    }
  };

  const selectMode = (mode: GatewayMode) => {
    if (
      (status.mode === 'compatibility' || status.mode === 'enforced') &&
      (mode === 'off' || mode === 'observe')
    ) {
      Modal.confirm({
        title: 'Restore raw credential egress?',
        content:
          'Emergency rollback remains available, but it can send reusable MCP credentials to new executors. This acknowledgement is audited.',
        okText: 'Acknowledge and downgrade',
        okButtonProps: { danger: true, 'aria-label': 'Acknowledge raw credential downgrade' },
        onOk: () => applyMode(mode, true),
      });
      return;
    }
    if (mode === 'enforced' && status.mode !== 'enforced') {
      Modal.confirm({
        title: 'Confirm legacy executors are fenced',
        content:
          'Terminate executors started before mediation. Gateway counters cannot prove legacy direct clients are gone.',
        okText: 'I verified the fence',
        onOk: () => applyMode(mode, false, true),
      });
      return;
    }
    void applyMode(mode);
  };

  return (
    <Alert
      role="status"
      aria-live="polite"
      type={copy.type}
      showIcon
      title={copy.title}
      description={
        <Flex vertical gap={8}>
          <Typography.Text>{copy.description}</Typography.Text>
          <Typography.Text>{status.guarantee}</Typography.Text>
          <Space wrap>
            <Tag>{status.in_flight_requests} local active</Tag>
            <Tag>{status.provider_in_flight_requests} provider in flight</Tag>
            <Tag>{status.reserved_requests} admission reserved</Tag>
            {status.oldest_request_ms > 0 && <Tag>oldest {status.oldest_request_ms} ms</Tag>}
            <Tag>
              admission{' '}
              {status.admission_available === null
                ? 'not independently probed'
                : status.admission_available
                  ? 'available'
                  : 'unavailable'}
            </Tag>
          </Space>
          <div>
            <Typography.Text strong>Supported now</Typography.Text>
            <ul aria-label="MCP gateway supported transports">
              {status.supported_transports.length ? (
                status.supported_transports.map((transport) => <li key={transport}>{transport}</li>)
              ) : (
                <li>None in this rollout mode</li>
              )}
            </ul>
            <Typography.Text strong>
              Not mediated (fails closed when mediation is active)
            </Typography.Text>
            <ul aria-label="MCP gateway unsupported transports">
              {status.unsupported_transports.map((transport) => (
                <li key={transport}>{transport}</li>
              ))}
            </ul>
          </div>
          <Typography.Text type="secondary">
            Agor does not claim provider-side cancellation or revocation for a request admitted
            before a mutation commits.
          </Typography.Text>
          {status.excluded_servers.length > 0 && (
            <div>
              <Typography.Text strong>Servers requiring action</Typography.Text>
              <ul aria-label="MCP servers excluded from gateway mediation">
                {status.excluded_servers.map((server) => (
                  <li key={server.mcp_server_id}>
                    <Typography.Text>{server.name}</Typography.Text>: {server.recovery}{' '}
                    <Typography.Text type="secondary">({server.reason})</Typography.Text>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {status.excluded_servers_truncated && (
            <Typography.Text type="secondary">
              Showing the first 100 server diagnostics. Narrow the server inventory for complete
              recovery details.
            </Typography.Text>
          )}
          <div role="alert" aria-live="assertive">
            {actionError}
          </div>
          <Space wrap>
            {status.operator && (
              <Select<GatewayMode>
                aria-label="MCP gateway rollout mode"
                value={status.mode}
                style={{ width: 200 }}
                disabled={busy}
                options={['off', 'observe', 'compatibility', 'enforced'].map((value) => ({
                  value: value as GatewayMode,
                  label: value,
                }))}
                onChange={selectMode}
              />
            )}
            <Button
              loading={busy}
              onClick={() => void refresh()}
              aria-label="Refresh MCP gateway status"
            >
              Refresh
            </Button>
          </Space>
        </Flex>
      }
      style={{ marginBottom: 16 }}
    />
  );
}
