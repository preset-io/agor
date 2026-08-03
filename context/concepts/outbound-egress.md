# Daemon outbound egress security contract

`packages/core/src/network/safe-fetch.ts` is the application owner for daemon-originated
HTTP used by MCP discovery/transports, MCP OAuth discovery/token/refresh/DCR, and managed
environment webhooks and health probes. New daemon HTTP sinks in those families must use
`safeFetch`; direct `fetch()` is not an equivalent control.

## Application guarantees

- Public egress accepts HTTP(S) on ports 80/443, rejects URL credentials, and denies every
  resolved IPv4/IPv6 loopback, private, link-local, multicast, reserved/documentation,
  benchmarking, CGNAT, and metadata destination. Every A/AAAA answer must pass.
- DNS resolution is pinned into the socket connection, closing the validation/connect
  rebinding window while preserving the original hostname for HTTP Host and TLS SNI.
- Redirect hops are resolved and validated again. Authorization/cookie headers are never
  forwarded cross-origin, and cross-origin redirects carrying a request body are refused.
- Requests have a 10-second default deadline, three-hop redirect ceiling, and 2 MiB response
  ceiling. Callers may only lower or explicitly tune these bounded limits for their protocol.
- Health probes use the separate `health` policy because branch-local services are an
  intentional feature. It permits loopback/private addresses but still categorically denies
  link-local/metadata, multicast, reserved, and control-plane-like special-use destinations;
  health redirects are disabled at the sink.

These controls are system/global infrastructure. Tenant identity still scopes the MCP server,
OAuth grant, branch, and initiating operation before an outbound call. Destination validation
does not authorize a cross-tenant resource or credential.

## Required deployment defense

Application validation is defense in depth, not the cloud boundary. Production daemon and
executor workloads **must** have default-deny L3/L4 egress which independently blocks:

- instance/task metadata and link-local networks (IPv4 and IPv6);
- Kubernetes/hosting control planes and node-management ranges;
- RFC1918/ULA tenant networks, databases, caches, and other workload namespaces;
- all destinations except explicitly approved public integration endpoints and required DNS.

DNS should use a controlled resolver and the network policy must apply after DNS resolution.
Operators must verify denials from the deployed workload (not only from CI) and record the
allowed destination/port inventory before launch. An allowlist exception for a private MCP or
webhook belongs in deployment policy and must be admin-owned, tenant-scoped where applicable,
time-bounded, and audited; do not weaken `safeFetch` for member-supplied URLs.

## Review checklist

When adding outbound HTTP, identify the resource owner/tenant, use the narrowest address policy,
bound time and response size, decide redirect and credential behavior, and add DNS-rebinding,
redirect, IPv4/IPv6 special-use, metadata, and cross-tenant/capability-negative coverage
proportional to the changed boundary.
