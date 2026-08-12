/**
 * Return a short remediation hint for a durable remote-clone failure.
 *
 * Git owns TLS verification (libcurl/OpenSSL, Secure Transport, or Schannel),
 * so the browser cannot repair a missing or private CA bundle. Keep this copy
 * actionable without suggesting the unsafe `http.sslVerify=false` workaround.
 */
export function cloneErrorHint(error?: { category?: string; message?: string }): string {
  if (!error) return '';

  if (error.category === 'git_unavailable') {
    return ' — Git is unavailable to the Agor executor. Install Git there, ensure it is executable on PATH, and retry';
  }

  if (error.category === 'auth_failed') {
    return ' — configure GITHUB_TOKEN in User Settings → Env Vars for private repos';
  }

  if (error.category === 'not_found') {
    return ' — verify the repository URL and default branch, and confirm the repository is accessible';
  }

  if (error.category === 'network') {
    const message = error.message?.toLowerCase() ?? '';
    if (/(certificate|ssl|tls|ca cert|cafile|capath|ca bundle|issuer)/.test(message)) {
      return (
        ' — Git could not verify the server certificate. Install/enable the operating system CA trust store ' +
        "or configure Git's approved CA bundle for your proxy; do not disable SSL verification"
      );
    }
    return ' — check DNS, firewall, proxy, and network access for the daemon/executor, then retry';
  }

  return '';
}
