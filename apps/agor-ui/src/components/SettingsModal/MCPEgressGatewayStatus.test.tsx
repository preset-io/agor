import type { AgorClient } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntdApp } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { MCPEgressGatewayStatus } from './MCPEgressGatewayStatus';

function clientFor(status: object) {
  return {
    service: (path: string) =>
      path === 'mcp-egress/status' ? { find: vi.fn().mockResolvedValue(status) } : {},
  } as unknown as AgorClient;
}

describe('MCPEgressGatewayStatus', () => {
  it('keeps the Feathers service receiver when it reads and changes status', async () => {
    const gatewayService = {
      status: {
        mode: 'off',
        supported_transports: [],
        unsupported_transports: ['stdio'],
        in_flight_requests: 0,
        provider_in_flight_requests: 0,
        reserved_requests: 0,
        oldest_request_ms: 0,
        excluded_servers: [],
        excluded_servers_truncated: false,
        admission_available: null,
        operator: true,
        guarantee: 'Direct mode has no gateway admission guarantee.',
      },
      find(this: { status: object }) {
        return Promise.resolve(this.status);
      },
      patch(this: { status: Record<string, unknown> }, _id: null, data: { mode: string }) {
        this.status = { ...this.status, mode: data.mode };
        return Promise.resolve({ mode: data.mode });
      },
    };
    const client = {
      service: (path: string) => (path === 'mcp-egress/status' ? gatewayService : {}),
    } as unknown as AgorClient;

    render(
      <AntdApp>
        <MCPEgressGatewayStatus client={client} connectionReady />
      </AntdApp>
    );

    expect(await screen.findByText('MCP gateway is off')).toBeInTheDocument();
    expect(screen.queryByText('MCP gateway status unavailable')).not.toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'MCP gateway rollout mode' }));
    fireEvent.click(await screen.findByTitle('observe'));

    expect(await screen.findByText('MCP gateway is observing')).toBeInTheDocument();
  });

  it('renders the exact enforced guarantee and truthful transport lists', async () => {
    const client = clientFor({
      mode: 'enforced',
      supported_transports: ['streamable-http-buffered'],
      unsupported_transports: ['stdio', 'websocket', 'unbounded-streaming-response'],
      in_flight_requests: 2,
      provider_in_flight_requests: 1,
      reserved_requests: 1,
      oldest_request_ms: 12,
      excluded_servers: [
        {
          mcp_server_id: 'stdio-server',
          name: 'Local stdio',
          reason: 'transport_not_mediated',
          recovery: 'Configure bounded Streamable HTTP.',
        },
      ],
      excluded_servers_truncated: true,
      admission_available: null,
      operator: false,
      guarantee:
        'No request hop is admitted after a committed authority change. Requests admitted before that commit may complete.',
    });

    render(
      <AntdApp>
        <MCPEgressGatewayStatus client={client} connectionReady />
      </AntdApp>
    );

    const status = await screen.findByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent('All stdio and unsupported transports fail closed');
    expect(
      screen.getByRole('list', { name: 'MCP gateway supported transports' })
    ).toHaveTextContent('streamable-http-buffered');
    expect(
      screen.getByRole('list', { name: 'MCP gateway unsupported transports' })
    ).toHaveTextContent('stdiowebsocketunbounded-streaming-response');
    expect(status).toHaveTextContent('Requests admitted before that commit may complete');
    expect(status).toHaveTextContent('admission not independently probed');
    expect(status).toHaveTextContent('2 local active');
    expect(status).toHaveTextContent('1 provider in flight');
    expect(status).toHaveTextContent('1 admission reserved');
    expect(
      screen.getByRole('list', { name: 'MCP servers excluded from gateway mediation' })
    ).toHaveTextContent('Local stdio: Configure bounded Streamable HTTP.');
    expect(status).toHaveTextContent('Showing the first 100 server diagnostics');
    expect(
      screen.queryByRole('combobox', { name: 'MCP gateway rollout mode' })
    ).not.toBeInTheDocument();
  });

  it('always renders the default-off warning even with zero counts', async () => {
    const find = vi.fn().mockResolvedValue({
      mode: 'off',
      supported_transports: [],
      unsupported_transports: ['stdio'],
      in_flight_requests: 0,
      provider_in_flight_requests: 0,
      reserved_requests: 0,
      oldest_request_ms: 0,
      excluded_servers: [],
      excluded_servers_truncated: false,
      admission_available: null,
      operator: true,
      guarantee: 'Direct mode has no gateway admission guarantee.',
    });
    const client = { service: () => ({ find }) } as unknown as AgorClient;
    render(
      <AntdApp>
        <MCPEgressGatewayStatus client={client} connectionReady />
      </AntdApp>
    );

    expect(await screen.findByText('MCP gateway is off')).toBeInTheDocument();
    expect(screen.getByText(/reusable credentials/)).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'MCP gateway rollout mode' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh MCP gateway status' })).toBeInTheDocument();
    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));
  });

  it('does not render noisy operator state for a non-operator in default-off mode', async () => {
    const client = clientFor({
      mode: 'off',
      supported_transports: [],
      unsupported_transports: ['stdio'],
      in_flight_requests: 0,
      provider_in_flight_requests: 0,
      reserved_requests: 0,
      oldest_request_ms: 0,
      excluded_servers: [],
      excluded_servers_truncated: false,
      admission_available: null,
      operator: false,
      guarantee: 'Direct mode has no gateway admission guarantee.',
    });
    render(
      <AntdApp>
        <MCPEgressGatewayStatus client={client} connectionReady />
      </AntdApp>
    );
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  });
});
