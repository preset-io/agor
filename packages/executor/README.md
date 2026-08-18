# @agor/executor

Process-isolated runtime for agent SDKs, terminals, and bounded daemon work.

The daemon launches the executor directly in trusted `simple` mode, through the
fail-closed local bubblewrap filesystem policy in `sandbox` mode, or via an
explicit external command template in `delegated` mode. The executor does not
create host accounts, manage POSIX groups, or provide sudo impersonation.

It communicates with the daemon using JSON-RPC and service-scoped tokens. It
does not receive database credentials; provider credentials are routed through
the appropriate daemon/external execution boundary.

## Development

```bash
pnpm dev
pnpm test
```

Message and payload types in `packages/executor/src/` are authoritative. See
[`context/guides/rbac-and-unix-isolation.md`](../../context/guides/rbac-and-unix-isolation.md)
and
[`apps/agor-docs/content/guide/containerized-execution.mdx`](../../apps/agor-docs/content/guide/containerized-execution.mdx).
