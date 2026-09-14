import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpAuthDiagnosticAccumulator } from './mcp-auth-diagnostic-accumulator.js';

afterEach(() => vi.restoreAllMocks());

describe('McpAuthDiagnosticAccumulator', () => {
  it('emits one bounded actionable summary without server or provider content', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const diagnostics = new McpAuthDiagnosticAccumulator();
    diagnostics.recordUnavailable();
    diagnostics.recordUnavailable();
    diagnostics.recordResolutionFailure();
    diagnostics.emitSummary('codex');

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      '[executor.mcp_auth] unavailable executor=codex servers=3 credential_unavailable=2 resolution_failed=1 outcome=integration_unavailable action=check_integration_credentials'
    );
    diagnostics.emitSummary('codex');
    expect(warn).toHaveBeenCalledOnce();
  });

  it('does not log when every requested integration is available', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    new McpAuthDiagnosticAccumulator().emitSummary('gemini');
    expect(warn).not.toHaveBeenCalled();
  });
});
