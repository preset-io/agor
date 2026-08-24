import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpAuthDiagnostics } from './mcp-auth-diagnostics';

afterEach(() => vi.restoreAllMocks());

describe('McpAuthDiagnostics', () => {
  it('emits one bounded actionable summary without server or provider content', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const diagnostics = new McpAuthDiagnostics();
    diagnostics.recordUnavailable();
    diagnostics.recordUnavailable();
    diagnostics.recordResolutionFailure();
    diagnostics.flush('codex');

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      '[executor.mcp_auth] unavailable executor=codex servers=3 credential_unavailable=2 resolution_failed=1 outcome=integration_omitted action=check_integration_credentials'
    );
  });

  it('does not log when every requested integration is available', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    new McpAuthDiagnostics().flush('gemini');
    expect(warn).not.toHaveBeenCalled();
  });
});
