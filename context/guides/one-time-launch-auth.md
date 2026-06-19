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
  "instance_id": "my-instance"
}
```

If `service_credential` or `service_credential_env` is configured, the daemon also sends `Authorization: Bearer <credential>`.

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

## Security notes

- Put only an opaque, short-lived, one-time code in the browser URL.
- Do not put runtime bearer tokens or external provider tokens in URLs.
- The daemon-to-provider exchange should require HTTPS and an authenticated backchannel in production.
- Assertions should be audience-bound to the runtime, instance-bound when `instance_id` is configured, and expire quickly.
- Configure exactly one assertion verification method (`jwks_url`, `public_key`, or dev-only `dev_shared_secret`).
- Local users are mapped by stable external identity `(provider, issuer, subject)`. A matching email alone never merges identities.
