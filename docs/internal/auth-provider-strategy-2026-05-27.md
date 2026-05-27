# Auth provider strategy for Google/GitHub login and future enterprise auth

**Date:** 2026-05-27
**Branch:** `auth-provider-login-options`
**Author:** Codex research pass
**Status:** Recommendation / implementation plan. No runtime migration in this branch.

## Executive recommendation

Adopt **Better Auth as Agor's embedded auth framework for OSS/self-hosted Agor**, behind an
Agor-owned auth boundary that keeps Agor's current `users`, Feathers permissions, service JWTs,
API keys, and first-run local login behavior intact during migration.

Use Better Auth for:

- Google and GitHub sign-in.
- Future passkeys/MFA and account-linking primitives.
- Future organization/enterprise features where they fit: org membership, OIDC/SAML SSO, SCIM.
- A clean fallback path to hosted enterprise auth in Agor Cloud.

Do **not** move the whole daemon to Better Auth sessions in the first PR. The right architecture is
a small **Agor Auth Bridge**:

1. Better Auth owns browser OAuth/OIDC callback mechanics and its own auth tables.
2. The bridge links each Better Auth identity to one canonical Agor `users.user_id`.
3. After a successful browser login, the bridge mints the same Agor access/refresh tokens the UI and
   CLI already understand.
4. Feathers `params.user`, branch RBAC, web terminals, executor service tokens, personal API keys,
   and MCP/session-token auth keep using Agor's current identity model.

This keeps OSS/local Agor simple: email/password and first-run admin continue to work without any
external identity provider. Google/GitHub are opt-in config. Enterprise auth becomes additive rather
than a reason to make local setup painful.

## Current Agor auth implementation

### Server/auth service

Current user auth is **Agor-owned Feathers auth**:

- `apps/agor-daemon/src/register-routes.ts` configures `@feathersjs/authentication` with
  strategies `api-key`, `jwt`, `local`, and optionally `session-token`.
- Local login uses Feathers `LocalStrategy` with `email` + `password`.
- Access tokens are Agor JWTs signed with `daemon.jwtSecret`, issuer `agor`, audience
  `https://agor.dev`, algorithm `HS256`, and a 15-minute TTL.
- `POST /authentication/refresh` accepts a separate 30-day refresh token and returns a fresh access
  token, refresh token, and full sanitized user DTO.
- `apps/agor-daemon/src/auth/service-jwt-strategy.ts` extends Feathers JWT auth for internal service
  JWTs (`sub: executor-service`, `type: service`).
- `apps/agor-daemon/src/auth/api-key-strategy.ts` authenticates personal API keys (`agor_sk_...`) via
  `Authorization: Bearer` or `X-API-Key`.
- `apps/agor-daemon/src/auth/session-token-strategy.ts` handles short-lived executor/session tokens.

### Users and database

- `packages/core/src/db/schema.sqlite.ts` and `schema.postgres.ts` define a canonical `users` table:
  `user_id`, `email`, bcrypt `password`, `name`, `emoji`, `role`, optional `unix_username`, onboarding
  and password-change flags, plus a JSON `data` blob.
- `apps/agor-daemon/src/services/users.ts` hashes passwords, returns password only for local auth
  lookup, and stores encrypted user-scoped agentic tool credentials/env vars.
- `packages/core/src/types/user.ts` is the canonical app user shape and role model.
- There is currently no provider-account/link table for Google/GitHub/OIDC identities.

### First-run and local/self-host assumptions

- `apps/agor-daemon/src/setup/first-run-admin.ts` bootstraps a local admin on an empty users table,
  using `AGOR_ADMIN_PASSWORD` or an auto-generated `~/.agor/admin-credentials` file.
- This flow should remain the OSS default. Operators must be able to start Agor with no external
  auth provider or hosted account.

### Client and CLI

- `apps/agor-ui/src/components/LoginPage/LoginPage.tsx` currently renders only email/password.
- `apps/agor-ui/src/hooks/useAuth.ts` calls `client.authenticate({ strategy: 'local', email,
  password })`, stores Agor access/refresh tokens in localStorage, refreshes before `exp`, and
  re-authenticates sockets after token refresh.
- `apps/agor-ui/src/hooks/useAgorClient.ts` authenticates Socket.IO with the Agor JWT and retries
  REST/socket calls after refresh.
- `apps/agor-cli/src/commands/auth/login.ts` is local email/password only and stores a CLI token in
  `~/.agor/cli-token`. It currently assumes a 7-day expiry in display text even though browser access
  tokens are 15 minutes; CLI token behavior should be reviewed separately.

### Why this matters

Agor auth is not just website login. It is tied to:

- Branch RBAC and user roles.
- Unix identity / `unix_username` for `strict` process isolation.
- Web terminals and service-token authorization.
- Personal agentic tool credentials and environment variables.
- Executor and MCP service authentication.
- CLI/API usage.

A wholesale auth-library replacement would be riskier than adding OAuth provider login. We need an
identity-provider layer that feeds Agor's existing app-user model, not a new app-user model that
silently bypasses Agor permissions.

## External research snapshot (2026-05-27)

### Better Auth

**Summary:** best fit for Agor's embedded OSS auth path.

- Official positioning: framework-agnostic TypeScript auth framework with email/password, social
  login, sessions, org/access control, 2FA, plugins, and enterprise-ish features.
  <https://better-auth.com/docs/introduction>
- Express support is official via `better-auth/node`'s `toNodeHandler`. The docs call out Express 5
  route syntax and the body-parser footgun: do not mount `express.json()` before the Better Auth
  handler. <https://better-auth.com/docs/integrations/express>
- Drizzle adapter exists for SQLite/Postgres/MySQL and supports table/field customization.
  <https://better-auth.com/docs/adapters/drizzle>
- Social providers are built in. <https://better-auth.com/docs/authentication/social-sign-on>
- SSO plugin supports OIDC, OAuth2, and SAML 2.0. <https://better-auth.com/docs/plugins/sso>
- SCIM plugin exists. <https://better-auth.com/docs/plugins/scim>
- Organization plugin exists. <https://www.better-auth.com/docs/plugins/organization>
- OIDC/OAuth provider plugins exist if Agor later wants to act as an IdP for internal tools.
  <https://www.better-auth.com/docs/plugins/oidc-provider>
- NPM snapshot gathered 2026-05-27:
  - `better-auth` v1.6.11, MIT, modified 2026-05-12, ~12.4M downloads last month.
  - `@better-auth/drizzle-adapter`, `@better-auth/sso`, and `@better-auth/scim` are version-aligned
    at v1.6.11.
  - Download API: <https://api.npmjs.org/downloads/point/last-month/better-auth>

**Pros for Agor:** TypeScript-first, framework agnostic, Express-compatible, Drizzle-compatible,
active, rapidly adopted, OSS-friendly, rich plugin roadmap that overlaps Google/GitHub now and
SAML/OIDC/SCIM/orgs later.

**Cons/risks:** young compared with Passport/Auth.js; 1.x APIs are still moving; Express integration
has ordering/path details; enterprise self-service dashboards appear to be part of hosted Better Auth
Infrastructure, so Agor Cloud should not assume all enterprise UX is free OSS out of the box.

### Auth.js / NextAuth

**Summary:** excellent provider ecosystem, but not the right default for an Express/Feathers daemon.

- Auth.js describes itself as free/open-source auth for the web and now shows an Express example.
  <https://authjs.dev/>
- `@auth/express` is the official Express integration, but official docs mark it experimental and
  warn the API will change. <https://express.authjs.dev/> (also mirrored in the package docs)
- Auth.js adapters are flexible but introduce their own user/account/session model.
  <https://authjs.dev/guides/creating-a-database-adapter>
- NPM snapshot gathered 2026-05-27:
  - `@auth/express` v0.12.2, ISC, modified 2026-04-14, ~63k downloads last month.
  - `next-auth` v4.24.14, ~17M downloads last month.

**Pros:** mature provider catalog; huge Next.js community; OAuth is well trodden.

**Cons for Agor:** strongest path is still Next.js-centric; Express integration is comparatively new
and experimental; not focused on org/SCIM/enterprise auth as first-class app concepts; custom
adapter/callback mental model is notoriously intricate for non-Next use. Good fallback if Better Auth
fails a proof-of-concept, but not the default.

### Lucia

**Summary:** do not choose for Agor as a library.

- The official Lucia repository says Lucia v3 was deprecated by March 2025 and Lucia is now a
  learning resource for implementing auth, not a maintained auth library.
  <https://github.com/lucia-auth/lucia>
- The maintainer's 2024 announcement explicitly said the `lucia` NPM package would be maintained only
  until March 2025 and adapters deprecated by end of 2024.
  <https://github.com/lucia-auth/lucia/discussions/1714>

**Fit:** useful for design inspiration; not a package dependency.

### Passport

**Summary:** stable middleware toolbox, not an auth platform.

- Passport is Node authentication middleware with 500+ strategies and is designed to be dropped into
  Express apps. <https://www.passportjs.org/>
- NPM snapshot gathered 2026-05-27:
  - `passport` v0.7.0, MIT, modified 2025-01-10, ~29M downloads last month.
  - `passport-google-oauth20` v2.0.0 last modified 2023-04-26.
  - `passport-github2` v0.1.12 last modified 2022-06-23.

**Pros:** battle-tested; minimal; easy to wire one OAuth callback at a time.

**Cons for Agor:** fragmented strategy ecosystem; no coherent typed data/session/org/SCIM story; we
would build account linking, sessions, security UX, enterprise self-service, and migrations ourselves.
Use only as a tactical fallback for one-off OAuth if Better Auth cannot fit Feathers, not as the
strategic foundation.

### Hosted/cloud auth providers

#### WorkOS

- WorkOS SSO docs say the SSO API acts as authentication middleware and intentionally does not handle
  the app's user database. <https://workos.com/docs/sso/index>
- WorkOS docs highlight hosted auth, SSO, Directory Sync/SCIM, RBAC, organizations, and Express SDK
  support. <https://workos.com/docs>
- NPM snapshot gathered 2026-05-27: `@workos-inc/node` v9.3.1, MIT, modified 2026-05-19, ~5.6M
  downloads last month.

**Fit:** very strong for Agor Cloud enterprise SSO/SCIM later, because it explicitly works with an
existing app-user database. Poor default for OSS because it requires a hosted vendor account and does
not solve local login.

#### Auth0 / Okta

- Auth0 Express quickstart uses `express-openid-connect`.
  <https://auth0.com/docs/quickstart/webapp/express/index>
- Auth0 Enterprise Connections support external/federated IdPs including OIDC and SAML.
  <https://auth0.com/docs/authenticate/enterprise-connections>
- Auth0 self-service SSO docs cover customer-delegated SSO setup and SCIM prerequisites.
  <https://auth0.com/docs/authenticate/enterprise-connections/self-service-SSO/manage-self-service-sso>
- NPM snapshot gathered 2026-05-27: `express-openid-connect` v3.0.0, MIT, modified 2026-05-15,
  ~602k downloads last month.

**Fit:** credible Agor Cloud enterprise provider; overkill/vendor-lock for OSS default; pricing and
plan gates matter for SAML/SCIM.

#### Clerk

- Clerk supports Enterprise SSO via SAML. <https://clerk.com/docs/authentication/enterprise-connections/overview>
- NPM snapshot gathered 2026-05-27: `@clerk/express` v2.1.21, MIT, modified 2026-05-26,
  ~971k downloads last month.

**Fit:** polished hosted developer experience and React UI components, but less suitable as OSS
self-host default because login/session UX is tightly coupled to Clerk-hosted infrastructure.

#### Supabase Auth

- Supabase Auth supports SAML SSO and multi-tenant SAML connections, but the docs note SSO accounts
  are not automatically linked to existing accounts and emails are not necessarily unique in SSO
  flows. <https://supabase.com/docs/guides/auth/enterprise-sso/auth-sso-saml>
- NPM snapshot gathered 2026-05-27: `@supabase/supabase-js` v2.106.2, MIT, modified 2026-05-26,
  ~79M downloads last month.

**Fit:** great if Agor were already a Supabase app. For Agor's existing SQLite/Postgres/Feathers
daemon and self-hosted deployment model, it is too much of a platform shift.

### Self-hosted IdPs / external identity servers

#### Keycloak

- Keycloak is a separate server that provides SSO for web apps and REST services, with customizable
  login/admin/account UIs and integration with LDAP/Active Directory. It supports OIDC and SAML IdPs.
  <https://www.keycloak.org/docs/latest/server_admin/index.html>
- Keycloak's homepage says it can authenticate with existing OpenID Connect or SAML 2.0 identity
  providers and configure identity brokering/user federation. <https://www.keycloak.org/>
- GitHub snapshot from search: `keycloak/keycloak` ~34k stars. <https://github.com/keycloak/keycloak>

**Fit:** excellent external IdP for enterprise self-hosters. Agor should support generic OIDC against
Keycloak; Agor should not embed Keycloak.

#### ZITADEL

- ZITADEL docs position it as identity infrastructure with OIDC/SAML/OAuth2, MFA/passkeys, B2B
  multi-tenancy, branding, audit trail, and self-hosted/cloud choices. <https://zitadel.com/docs>
- ZITADEL self-host config includes SCIM settings. <https://zitadel.com/docs/self-hosting/manage/configure/configure>

**Fit:** strong modern self-hosted/cloud external IdP. Same recommendation as Keycloak: support it
through generic OIDC/SAML, do not make it Agor's embedded auth stack.

#### Ory

- Ory Kratos is headless identity/user management with MFA, social login, OIDC and more; Ory's site
  notes enterprise-license self-hosted support for Kratos. <https://www.ory.com/kratos>
- Ory's open-source page lists Kratos, Hydra, Keto, Oathkeeper, and Polis for enterprise SSO/directory
  sync. <https://www.ory.com/open-source>
- The Kratos GitHub README says some enterprise features such as SCIM, SAML, organization login,
  CAPTCHAs and more are in the Ory Enterprise License layer.
  <https://github.com/ory/kratos>

**Fit:** powerful but operationally heavy. Good for organizations that want an identity platform, not
for Agor's embedded OSS login.

## Decision matrix

| Option | OSS/self-host default | Express/Feathers fit | Google/GitHub now | OIDC/SAML/SCIM later | Org/multi-tenant story | Operational burden | Recommendation |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Better Auth embedded | Strong | Good, ESM + Express handler | Strong | Good via plugins | Good via org plugin | Low/medium | **Default** |
| Auth.js / `@auth/express` | Medium | Experimental | Strong | Limited without custom work | Weak/DIY | Medium | Fallback only |
| Lucia | Not viable | N/A | DIY | DIY | DIY | High | Do not use |
| Passport | Medium | Good middleware | Medium/strong | Strategy-dependent | DIY | Medium/high | Tactical only |
| WorkOS | Poor for offline OSS | Good SDK | Hosted | Excellent | Strong | Low for cloud, vendor | Cloud enterprise add-on |
| Auth0/Okta | Poor for offline OSS | Good SDK/middleware | Hosted | Excellent | Strong | Low for cloud, vendor | Cloud enterprise add-on |
| Clerk | Poor for offline OSS | Good SDK | Hosted | SSO available | Strong | Low for cloud, vendor | Cloud-only alternative |
| Supabase Auth | Medium if adopting Supabase | Platform shift | Strong | SAML available | Medium | Medium/high | Not default |
| Keycloak | Good as external IdP | OIDC client needed | Via broker | Strong | Strong | High | Support via generic OIDC |
| ZITADEL | Good as external IdP | OIDC client needed | Via broker | Strong | Strong | Medium/high | Support via generic OIDC |
| Ory | Good for identity-platform teams | API integration | Strong | Enterprise layer for some | Strong | High | External IdP option |

## Proposed Agor architecture

### Principle: canonical Agor users remain canonical

Agor should distinguish:

1. **Identity provider account**: Google/GitHub/OIDC/SAML subject, issuer, email, profile claims.
2. **Agor user**: `users.user_id`, role, `unix_username`, encrypted agentic credentials, RBAC.
3. **Agor session credentials**: Feathers/JWT access+refresh tokens, personal API keys, executor
   service tokens.

Provider accounts should link to Agor users, not replace them.

### Auth Bridge shape

Add a daemon-side auth bridge module, conceptually:

```ts
interface AuthBridge {
  getLoginOptions(): Promise<LoginOptions>;
  exchangeBrowserAuthForAgorTokens(request: Request): Promise<AgorTokenResponse>;
  findOrCreateAgorUser(identity: ExternalIdentity): Promise<User>;
  linkIdentity(userId: UserID, identity: ExternalIdentity): Promise<void>;
}
```

Better Auth's handler is mounted under a namespaced path such as `/auth/*` or `/api/auth/*`, but the
UI continues to rely on Agor's own token response until the rest of the app is ready for cookie-based
sessions.

### Suggested tables

There are two viable table strategies. Prefer **separate Better Auth tables plus an explicit bridge**
for the first migration.

#### Preferred: namespaced Better Auth tables

Let Better Auth own generated tables with names such as:

- `auth_user`
- `auth_account`
- `auth_session`
- `auth_verification`
- plugin tables as needed (`auth_organization`, `auth_member`, `auth_sso_provider`, etc.)

Store the Agor link explicitly, e.g. either:

- an `agor_user_id` additional field on Better Auth's user model, or
- an Agor-owned `auth_identity_links` table:

```sql
provider_kind        -- google | github | oidc | saml | workos | auth0 | etc.
provider_id          -- e.g. google, github, okta-acme
issuer               -- URL for OIDC/SAML where applicable
subject              -- stable IdP subject
email                -- latest observed email
email_verified       -- latest observed verification state
agor_user_id         -- FK users.user_id
created_at
updated_at
last_login_at
profile_json         -- claims/avatar/debug aid, never trusted for authz
unique(provider_id, issuer, subject)
```

Why separate tables first:

- Avoids contorting Better Auth around Agor's existing `users` schema (`user_id`, required bcrypt
  `password`, JSON `data`, role/unix fields).
- Lets Better Auth migrations remain predictable.
- Keeps rollback easy: disable external providers and retain local password login.

#### Later: tighter mapping if useful

After the OAuth bridge is proven, evaluate whether Better Auth should map directly to `users`. Do not
start there; it couples every Better Auth schema/plugin change to Agor's core user table.

### Token/session plan

#### Phase 1: bridge to existing Agor JWTs

Keep the UI and CLI token model unchanged:

1. User clicks Google/GitHub.
2. Browser completes Better Auth OAuth flow.
3. UI calls `POST /authentication/external/exchange` (or callback redirects to a small frontend route
   that calls it).
4. Daemon validates the Better Auth session/cookie server-side.
5. Bridge finds/creates/links the Agor user.
6. Daemon returns the same `accessToken`, `refreshToken`, and `user` shape as local
   `/authentication`.

This avoids touching every Feathers REST/socket path at once.

#### Phase 2: cookie hardening

Move browser auth from localStorage bearer tokens to `httpOnly`, `SameSite=Lax/Strict` cookies once
OAuth works and CORS/CLI/socket behavior is designed. This should be a separate security migration.
The existing `docs/jwt-expiry-investigation.md` already notes cookie auth has broader blast radius:
daemon middleware, CORS, CSRF, multi-origin dev, and CLI auth.

#### CLI/API

Do not force OAuth into CLI in the first iteration. Keep:

- `agor login` email/password for local users.
- Personal API keys for scripts/CI.

Later add device-code/browser login for CLI if users ask for Google/GitHub-only accounts.

### Config shape

Recommended eventual `~/.agor/config.yaml` shape:

```yaml
auth:
  # default: embedded. Future: external-oidc for deployments that want every login
  # delegated to Keycloak/ZITADEL/Auth0/etc.
  mode: embedded

  local:
    # default true for OSS/self-hosted. Cloud can disable after bootstrap if desired.
    enabled: true
    allow_password_login: true

  providers:
    google:
      enabled: true
      client_id_env: GOOGLE_CLIENT_ID
      client_secret_env: GOOGLE_CLIENT_SECRET
      # Empty = any verified Google account. Use hosted_domains for self-host teams.
      allowed_domains: []
      allow_signup: true
      default_role: member

    github:
      enabled: true
      client_id_env: GITHUB_CLIENT_ID
      client_secret_env: GITHUB_CLIENT_SECRET
      allowed_orgs: []
      allow_signup: true
      default_role: member

    oidc:
      # Generic self-host enterprise path, e.g. Keycloak/ZITADEL/Okta/Auth0.
      enabled: false
      providers:
        acme:
          issuer: https://sso.acme.example/realms/agor
          client_id_env: ACME_OIDC_CLIENT_ID
          client_secret_env: ACME_OIDC_CLIENT_SECRET
          allowed_domains: [acme.example]
          allow_signup: true
          default_role: member

  signup:
    # Safer OSS default once social login exists. First-run admin can invite/create users.
    mode: existing_or_invited # existing_or_invited | domain_allowlist | open
    email_domain_allowlist: []

  account_linking:
    # Do not silently link by unverified email. Prefer explicit logged-in linking or
    # verified-email + single existing candidate + operator-configured trust.
    allow_verified_email_match: false

  cloud:
    # Future Agor Cloud, not used by OSS default.
    enterprise_broker: none # none | workos | auth0 | clerk | better-auth-infrastructure
```

Do not add this config to runtime until implementation starts; premature config keys become API
commitments.

### Login UI

Add a daemon endpoint that returns resolved public auth options, e.g.:

```json
{
  "local": { "enabled": true },
  "providers": [
    { "id": "google", "label": "Google", "type": "oauth" },
    { "id": "github", "label": "GitHub", "type": "oauth" }
  ]
}
```

The login page should render provider buttons above or below the password form. If no providers are
configured, the current page remains essentially unchanged.

### Sign-up and account-linking policy

Default policy should be conservative:

- **Local/password remains enabled by default** for OSS.
- **No open social sign-up by default** unless the operator opts in or configures an allowlist.
- **Never auto-link on unverified email.**
- For verified email, only auto-link if:
  - exactly one existing Agor user has that email,
  - the operator enabled verified-email linking for that provider, and
  - the provider is known to return verified email claims.
- Otherwise require an already-authenticated user to link their provider from settings, or require an
  admin invite/pre-created user.
- Preserve `must_change_password` semantics for password users; social-only users may have an empty
  unusable password hash or a random hash, but must not be able to use local login unless they set a
  password through an explicit flow.

### Roles, orgs, and Unix usernames

- Initial Google/GitHub-created users should default to `member` unless `auth.signup.default_role` or
  invite data says otherwise.
- `unix_username` should not be guessed from email without sanitization/collision handling. In
  `strict` mode, a social-created user without `unix_username` must receive the same clear error as a
  local user without one.
- Future Cloud orgs should not be conflated with branch RBAC. A Cloud org/workspace is a tenant; a
  branch owner/permission is an authorization object inside a tenant.
- Better Auth's organization plugin can help model Cloud workspaces later, but Agor should introduce
  a first-class `organizations/workspaces` domain only when Cloud actually needs tenancy.

## Recommended implementation sequence

### Phase 0 — proof of concept branch (1-2 days)

Goal: verify Better Auth can mount inside the current Express 5 + Feathers daemon without disrupting
Feathers routes.

- Add Better Auth and Drizzle adapter dependencies.
- Mount Better Auth under a namespaced auth path before JSON body parsing if necessary.
- Use separate test-only SQLite tables.
- Configure GitHub or Google in a local dev config.
- Prove callback success and server-side session read.
- Do not expose this to users yet.

Exit criteria: no Feathers auth regressions; tests prove `/authentication` and protected Feathers
services still behave exactly as before.

### Phase 1 — data model and bridge

- Add `auth_identity_links` (or Better Auth `agor_user_id` extra field) with migrations for SQLite and
  Postgres.
- Add `auth.providers` config types and resolver only when runtime reads them.
- Add `GET /authentication/options` for UI.
- Add `POST /authentication/external/exchange` that validates Better Auth session and mints Agor
  tokens.
- Add provisioning/linking rules:
  - existing verified email match only if configured,
  - admin-created/invited users can link,
  - optional domain/org allowlists.
- Unit tests for account-linking edge cases.

### Phase 2 — Google/GitHub UI

- Add provider buttons to `LoginPage`.
- Redirect/popup flow to Better Auth provider endpoint.
- On return, exchange for Agor tokens, then reuse existing `useAuth` state.
- Preserve local login form and first-run admin help text.
- Add docs page under `apps/agor-docs/pages/guide/` once implementation is user-visible.

### Phase 3 — admin/operator ergonomics

- Show configured login methods in Settings/About or admin settings.
- Add CLI config examples:
  - local-only (default)
  - Google
  - GitHub
  - generic OIDC (Keycloak/ZITADEL)
- Add health diagnostics for missing client ID/secret env vars.

### Phase 4 — enterprise/cloud

- For Agor Cloud, evaluate **WorkOS first** as the enterprise broker because it is explicitly designed
  to sit in front of an existing user database and provides SSO/Directory Sync/SCIM without forcing a
  full app auth rewrite.
- Keep Better Auth embedded for Cloud consumer/basic teams if it remains healthy.
- Add generic OIDC for self-hosted enterprise users running Keycloak/ZITADEL/Auth0/Okta.
- Add SAML/SCIM only when there is a concrete customer/operator path. Prefer brokered SAML/SCIM
  (WorkOS/Auth0/Better Auth Infrastructure) over hand-rolling SAML support in Agor.

## Why no code migration in this branch?

The path is clear, but the safe first implementation is not just "add OAuth buttons." It touches:

- schema/migrations,
- account linking and signup policy,
- token/session boundaries,
- Feathers + Socket.IO auth,
- operator config,
- security docs,
- future CLI behavior.

A half-migration would risk creating users that bypass role/Unix/RBAC assumptions. This branch should
therefore land the strategy and then implement Phase 0/1 in focused follow-up PRs.

## Open questions for Max

1. Should social login be allowed to create users by default in self-hosted Agor, or should it require
   pre-created/invited users unless `auth.signup.mode` is relaxed?
2. For Agor Cloud, is the likely enterprise buyer asking for SSO/SCIM soon enough that WorkOS/Auth0
   should be integrated in parallel with Better Auth, or should Better Auth ship Google/GitHub first?
3. Should browser auth eventually move to httpOnly cookies, accepting a separate CORS/CSRF/socket
   migration, or should Agor keep bearer tokens for simplicity?
4. Do we want CLI browser/device-code login for social-only users, or are personal API keys enough?

## Bottom line

Pick **Better Auth as the embedded OSS auth framework**, but put it behind an **Agor Auth Bridge** so
Agor keeps its canonical users, RBAC, service tokens, and local-first posture. Treat **WorkOS/Auth0**
as Cloud enterprise brokers, and **Keycloak/ZITADEL/Ory** as external IdPs that Agor reaches through
generic OIDC/SAML configuration rather than embedding or replacing local auth.
