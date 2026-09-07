import type { AgorClient } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Form, type FormInstance } from 'antd';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MCPServerFormFields } from './MCPServerFormFields';
import { useFormRevision } from './mcp-form-requirements';

const showError = vi.fn();

vi.mock('@/utils/message', () => ({
  useThemedMessage: () => ({
    showSuccess: vi.fn(),
    showError,
    showInfo: vi.fn(),
    showWarning: vi.fn(),
  }),
}));

// The troubleshoot hook pulls in router + canvas-nav contexts that this bare
// harness doesn't provide; stub it so the form renders in isolation.
vi.mock('@/hooks/useTroubleshootError', () => ({
  useTroubleshootError: () => ({ showErrorWithTroubleshoot: vi.fn() }),
}));

// `getByRole('button', { name })` prices in an accessible-name and visibility
// pass over the whole form, and jsdom's getComputedStyle runs ~18ms per node
// against antd's injected stylesheets — ~2.5s per query here, which is what
// pushed these tests past the 15s timeout on CI. The label IS the accessible
// name on these buttons, so reach them through their text instead.
const buttonLabeled = (name: string) => {
  const button = screen.getByText(name).closest('button');
  if (!button) throw new Error(`No button labeled "${name}"`);
  return button;
};

const oauthButton = (name = 'Start OAuth Flow') => buttonLabeled(name);

describe('MCPServerFormFields OAuth start', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses an explicit visible control to clear a saved bearer secret', async () => {
    let capturedForm: FormInstance | undefined;
    const Harness = () => {
      const [form] = Form.useForm();
      capturedForm = form;
      useEffect(() => {
        form.setFieldsValue({ auth_type: 'bearer', auth_token: '••••••••' });
      }, [form]);
      return (
        <Form form={form}>
          <MCPServerFormFields
            mode="edit"
            transport="http"
            authType="bearer"
            form={form}
            client={null}
            authorityKey="user-a:admin:1"
            onPrepareOAuthStart={vi.fn().mockResolvedValue('saved-server')}
          />
        </Form>
      );
    };

    render(<Harness />);
    expect(await screen.findByText('Leaving this blank preserves the saved secret.')).toBeVisible();
    fireEvent.click(buttonLabeled('Clear saved secret'));
    expect(capturedForm?.getFieldValue('auth_token')).toBe('');
    expect(capturedForm?.getFieldValue('auth_token_clear')).toBe(true);
  });

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
      // Stands in for the owning modal, which bumps on every values change.
      const [formRevision, bumpFormRevision] = useFormRevision();
      useEffect(() => {
        form.setFieldsValue({
          // The name is what the save behind the start writes, so the button
          // stays blocked without one.
          name: 'a-server',
          url: 'https://a.example/mcp',
          auth_type: 'oauth',
          oauth_compatibility_mode: 'legacy',
          oauth_dcr_mode: 'fallback',
        });
        bumpFormRevision();
      }, [form, bumpFormRevision]);

      return (
        <Form form={form} onValuesChange={bumpFormRevision}>
          <MCPServerFormFields
            mode="create"
            transport="http"
            authType="oauth"
            form={form}
            client={client}
            authorityKey="user-a:admin:1"
            onPrepareOAuthStart={onPrepareOAuthStart}
            formRevision={formRevision}
          />
        </Form>
      );
    };

    render(<Harness />);

    // Testing auth is what reveals the browser-flow button.
    fireEvent.click(buttonLabeled('Test Authentication'));
    await waitFor(() => expect(testOAuth).toHaveBeenCalledTimes(1));
    expect(testOAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        mcp_url: 'https://a.example/mcp',
        compatibility_mode: 'legacy',
        dcr_mode: 'fallback',
      })
    );

    await screen.findByText('Start OAuth Flow');
    await waitFor(() => expect(oauthButton()).toBeEnabled());
    fireEvent.click(oauthButton());
    await waitFor(() => expect(startOAuth).toHaveBeenCalledTimes(1));
    // The saved row is the authority — the start request carries only its ID.
    expect(startOAuth).toHaveBeenLastCalledWith({ mcp_server_id: 'server-a' });

    // The failed start turns the button into a manual retry, which must save again.
    fireEvent.change(screen.getByLabelText('URL'), {
      target: { value: 'https://b.example/mcp' },
    });
    await screen.findByText('Retry OAuth Flow');
    fireEvent.click(oauthButton('Retry OAuth Flow'));

    await waitFor(() => expect(startOAuth).toHaveBeenCalledTimes(2));
    expect(onPrepareOAuthStart).toHaveBeenCalledTimes(2);
    expect(onPrepareOAuthStart.mock.invocationCallOrder[1]).toBeLessThan(
      startOAuth.mock.invocationCallOrder[1] as number
    );
    expect(startOAuth).toHaveBeenLastCalledWith({ mcp_server_id: 'server-b' });
    expect(await screen.findByText('stop after recording the request')).toBeInTheDocument();
  });

  // The OAuth start persists the row it binds to, so it needs everything a
  // write needs. A blank Name used to fail inside that save and report
  // nothing at all.
  it('withholds the OAuth start until its save can run, and names what it trips on', async () => {
    const testOAuth = vi.fn().mockResolvedValue({ success: true, requiresBrowserFlow: true });
    const startOAuth = vi.fn().mockResolvedValue({ success: false, error: 'unused' });
    const client = {
      io: { on: vi.fn(), off: vi.fn() },
      service: vi.fn((path: string) => {
        if (path === 'mcp-servers/test-oauth') return { create: testOAuth };
        if (path === 'mcp-servers/oauth-start') return { create: startOAuth };
        return {};
      }),
    } as unknown as AgorClient;
    // Rejects the way a malformed name would; the successful start is the
    // first test's business.
    const onPrepareOAuthStart = vi.fn<() => Promise<string | null>>().mockResolvedValue(null);

    const Harness = () => {
      const [form] = Form.useForm();
      const [formRevision, bumpFormRevision] = useFormRevision();
      useEffect(() => {
        // A URL is enough to pass the auth test, which is what reveals the
        // OAuth button — but not enough to write the row it binds to.
        form.setFieldsValue({ url: 'https://mcp.example/mcp', auth_type: 'oauth' });
        bumpFormRevision();
      }, [form, bumpFormRevision]);

      return (
        <Form form={form} onValuesChange={bumpFormRevision}>
          <MCPServerFormFields
            mode="create"
            transport="http"
            authType="oauth"
            form={form}
            client={client}
            authorityKey="user-a:admin:1"
            onPrepareOAuthStart={onPrepareOAuthStart}
            formRevision={formRevision}
          />
        </Form>
      );
    };

    render(<Harness />);

    fireEvent.click(buttonLabeled('Test Authentication'));
    await waitFor(() => expect(testOAuth).toHaveBeenCalledTimes(1));

    await screen.findByText('Start OAuth Flow');
    expect(oauthButton()).toBeDisabled();

    // A disabled button that explains nothing is what sent people looking for
    // a failure that never surfaced.
    fireEvent.mouseOver(oauthButton());
    expect(
      await screen.findByText(
        'Starting OAuth saves this server first — fill in Name (Internal ID).'
      )
    ).toBeInTheDocument();

    fireEvent.click(oauthButton());
    expect(onPrepareOAuthStart).not.toHaveBeenCalled();
    expect(startOAuth).not.toHaveBeenCalled();

    // Filling it in only clears the blank-field gate; the value rules still
    // get their say, and the save behind the button reports them.
    fireEvent.change(screen.getByLabelText('Name (Internal ID)'), {
      target: { value: 'example' },
    });
    await waitFor(() => expect(oauthButton()).toBeEnabled());

    fireEvent.click(oauthButton());
    await waitFor(() => expect(onPrepareOAuthStart).toHaveBeenCalledTimes(1));
    expect(startOAuth).not.toHaveBeenCalled();
  });

  it('shows a catalog-managed Marketplace policy read-only', async () => {
    const client = {
      io: { on: vi.fn(), off: vi.fn() },
      service: vi.fn().mockReturnValue({ create: vi.fn() }),
    } as unknown as AgorClient;

    const Harness = () => {
      const [form] = Form.useForm();
      useEffect(() => {
        form.setFieldsValue({
          name: 'catalog-server',
          url: 'https://mcp.example/mcp',
          auth_type: 'oauth',
          oauth_compatibility_mode: 'marketplace',
        });
      }, [form]);
      return (
        <Form form={form}>
          <MCPServerFormFields
            mode="edit"
            transport="http"
            authType="oauth"
            form={form}
            client={client}
            authorityKey="user-a:admin:1"
            serverId="saved-server"
            onPrepareOAuthStart={vi.fn().mockResolvedValue('saved-server')}
            managedOAuthCompatibilityMode="marketplace"
          />
        </Form>
      );
    };

    render(<Harness />);

    fireEvent.click(screen.getByText('Advanced — OAuth settings'));
    expect(await screen.findByText('Marketplace compatibility (catalog managed)')).toBeVisible();
    const compatibility = screen.getByLabelText('OAuth Compatibility');
    expect(compatibility).toBeDisabled();
    expect(
      screen.getByText(/current Marketplace catalog manages this server's interoperability/i)
    ).toBeVisible();
  });
});
