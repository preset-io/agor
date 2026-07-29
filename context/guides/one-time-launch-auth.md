# One-time launch-code authentication

Agor can accept a generic external launch handoff when another trusted app has already authenticated the user. The browser carries only an opaque, short-lived `launch_code`; the daemon exchanges that code over a server-to-server backchannel, verifies the returned assertion, maps a local user, and issues the same runtime access and refresh tokens used by normal login.

## Flow

1. The external launch provider opens the runtime UI with `/ui/?launch_code=<opaque-code>`.
2. The UI calls `POST /auth/launch` once with `{ "launchCode": "..." }`.
3. The daemon posts the code to the configured exchange endpoint with its runtime audience, instance ID, and optional service credential.
4. The exchange endpoint returns a signed assertion for the authenticated subject.
5. The daemon verifies issuer, audience, expiration, subject, and the configured instance ID; then it maps or creates a local user by `(provider, issuer, subject)`.
6. The daemon returns normal runtime auth tokens. The UI stores those tokens and removes `launch_code` from the URL with `replaceState`.

If the launch code is missing, expired, already used, invalid, or the daemon
cannot complete a non-transient exchange, the UI shows a clear failure message.
When `external_launch.login_redirect_url` is configured, the unauthenticated
screen makes that URL the primary action so users can return to the external
workspace and open a fresh launch link. The UI appends a `return_to` query
parameter containing the current Agor path, so launch providers can preserve
deep links such as `/ui/s/<session>/` when issuing a fresh launch code. If the
field is omitted, the normal local username/password login screen remains
unchanged.

## Configuration

```yaml
external_launch:
  enabled: true
  exchange_url: https://launch.example.com/runtime/exchange
  issuer: https://launch.example.com
  audience: agor-runtime:my-instance
  instance_id: my-instance

  # Production: configure exactly one assertion verification method.
  # JWKS assertions must include a kid that matches a signing key.
  jwks_url: https://launch.example.com/.well-known/jwks.json
  # public_key: |-
  #   -----BEGIN PUBLIC KEY-----
  #   ...
  #   -----END PUBLIC KEY-----

  # Optional daemon-to-provider bearer credential. Prefer env vars for secrets.
  service_credential_env: AGOR_EXTERNAL_LAUNCH_SERVICE_TOKEN

  # Optional: allow role claims above member. Defaults to false.
  allow_admin_roles: false

  # Optional: where unauthenticated users should return when a launch code is
  # missing, expired, already used, invalid, or otherwise cannot be exchanged.
  # Must be http:// or https://.
  login_redirect_url: https://workspace.example.com/open

  # Optional host-bound launch (multi-host single daemon). When enabled the
  # daemon forwards the normalized inbound browser Host to the exchange endpoint
  # as an opaque `request_host`, so the issuer can bind a code to the exact route
  # the browser entered and reject a code minted for host A presented on host B.
  forward_request_host: false
  # Header the daemon reads the browser Host from. The trusted proxy / edge in
  # front of the daemon owns host normalization and MUST overwrite this header.
  # Default: host. Only set to x-forwarded-host when a trusted edge sets it.
  trusted_host_header: host
  # Query parameter appended to login_redirect_url carrying the current host as
  # an opaque return context for direct-host entry. Default: return_host.
  return_host_param: return_host
```

For local development only, a symmetric assertion secret can be used:

```yaml
external_launch:
  enabled: true
  exchange_url: http://localhost:4000/exchange
  issuer: http://localhost:4000
  audience: agor-runtime:dev
  dev_shared_secret_env: AGOR_EXTERNAL_LAUNCH_SHARED_SECRET
```

The following environment variables can override common fields:

- `AGOR_EXTERNAL_LAUNCH_ENABLED`
- `AGOR_EXTERNAL_LAUNCH_EXCHANGE_URL`
- `AGOR_EXTERNAL_LAUNCH_ISSUER`
- `AGOR_EXTERNAL_LAUNCH_AUDIENCE`
- `AGOR_EXTERNAL_LAUNCH_INSTANCE_ID`
- `AGOR_EXTERNAL_LAUNCH_SERVICE_TOKEN`
- `AGOR_EXTERNAL_LAUNCH_SHARED_SECRET`

## Exchange contract

The daemon sends a JSON `POST` to `exchange_url`:

```json
{
  "launch_code": "opaque-one-time-code",
  "audience": "agor-runtime:my-instance",
  "instance_id": "my-instance",
  "request_host": "primary.workspace.example.com"
}
```

`request_host` is present only when `forward_request_host` is enabled. It is the
normalized inbound browser Host read from the configured `trusted_host_header`
(default `Host`) of the daemon's own request — never from a client-supplied body
field or an arbitrary forwarded header. The daemon treats it as opaque; the
issuer maps it to the intended route and rejects a code presented on the wrong
host. Ambiguous host values (multiple, array or comma-joined) fail closed before
any code leaves the daemon. `audience` and `instance_id` are compatibility
echoes; a correct issuer derives authority from its own records and the
authenticated exchange credential, not from these caller-supplied fields. The
request shape the daemon emits is pinned by a daemon-side contract tripwire
fixture `apps/agor-daemon/src/auth/__fixtures__/launch-exchange-request.json`: it
catches an accidental daemon-side change in review, but it does not and cannot
mechanically prevent the issuer from drifting. The issuer's canonical exchange
schema remains the source of truth and must be kept in sync out of band.

If `service_credential` or `service_credential_env` is configured, the daemon also sends `Authorization: Bearer <credential>`. This static bearer is a
server-to-server exchange credential: it is read only from config/env (in
production, from a mounted Kubernetes Secret), is never included in the public
`/health` launch settings, and is never returned to the browser or written to
logs, errors or telemetry.

The exchange endpoint should consume the launch code exactly once and return:

```json
{
  "assertion": "<signed JWT>"
}
```

Required assertion claims:

- `iss`: expected issuer
- `sub`: stable subject at that issuer
- `aud`: expected runtime audience
- `exp`: short expiration time

Optional claims:

- `email`, `name`, `avatar` or `picture`
- `role`: `viewer` or `member` by default; `admin`/`superadmin` only when `allow_admin_roles` is explicitly enabled, and `superadmin` is still capped unless runtime superadmin support is enabled
- `provider`: stable provider label used in local identity mapping
- `jti` or `nonce`: accepted for audit/correlation; one-time replay prevention remains the exchange endpoint's responsibility

Required when `external_launch.instance_id` is configured:

- `instance_id` or `runtime_instance_id`: must match configured `instance_id`

## Direct-host entry

Clicking a launch link is not required. A browser can navigate straight to a
workspace host:

- If a valid runtime session already exists for that host, the app opens
  immediately with no new code or exchange. Runtime sessions live in
  origin-scoped `localStorage`, never a `Domain`-wide cookie, so a session
  established on `primary` is not automatically sent to `secondary`.
- If there is no host-local session, the unauthenticated screen sends the
  browser to the configured `login_redirect_url` (the issuer's launch-init
  endpoint) with two query params: `return_to` (the current **relative** Agor
  route, so deep links survive) and the configured `return_host_param` carrying
  the exact current host. The issuer allow-lists that host against its own
  routing records, mints a fresh code and redirects back to that exact host,
  which then runs the normal exchange. Agor only ever sends the browser to the
  operator-configured launch-init URL, so it introduces no open redirect; the
  issuer owns return-host validation.

## Fail-closed verification

Production verification is asymmetric and fails closed:

- The `none` algorithm is always rejected.
- When verifying with `jwks_url` or `public_key`, the algorithm allow-list
  defaults to `RS256` (override with `algorithms`), preventing algorithm
  confusion (e.g. a public key coerced into an HS256 secret). The dev
  `dev_shared_secret` path stays HS256-only.
- JWKS assertions must carry a `kid` that matches a signing key. A key that
  omits `use`/`alg` metadata is accepted; when either is present it must be
  consistent (`use: sig`, and `alg` matching the token header). Only conflicting
  metadata is rejected — the code intentionally treats those fields as optional.
- A missing/invalid issuer, audience, `exp`, `sub`, or (when
  `multi_tenancy.mode: required_from_auth`) the configured tenant claim, creates
  **no session**. Tenant scope applied to the runtime DB/RLS always equals the
  signed tenant claim.

## Compatibility and upgrade notes

- **Non-RS256 asymmetric signing must be declared before upgrading.** Asymmetric
  verification (`jwks_url` / `public_key`) now defaults to an `RS256`-only
  allow-list and refuses HS\* algorithms outright. A deployment that signs
  assertions with a different asymmetric algorithm (e.g. `RS384`, `ES256`,
  `PS256`) and previously relied on library defaults must set `algorithms`
  explicitly to the intended asymmetric algorithm **before** upgrading, or its
  assertions will stop verifying.
- **`login_redirect_url` deployments begin receiving a return-host query
  parameter.** When `login_redirect_url` is enabled, direct-host entry appends
  the configured `return_host_param` (default `return_host`) to that URL. This is
  not inert for existing deployments: the issuer's launch-init endpoint will
  start receiving this query parameter and must tolerate and/or consume it
  (allow-listing the host against its own routing records). If the issuer should
  not receive it, leave `login_redirect_url` unset.

## Security notes

- Put only an opaque, short-lived, one-time code in the browser URL.
- Do not put runtime bearer tokens or external provider tokens in URLs.
- The daemon-to-provider exchange should require HTTPS and an authenticated backchannel in production.
- Assertions should be audience-bound to the runtime, instance-bound when `instance_id` is configured, and expire quickly.
- Configure exactly one assertion verification method (`jwks_url`, `public_key`, or dev-only `dev_shared_secret`).
- Local users are mapped by stable external identity `(provider, issuer, subject)`. A matching email alone never merges identities.
- Launch codes, returned assertions, the exchange bearer credential, cookies and
  database URLs are redacted from daemon errors, logs and telemetry
  (`apps/agor-daemon/src/auth/launch-redaction.ts`). Exchange failures log only a
  coarse, secret-safe reason.

## Production-only operational validation

The following cannot be exercised by unit tests and must be confirmed against a
real deployment with a real issuer:

- Public JWKS resolves to stable RS256 JSON from the signer (not an HTML
  fallthrough) and the runtime verifies against it.
- A code minted for host A and presented on host B is rejected end-to-end
  (`request_host` binding), and a wrong/revoked/wrong-scope exchange credential
  fails.
- Two hosts sharing one daemon each establish sessions scoped to their own
  `tenant_id`, and cross-tenant reads/writes fail under RLS.
- No launch code, assertion, bearer credential, cookie or DB URL appears in
  daemon/proxy logs, audit or analytics for the test window.
