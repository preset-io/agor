/** Bounded, content-free MCP auth diagnostics shared by SDK adapters. */
export class McpAuthDiagnostics {
  private unavailable = 0;
  private resolutionFailed = 0;

  recordUnavailable(): void {
    this.unavailable++;
  }

  recordResolutionFailure(): void {
    this.resolutionFailed++;
  }

  flush(executor: 'claude' | 'codex' | 'gemini'): void {
    const total = this.unavailable + this.resolutionFailed;
    if (total === 0) return;
    console.warn(
      `[executor.mcp_auth] unavailable executor=${executor} servers=${total} ` +
        `credential_unavailable=${this.unavailable} resolution_failed=${this.resolutionFailed} ` +
        `outcome=integration_omitted action=check_integration_credentials`
    );
  }
}
