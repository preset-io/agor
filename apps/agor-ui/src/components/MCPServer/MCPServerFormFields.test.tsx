import type { AgorClient } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Form } from 'antd';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MCPServerFormFields } from './MCPServerFormFields';

const showError = vi.fn();

vi.mock('@/utils/message', () => ({
  useThemedMessage: () => ({
    showSuccess: vi.fn(),
    showError,
    showInfo: vi.fn(),
    showWarning: vi.fn(),
  }),
}));

describe('MCPServerFormFields OAuth start', () => {
  beforeEach(() => vi.clearAllMocks());

  // #2332: every attempt — including the manual retry offered after a failed
  // start — must persist the current form and authorize against the ID that
  // save returns, never a stale one captured by an earlier attempt.
  it('re-persists the form on retry and starts against the freshly returned server ID', async () => {
    const testOAuth = vi.fn().mockResolvedValue({
      success: true,
      requiresBrowserFlow: true,
    });
    const startOAuth = vi.fn().mockResolvedValue({
      success: false,
      error: 'stop after recording the request',
    });
    const client = {
      io: { on: vi.fn(), off: vi.fn() },
      service: vi.fn((path: string) => {
        if (path === 'mcp-servers/test-oauth') return { create: testOAuth };
        if (path === 'mcp-servers/oauth-start') return { create: startOAuth };
        return {};
      }),
    } as unknown as AgorClient;
    const onPrepareOAuthStart = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce('server-a')
      .mockResolvedValueOnce('server-b');

    const Harness = () => {
      const [form] = Form.useForm();
      useEffect(() => {
        form.setFieldsValue({
          url: 'https://a.example/mcp',
          auth_type: 'oauth',
          oauth_compatibility_mode: 'legacy',
          oauth_dcr_mode: 'fallback',
        });
      }, [form]);

      return (
        <Form form={form}>
          <MCPServerFormFields
            mode="create"
            transport="http"
            authType="oauth"
            form={form}
            client={client}
            onPrepareOAuthStart={onPrepareOAuthStart}
          />
        </Form>
      );
    };

    render(<Harness />);

    // Testing auth is what reveals the browser-flow button.
    fireEvent.click(screen.getByRole('button', { name: 'Test Authentication' }));
    await waitFor(() => expect(testOAuth).toHaveBeenCalledTimes(1));
    expect(testOAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        mcp_url: 'https://a.example/mcp',
        compatibility_mode: 'legacy',
        dcr_mode: 'fallback',
      })
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Start OAuth Flow' }));
    await waitFor(() => expect(startOAuth).toHaveBeenCalledTimes(1));
    // The saved row is the authority — the start request carries only its ID.
    expect(startOAuth).toHaveBeenLastCalledWith({ mcp_server_id: 'server-a' });

    // The failed start turns the button into a manual retry, which must save again.
    fireEvent.change(screen.getByLabelText('URL'), {
      target: { value: 'https://b.example/mcp' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Retry OAuth Flow' }));

    await waitFor(() => expect(startOAuth).toHaveBeenCalledTimes(2));
    expect(onPrepareOAuthStart).toHaveBeenCalledTimes(2);
    expect(onPrepareOAuthStart.mock.invocationCallOrder[1]).toBeLessThan(
      startOAuth.mock.invocationCallOrder[1] as number
    );
    expect(startOAuth).toHaveBeenLastCalledWith({ mcp_server_id: 'server-b' });
    expect(await screen.findByText('stop after recording the request')).toBeInTheDocument();
  });
});
