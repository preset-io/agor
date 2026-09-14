/** Bounded, content-free MCP auth diagnostics shared by SDK adapters. */
export class McpAuthDiagnosticAccumulator {
  private unavailable = 0;
  private resolutionFailed = 0;

  recordUnavailable(): void {
    this.unavailable++;
  }

  recordResolutionFailure(): void {
    this.resolutionFailed++;
  }

  emitSummary(executor: 'claude' | 'codex' | 'gemini'): void {
    const total = this.unavailable + this.resolutionFailed;
    if (total === 0) return;
    const unavailable = this.unavailable;
    const resolutionFailed = this.resolutionFailed;
    this.unavailable = 0;
    this.resolutionFailed = 0;
    console.warn(
      `[executor.mcp_auth] unavailable executor=${executor} servers=${total} ` +
        `credential_unavailable=${unavailable} resolution_failed=${resolutionFailed} ` +
        `outcome=integration_unavailable action=check_integration_credentials`
    );
  }
}
