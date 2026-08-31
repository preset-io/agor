/**
 * PostgreSQL connection URLs may carry credentials in userinfo, query
 * parameters, or provider-specific extensions. Diagnostic surfaces therefore
 * redact the complete value rather than attempting an evolving denylist.
 */
export function redactPostgresqlUrlForDiagnostics(_url: string, sentinel = '<redacted>'): string {
  return sentinel;
}
