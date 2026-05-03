# Security Headers & CORS

How Agor's daemon handles Content-Security-Policy (CSP) and Cross-Origin
Resource Sharing (CORS), and how operators tune both from `~/.agor/config.yaml`.

> This document is scoped to **web-layer hardening** (CSP / CORS / response
> headers). For authentication, RBAC, and Unix isolation see
> [`apps/agor-docs/pages/guide/multiplayer-unix-isolation.mdx`](../../apps/agor-docs/pages/guide/multiplayer-unix-isolation.mdx)
> and [`context/guides/rbac-and-unix-isolation.md`](../guides/rbac-and-unix-isolation.md).

---

## Why configurable at all?

PR #1027 landed strict, hardcoded CSP + CORS. Two problems surfaced:

1. **Hardcoded defaults hid a bug for Sandpack artifacts.** CSP lacked
   `frame-src` and `worker-src`, so both fell back to `default-src 'self'` —
   which blocks the hosted CodeSandbox bundler iframes Agor uses for
   artifacts. Operators saw a silent render failure on a fresh deploy with
   no config knob to fix it.
2. **Custom integrations couldn't be added.** An operator with a custom
   analytics script, LLM proxy, embedded dashboard, or IDP had to fork and
   rebuild the daemon. That's a poor upgrade story.

The `security.*` config block solves both: the defaults now make every
bundled Agor feature work, and operators can append or replace per-directive
without leaving YAML.

---

## Config model

### CSP: two-tier (extras / override)

```yaml
security:
  csp:
    # (1) APPEND to built-in defaults — the 95% case.
    extras:
      script-src: ["https://plausible.io"]
      connect-src: ["https://api.anthropic.com"]
      frame-src: ["https://my-sandbox.example.com"]

    # (2) REPLACE a directive wholesale — escape hatch, rare.
    # Setting a directive here wipes both defaults AND extras for that key.
    override:
      img-src: ["'self'", "data:"]

    # (3) Reporting + debug toggles.
    report_uri: "/api/csp-report"   # daemon mounts a handler here
    report_only: false              # true = emit Content-Security-Policy-Report-Only
    disabled: false                 # dev/debug only, emits loud warning
```

**Why the split?** Every operator we've asked about CSP wanted "keep what
Agor ships, just let me add `https://plausible.io` to `script-src`." That's
append. Replacement is for operators with a fully bespoke policy. Offering
both avoids the common footgun where "I wanted to add X" ended up silently
dropping the defaults and breaking unrelated features.

**Empty override is meaningful.** `override: { "script-src": [] }` emits
`script-src` with no sources — i.e. blocks that directive entirely. This is
distinct from *omitting* the key, which means "use defaults+extras." If you
find yourself reaching for this, double-check it's really what you meant.

### CORS: mode-based

```yaml
security:
  cors:
    mode: list                              # list | wildcard | reflect | null-origin
    origins: ["https://agor.mydomain.com"]  # used when mode=list
    credentials: true                       # default true; forced false in wildcard/reflect
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"]
    allowed_headers: ["Authorization", "Content-Type", "X-MCP-Token"]
    max_age_seconds: 600
    allow_sandpack: true                    # include *.codesandbox.io (default true)
```

**Mode semantics:**

| Mode          | Behaviour                                                         | Credentials |
| ------------- | ----------------------------------------------------------------- | ----------- |
| `list`        | Only origins in `origins[]` + built-ins (localhost, Sandpack, Codespaces) | Allowed (default) |
| `wildcard`    | Accept any origin (returns `Access-Control-Allow-Origin: *`)      | Forced off  |
| `reflect`     | Echo the request's `Origin` header back                           | Forced off  |
| `null-origin` | Accept `Origin: null` (sandboxed iframes, `file://` docs) plus no-origin non-browser clients (curl, server-to-server) | Allowed     |

`credentials: true` + `mode: wildcard` (or `reflect`) is rejected at config
load with a clear error — the CORS spec explicitly forbids this combination
because it would allow credentialed requests from any origin.

---

## Built-in defaults

These are hardcoded into `resolveSecurity()` and make every bundled feature
work. Operators rarely need to override them:

```
default-src        'self'
script-src         'self'
style-src          'self' 'unsafe-inline'           # Ant Design injects inline styles
img-src            'self' data: blob: https://*.codesandbox.io
font-src           'self' data:
connect-src        'self' ws: wss: <daemon-url>
frame-src          'self' https://*.codesandbox.io  # Sandpack iframes
worker-src         'self' blob:                     # Sandpack workers
frame-ancestors    'none'
object-src         'none'
base-uri           'self'
```

The Sandpack origins (`https://*.codesandbox.io` + `blob:` for workers) are
the load-bearing piece — without them the hosted bundler iframe renders but
its workers fail to spawn and artifacts never mount. Setting
`security.cors.allow_sandpack: false` removes them from *both* the CSP and
the CORS allow-list (the two need to stay in sync or you get weird
half-broken states).

---

## Common recipes

### I want to allow an external analytics script

```yaml
security:
  csp:
    extras:
      script-src: ["https://plausible.io"]
      connect-src: ["https://plausible.io"]
```

### I want to embed an external iframe

```yaml
security:
  csp:
    extras:
      frame-src: ["https://my-embed.example.com"]
```

### I want to relax CORS for a specific origin

```yaml
security:
  cors:
    origins: ["https://dashboard.internal.example.com"]
```

Regex patterns are supported inside `/slashes/`:

```yaml
security:
  cors:
    origins:
      - "https://dashboard.example.com"
      - "/\\.internal\\.example\\.com$/"
```

### I want to watch what's being blocked before enforcing

```yaml
security:
  csp:
    report_only: true
    report_uri: "/api/csp-report"
```

The daemon mounts a rate-limited handler at `report_uri` that logs incoming
reports at `warn` level via pino. Watch your logs, tighten your `extras`,
flip `report_only: false` when the floor is quiet.

---

## Backwards compatibility

The legacy `daemon.cors_origins` and `daemon.cors_allow_sandpack` keys from
#1027 still work. When present they're merged into the resolved CORS config
with a deprecation warning at daemon startup. The `CORS_ORIGIN` environment
variable continues to win over all config sources for deployment
compatibility.

Migration path: move values to `security.cors.origins` +
`security.cors.allow_sandpack` on your next config touch — the deprecation
will be promoted to a hard error in a future release.

---

## Debugging a blocked resource

When Sandpack-like "silent render failure" strikes again:

1. Open DevTools → Network tab → click the failing resource.
2. In the response headers, find `Content-Security-Policy` (or
   `-Report-Only`). The daemon also surfaces this in Settings → About →
   Security Headers so you don't have to dig.
3. Find the directive that governs that resource type (`script-src` for
   JS, `frame-src` for iframes, `connect-src` for fetch/XHR, `worker-src`
   for web workers, etc.).
4. Add the required source to `security.csp.extras.<directive>` in
   `~/.agor/config.yaml`, restart the daemon.

If you can't afford a restart cycle, flip on `report_only: true` first, wait
for the next violation report in logs, then make the change — you'll know
exactly which origin + directive the browser wanted.

---

## Architecture

Resolution lives in `packages/core/src/config/security-resolver.ts`:

```
AgorConfig.security          →  resolveSecurity()  →  ResolvedSecurity
  + daemonUrl                                           { csp: ResolvedCsp,
  + legacyCorsOrigins                                     cors: ResolvedCors }
  + legacyAllowSandpack
  + CORS_ORIGIN env var
```

The resolver is pure — no file I/O, no side effects except warnings — and
is imported by:

- `apps/agor-daemon/src/setup/security-headers.ts` — consumes `ResolvedCsp`
- `apps/agor-daemon/src/setup/cors.ts` — consumes `ResolvedCors`
- `apps/agor-daemon/src/register-routes.ts` — surfaces it on `/health`
- `apps/agor-ui/src/components/SettingsModal/AboutTab.tsx` — renders it

Validation errors surface at daemon startup, not request-time. If your
`config.yaml` has an unknown CSP directive or a `credentials: true +
mode: wildcard` combination, the daemon refuses to boot with an actionable
error message.

---

## See also

- `apps/agor-daemon/src/setup/security-headers.ts` — CSP middleware
- `apps/agor-daemon/src/setup/cors.ts` — CORS policy builder
- `packages/core/src/config/security-resolver.ts` — config resolver
- [`apps/agor-docs/pages/guide/multiplayer-unix-isolation.mdx`](../../apps/agor-docs/pages/guide/multiplayer-unix-isolation.mdx) — daemon auth, RBAC, OS-level isolation tiers
- [`context/guides/rbac-and-unix-isolation.md`](../guides/rbac-and-unix-isolation.md) — implementation guide
