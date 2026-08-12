import type { AgorClient } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Form } from 'antd';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MCPServerFormFields } from './MCPServerFormFields';

const showError = vi.fn();

vi.mock('@/utils/message', () => ({
  useThemedMessage: () => ({
    showError,
    showInfo: vi.fn(),
    showSuccess: vi.fn(),
    showWarning: vi.fn(),
  }),
}));

describe('MCPServerFormFields OAuth recovery', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders safe DCR diagnostics and opens the existing manual client fields', async () => {
    const testOAuth = vi.fn().mockResolvedValue({
      success: true,
      requiresBrowserFlow: true,
      message: 'OAuth 2.1 metadata discovered.',
    });
    const startOAuth = vi.fn().mockResolvedValue({
      success: false,
      error:
        'Dynamic Client Registration failed (HTTP 400) at stage dcr_registration. Provider response: invalid_client_metadata — redirect URI is not approved. The provider rejected the configured OAuth redirect URI. Enter the Client ID and Client Secret for a pre-registered OAuth app in Advanced — OAuth settings, then retry.',
      diagnostic: {
        stage: 'dcr_registration',
        http_status: 400,
        error: 'invalid_client_metadata',
        error_description: 'redirect URI is not approved',
      },
    });
    const client = {
      service: vi.fn((path: string) => {
        if (path === 'mcp-servers/test-oauth') return { create: testOAuth };
        if (path === 'mcp-servers/oauth-start') return { create: startOAuth };
        throw new Error(`unexpected service ${path}`);
      }),
      io: { on: vi.fn(), off: vi.fn() },
    } as unknown as AgorClient;
    const saveBeforeOAuthRetry = vi.fn().mockResolvedValue(true);

    const TestForm = () => {
      const [form] = Form.useForm();
      useEffect(() => {
        form.setFieldsValue({ url: 'https://mcp.example.com', auth_type: 'oauth' });
      }, [form]);
      return (
        <Form
          form={form}
          initialValues={{
            url: 'https://mcp.example.com',
          }}
        >
          <MCPServerFormFields
            mode="edit"
            transport="http"
            authType="oauth"
            form={form}
            client={client}
            serverId="server-1"
            onSaveBeforeOAuthRetry={saveBeforeOAuthRetry}
          />
        </Form>
      );
    };

    render(<TestForm />);

    fireEvent.click(screen.getByRole('button', { name: 'Test Authentication' }));
    await waitFor(() => expect(testOAuth).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Start OAuth Flow' })).toBeVisible()
    );

    fireEvent.click(screen.getByRole('button', { name: 'Start OAuth Flow' }));
    expect(await screen.findByText('OAuth setup needs attention')).toBeInTheDocument();
    expect(screen.getAllByText(/HTTP 400/).length).toBeGreaterThan(0);
    expect(screen.getByText(/redirect URI is not approved/)).toBeInTheDocument();
    expect(screen.queryByText(/figma/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open OAuth settings' }));
    await waitFor(() => expect(screen.getByLabelText('Client ID')).toBeVisible());
    expect(screen.getByLabelText('Client Secret')).toBeVisible();
    expect(startOAuth).toHaveBeenCalledWith(expect.objectContaining({ mcp_server_id: 'server-1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save OAuth settings & retry' }));
    await waitFor(() => expect(saveBeforeOAuthRetry).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(startOAuth).toHaveBeenCalledTimes(2));
    expect(showError).not.toHaveBeenCalled();
  });
});
