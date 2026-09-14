# Managed environment variables and secrets: security audit

**Audit date:** 2026-08-26  
**Reviewed base:** `84ee55c8a1674c7d6b037f50894ac0b74ae04c5b` (`origin/main` at audit start)  
**Fix branch:** `audit-env-var-security` (the PR head is the authoritative fixed revision)  
**Primary scope:** managed user environment variables, session selections, their executor consumers, and adjacent credential stores that share the same encryption/redaction/runtime boundaries  
**Classification:** internal security design and verification record

No production database, tenant export, credential, or host secret was read for this review. Tests use generated IDs and labelled canaries and never print a canary value.

## Executive result

The stored-value API boundary already redacted user env values from REST, Socket.IO, MCP, UI, and analytics, and PostgreSQL put the owning rows behind forced tenant RLS. However, the audit established several independent runtime disclosure paths that bypassed those sound DTO controls:

1. fixed local executors, templated launchers, and Git child processes could inherit the daemon's ambient environment;
2. a collaborator-authorized managed-environment action resolved the branch creator's global secrets rather than the authenticated actor's;
3. a foreign session's name-only selections could select the prompter's same-named session secret;
4. managed Git received a generic user secret bag and combined authenticated transport with mutable repository configuration; and
5. the compatibility helper that temporarily mutates `process.env` serialized per user rather than per process, allowing two users' values to overlap.

Those defects are fixed at shared spawn, Git, resolver, lifecycle, and locking boundaries. The change also makes encryption fail closed when the deployment key is absent, normalizes malformed-ciphertext errors, validates every selection and gateway env map, removes an accidental gateway double envelope, makes corrupt gateway secrets unusable, silences selection-name realtime events, and makes env mutation plus stale-selection cleanup atomic with optimistic concurrency protection.

One major cryptographic design gap remains deliberately unresolved: generic env vars, agentic-tool credentials, gateway credentials, MCP server credentials, and app variables use the historical authenticated AES-GCM envelope with random salt/IV but no version, purpose domain, or row/tenant/user/name AAD. Agor already has a stronger versioned and bound envelope for PostgreSQL OAuth grants and pending flows. Changing generic writers to that format without a keyring, migration, and mixed-version reader plan would make older HA replicas and rollback binaries unable to read new values. That is a bounded product/rollout decision, not a safe one-PR substitution.

## Sources and reconstruction method

The contract below was reconstructed from code first, then checked against:

- product guides: `security.mdx`, `sessions.mdx`, `multiplayer-social.mdx`, `multiplayer-unix-isolation.mdx`, artifact/widget/gateway/MCP guides;
- design notes: `context/explorations/env-var-access.md`, `session-sharing.md`, executor isolation and multitenancy guidance;
- UI: Profile Env Vars, Session Env Vars, gateway configuration, artifact trust, and secure widget submission;
- SQLite and PostgreSQL schemas/repositories, Feathers hooks/routes/services, realtime publisher, tenant portability, executor protocol, and Git package;
- regression and integration tests, including non-owner, admin, provider-less, RLS, and replica cases;
- security KB `agor-cloud-team/security/audits/2026-08`:
  - `product-security-decisions.md`, KB version 8 (`01a0368a-96a2-77d8-80d7-d53dbfe6ec5f`), especially PD-07, PD-17, PD-28, PD-29, PD-31, PD-33, and PD-35;
  - `launch-action-register-and-phase-2-readiness.md`, version 1 (`01a0368a-2d35-73c2-88b8-67891003656b`), especially INT-H12 and INT-P08;
- relevant history:
  - `b560e9b5` per-user encrypted API keys;
  - `a609bea0` per-user env infrastructure;
  - `1bf7a0ef` daemon-env filtering for sessions;
  - `8dab3fc1` gateway env configuration;
  - `9fb9478f` session scope selections;
  - `af9f8a3b` per-tool credential homes;
  - `2287de38`, `2763b79d`, and `e57798a4` tenant-aware/default-deny realtime hardening;
  - `0a077e6c` removal of Unix impersonation.

Where code, old exploration text, and current product copy disagreed, this document records the current code behavior and calls out the ambiguity rather than manufacturing a new contract.

## Canonical contract reconstructed

### Ownership and disclosure

- A generic env value belongs to the `users` row in which it is stored. There is no tenant-global or shared generic env class.
- External user reads—including self, admin, and superadmin—receive only `{ set, scope, resource_id }` metadata. They never receive plaintext or stored ciphertext.
- Admin management rights permit replacing/deleting some lower-role users' values but do not imply a plaintext reveal operation. Exact executor commands may resolve a bounded credential DTO for their token principal. Host/code/config control is outside that protection and remains a trusted-administrator boundary.
- Agentic-tool credentials are also user-owned, but resolve only for the selected tool. Provider credential resolution is separate from generic process env resolution.
- Session selection rows are secret metadata, not secrets: they contain names only. Their implicit owner is `sessions.created_by`.

### Scope, resolution, and lifetime

- `global`: eligible for a task executing as that user.
- `session`: eligible only when the session has a matching name selection **and** `sessions.created_by` equals the execution user.
- Effective task-process precedence is:
  1. allowlisted host/substrate runtime metadata;
  2. gateway fallback values;
  3. the execution user's eligible global/session variables;
  4. gateway `forceOverride` values;
  5. narrow trusted additional executor fields;
  6. the daemon-resolved `GIT_CONFIG_PARAMETERS` operator policy is overlaid last.
- Values are snapshotted at process launch. Changing a value, scope, or selection affects a future launch, not a running process. The already-running process retains its environment until it exits; task heartbeat/termination bounds, rather than live revocation, limit that period.
- Empty values are rejected on user/gateway write; `null` deletes. There is no tombstone/unset overlay. Rename is delete plus create.
- Variable names are portable uppercase identifiers matching `^[A-Z_][A-Z0-9_]*$`. Values are UTF-8 strings up to 10 KiB and may not contain NUL. Explicit user mappings have no semantic deny-list: the user already controls their own terminal/executor. Consumers with narrower authority, notably managed Git, accept a typed subset instead of a generic map.

### Genealogy and remote triggers

- Fork/spawn copies selection **names**, never values. The copied names resolve against the child session's attributed owner. With `dangerously_allow_session_sharing=false`, a cross-user child is attributed to the caller; with the legacy dangerous flag enabled, the documented identity-borrowing behavior remains.
- A callback carries message content/relationship state, not an env grant.
- Schedules create under the schedule owner and do not independently copy arbitrary session selection rows.
- Gateway sessions use their configured Agor execution owner plus explicit channel env. They are not an implicit grant to some other profile.
- Prompting another user's existing session is currently a mixed-identity operation: task generic env/provider credentials come from the durable prompter, while branch mounts and per-user home remain session-creator-bound. This is documented as high trust but still needs a final product decision.

### Reserved ambient delegated-launcher environment

Ambient daemon values named `AGOR_CLOUD_*` are the one operator-controlled
exception to the templated launcher's minimal environment. In delegated mode,
the daemon copies that reserved ambient prefix only into the trusted
`sh -c <executor_command_template>` launcher process and the separately
configured trusted executor-heartbeat helper. The Agor Cloud helpers use the
namespace for their runtime-service endpoint and credentials; see
[`preset-io/agor-cloud#198`](https://github.com/preset-io/agor-cloud/issues/198).

The boundary is deliberately a prefix rather than a field list so the trusted
launcher can evolve its credential contract without another silent outage.
That choice makes every operator value under `AGOR_CLOUD_*` available to the
launcher, so deployments must not place unrelated daemon or tenant secrets in
the reserved namespace. `DATABASE_URL`, `AGOR_MASTER_SECRET`,
`AGOR_JWT_SECRET`, provider credentials, storage credentials, and all other
daemon/internal ambient values remain outside the launcher environment by
default.

The exception is launcher-only at Agor's process boundary: ambient
`AGOR_CLOUD_*` values are not added to the actor's resolved session environment,
the authenticated executor payload on stdin, or heartbeat JSON. Executor
payload env remains actor/session data assembled through
`createUserProcessEnvironment`; the executor then preserves the delegated pod's
own process identity and loader policy. The helper's stdout/stderr are discarded
rather than relayed into daemon logs; only closed spawn/exit metadata is logged.

This namespace qualification is specifically about **ambient daemon
configuration**. The generic managed-env store does not currently reserve
identically named user mappings semantically; such a mapping is user data and
does not grant access to the operator's ambient value. Ambient `AGOR_CLOUD_*` is
system/global operator configuration, not tenant-owned session configuration.
Trusted tenant/user/template variables and the authenticated payload continue
to carry execution authority across the boundary, and the external launcher
remains responsible for binding them to the correct isolated workload.

The grant is non-transitive. Removing every `AGOR_CLOUD_*` entry from a
descendant's direct environment is necessary but not sufficient: a same-UID
workload in the helper/daemon process namespace may recover the helper's initial
environment through `/proc/<pid>/environ`. A conforming launcher must place the
workload behind a pod/container, UID, and process-inspection boundary that makes
the credential-bearing helper unreadable. Same-process wrapper modes must fail
closed when that isolation is absent. This descendant containment contract is
tracked in the explicitly linked Agor Cloud design issue above; Agor cannot
enforce it after handing control to an opaque external launcher.

## Storage and cryptography inventory

### Exact persisted classes

| Class                                 | SQLite                                                              | PostgreSQL                                      | At-rest representation                                                                  | Owner/binding                                                         | External projection                                                               |
| ------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Generic user env                      | `users.data.env_vars[name]`                                         | same, `users.tenant_id` + forced RLS            | legacy string or `{value_encrypted, scope, resource_id, extra_config}`                  | user row; tenant via row/RLS                                          | name/presence/scope only                                                          |
| Agentic-tool credential/config fields | `users.data.agentic_tools[tool][field]`                             | same + tenant RLS                               | historical AES-GCM envelope for credential-shaped fields                                | user + tool by resolver convention                                    | presence and permitted nonsecret config only                                      |
| Session env selection                 | `session_env_selections(session_id, env_var_name)`                  | plus `tenant_id`, forced RLS                    | plaintext name only                                                                     | implicit `sessions.created_by`; FK cascade                            | owner/admin API only; no realtime publication                                     |
| Gateway platform credentials          | `gateway_channels.config`                                           | same + tenant RLS                               | configured sensitive fields use historical AES-GCM envelope                             | tenant/channel by repository convention                               | sentinel redaction                                                                |
| Gateway process env                   | `gateway_channels.agentic_config.envVars[]`                         | same + tenant RLS                               | each value uses historical AES-GCM envelope                                             | tenant/channel by repository convention                               | names/config flags; values redacted                                               |
| Gateway inbound `channel_key`         | plaintext indexed column                                            | plaintext indexed column + tenant uniqueness    | high-entropy UUID bearer lookup, **not encrypted**                                      | tenant/channel                                                        | always redacted; inbound equality lookup needs raw value                          |
| MCP server env/headers/auth           | `mcp_servers.data`                                                  | same + tenant RLS                               | secret fields use historical AES-GCM/redaction repository paths                         | server row/provenance/mode                                            | centralized MCP redactors/sentinels                                               |
| Durable MCP OAuth grants              | `user_mcp_oauth_tokens`                                             | same                                            | SQLite currently stores grant fields as plaintext; PostgreSQL uses the bound envelope   | PG AAD: tenant + subject/shared + server + generation + field/purpose | never raw through normal service DTO                                              |
| OAuth/device pending material         | process/local or durable attempt rows, depending flow               | durable tenant rows                             | bound envelope; terminal paths clear sealed material                                    | purpose plus tenant/user/server/attempt binding                       | status/error code only                                                            |
| App/Knowledge secrets                 | `app_variables.value_encrypted`                                     | same + tenant RLS                               | historical AES-GCM envelope when `is_encrypted`                                         | tenant namespace/key by repository convention                         | semantic settings return configured/presence metadata                             |
| Artifact required env                 | `artifacts.required_env_vars`; `artifact_trust_grants.env_vars_set` | same + tenant RLS                               | names only                                                                              | artifact + viewer consent                                             | artifact metadata exposes names                                                   |
| Artifact runtime env file             | not persisted                                                       | not persisted                                   | synthesized plaintext `/.env` in a per-viewer artifact response after trust             | authenticated viewer's globals only                                   | returned only to that view; not service/realtime/MCP artifact row                 |
| Tenant portability                    | raw table JSONL + manifest/archive                                  | same                                            | ciphertext is exported byte-for-byte; deployment master key is not                      | tenant export capability                                              | inspect summaries are secret-free; archive is credential-bearing                  |
| `agor init` re-init backup            | renamed Agor home (`.agor.bkp.*`)                                   | local CLI filesystem, independent of DB dialect | DB ciphertext, plaintext deployment config/key, and native credential homes can coexist | local operator                                                        | top-level directory is forced to `0700`; treat as a decryptable credential backup |
| Physical DB/WAL/backups               | DB/WAL/filesystem                                                   | DB/WAL/provider backup                          | ciphertext for managed env values; plaintext for explicitly plaintext classes above     | deployment/DB operator                                                | outside application DTOs                                                          |

The last four rows are important distinctions: a name is sensitive metadata but not the value; an artifact runtime response intentionally discloses a viewer-selected value to untrusted artifact code after explicit trust; tenant portability preserves ciphertext rather than decrypting; and hard deletion cannot cryptographically erase historical WAL, snapshots, or already-created backups.

### Historical generic envelope

`packages/core/src/db/encryption.ts` uses:

- AES-256-GCM;
- a fresh 16-byte random salt per write;
- `scrypt(masterSecret, salt, 32)` key derivation;
- a fresh 16-byte random IV per write;
- a 16-byte authentication tag;
- hex serialization `salt:iv:tag:ciphertext`.

This is authenticated encryption and gives probabilistic nonce separation. The fix makes the parser exact-length/even-hex, makes missing/empty keys fail closed, removes the historical plaintext fallback, and collapses parser/auth/OpenSSL failures to `Secret decryption failed`.

Limitations:

- no format version or key identifier;
- no purpose-domain separation;
- no AAD binding to tenant, user, row, variable name, gateway, or field;
- the generic helper accepts any nonempty master-secret length; standard setup generates and documents 32 random bytes and HA enforces at least 32 characters, but standalone startup does not reject a legacy weak value;
- a ciphertext can be swapped between compatible legacy fields and will authenticate under the same deployment key;
- no online keyring, rotation, or bulk re-encryption transaction;
- changing/loss of the key makes old values unreadable;
- tenant export/import requires the same deployment key for these ciphertexts.

Random salt plus random IV makes accidental nonce reuse negligible, but it does not provide record binding. Tests cover nonce diversity, malformed/truncated/odd-hex envelopes, bit changes, wrong keys, empty plaintext, missing keys, and normalized errors.

### Bound envelope already in the repository

`oauth-secret-envelope.ts` uses AES-256-GCM with scrypt, 16-byte salt, 12-byte IV, base64url fields, an explicit `agor-mcp-oauth:v1` prefix, purpose domains, and caller-supplied AAD binding. PostgreSQL OAuth grants bind tenant, subject/shared marker, server, grant generation, field, and purpose. Pending attempts bind their attempt authority.

This is the target cryptographic shape for a future generic-secret v2. It must not be adopted for generic writes until all readers, migration tooling, old replicas, rollback binaries, export/import, and key rotation have a compatible plan.

## Before/after data flow

### Write path

**Before**

`UI / REST / Socket.IO / MCP widget` → Feathers field allowlist and role check → user/gateway service validation → historical envelope → JSON row → after hook redaction. Gateway REST create encrypted in both a hook and the repository, producing a double envelope. Concurrent SQLite user JSON patches could overwrite an unrelated secret patch after reading the same old JSON.

**After**

`UI / REST / Socket.IO / MCP widget` → authenticated actor + strict field allowlist → per-tenant/user in-process mutation serialization → canonical name/value/NUL/size validation → service authorization → one repository/service encryption boundary → tenant transaction → JSON compare-and-swap + selection cleanup → metadata-only DTO. Gateway has one encrypt-on-write boundary; direct/provider-less service calls still hit authoritative validation. PostgreSQL retains its cross-replica advisory/transaction fences. A stale concurrent JSON mutation fails rather than silently replacing another encrypted map.

### Read/resolve path

**Before**

User repository row → decrypt every matching user variable → load selection names by `session_id` only → precedence merge → executor payload. A prompter A against owner B's session could therefore use B's selected name as an oracle selecting A's same-named session secret. Corrupt gateway ciphertext fell back to the stored representation. Gateway old double-envelopes required an undocumented second decrypt in the prompt path.

**After**

Tenant-scoped user row → decrypt only the execution user's map → inner join selection to a session whose `created_by` is that same user → validate/filter every user/gateway map again → deterministic precedence → authenticated JSON-stdin payload. Corrupt gateway fields are dropped, never used as credentials; prompt has a narrow read-only compatibility decrypt for historical double envelopes.

### Spawn/consumer path

**Before**

Resolved task env was safe when `preparedEnv` was supplied, but fixed local executor commands and both templated launcher paths defaulted to `{...process.env}`. Git additionally spread `process.env`, admitted `GIT_CONFIG_*`, command/helper/editor/proxy/path controls from the user map, and enabled simple-git's unsafe flags. Managed lifecycle actions used the branch creator's env/home even when another authorized actor initiated the action.

**After**

- fixed local executor default: curated host allowlist only;
- task/lifecycle executor: already-resolved actor env plus narrow daemon URL/log fields;
- trusted external launcher/helper shells: the templated executor launcher and operator-configured executor-heartbeat callback share one daemon-owned environment policy consisting of the curated minimal host runtime allowlist plus the reserved operator-controlled `AGOR_CLOUD_*` launcher namespace; bounded payloads remain on JSON stdin and never receive those ambient launcher credentials;
- executor credential helpers other than those two explicitly trusted external paths: curated minimal host runtime allowlist only; bounded data remains on stdin or the command payload;
- managed Git: an executor-only, exact-command capability resolves only token/proxy/TLS fields for the token principal; authenticated HTTP transport runs in a clean temporary repository, and subsequent mutable-repository/materialization operations are credential-free;
- managed lifecycle/log action: authenticated actor consistently supplies command token, env, and delegated home; trusted provider-less automation falls back to the branch creator;
- no host SSH/GPG agent socket or ambient `GIT_SSH_COMMAND` is projected into user/sandbox/delegated processes.

## Access-control and consumer matrix

| Consumer/path                               | Effective identity                                              |                            Generic globals |                                     Session scope |                                Tool/provider creds |                       Gateway env | Notes/invariant                                                                                                                                        |
| ------------------------------------------- | --------------------------------------------------------------- | -----------------------------------------: | ------------------------------------------------: | -------------------------------------------------: | --------------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Normal prompt, simple                       | durable task prompter                                           |                                        yes |                        owner-bound selected names |                            selected tool/user only |                 if gateway source | no ambient daemon secret; simple filesystem remains daemon-trust boundary                                                                              |
| Normal prompt, sandbox                      | durable task prompter                                           |                                        yes |                        owner-bound selected names |                            selected tool/user only |                 if gateway source | RBAC-derived branch mounts; creator-bound home/FS for existing session                                                                                 |
| Normal prompt, delegated                    | durable task prompter                                           |                                        yes |                        owner-bound selected names |                            selected tool/user only |                 if gateway source | trusted launcher gets only minimal runtime env plus reserved operator `AGOR_CLOUD_*`; those values stay out of payload; substrate enforces identity    |
| Standalone/local executor                   | token subject / prepared actor                                  |                only if explicitly prepared |        only if session-bound resolution requested |                         command-specific API fetch |                  command-specific | default fixed commands use curated env, never daemon ambient                                                                                           |
| HA executor/replica                         | token task/user/tenant claims                                   |                              same as above |            same owner-bound join under tenant RLS |                                               same |                              same | each launch resolves in its tenant DB scope; old replicas must be drained during rollout                                                               |
| Git clone/fetch                             | exact Git command-token principal                               |           bounded token/proxy/TLS DTO only |                                                no |                                no agentic-tool bag |                                no | raw token becomes a canonical-host extraheader in clean transport, never argv; checkout/worktree phase is credential-free                              |
| Managed environment start/stop/restart/nuke | authenticated action actor; creator only for trusted automation |                              actor globals |                              no session selection |                                no agentic-tool bag |                                no | same command token/env/delegated-home actor; branch command itself can print its env                                                                   |
| Environment logs                            | authenticated action actor                                      |                              actor globals |                                                no |                                                 no |                                no | creator values are not lent to collaborator fetching logs                                                                                              |
| Automatic health observation                | daemon-owned bounded observer                                   |                                         no |                                                no |                                                 no |                                no | direct HTTP GET with no env map or authorization header; redirect handling is explicit                                                                 |
| Browser terminal                            | authenticated terminal user                                     |                               user globals |                              no session selection |                                                 no |                                no | simple mode is explicitly host-trusting; sandbox/delegated boundaries apply                                                                            |
| Artifact view/runtime                       | authenticated viewer after trust                                |          viewer globals by requested names |                                                no |                                                 no |                                no | synthesized per-viewer `/.env`; artifact code can exfiltrate what user approved                                                                        |
| Fork/spawn/subsession/btw                   | attributed child owner                                          |                        child owner globals |         copied names resolve only for child owner |                                   child owner/tool | only if child has gateway context | values never copied; dangerous session-sharing flag changes attribution as documented                                                                  |
| Callback                                    | callback task actor                                             | normal task resolution if callback prompts |                                      no new grant |                                  normal task rules |                      no new grant | relationship/message delivery does not copy an env value                                                                                               |
| Executor heartbeat callback                 | trusted daemon operator hook                                    |                                         no |                                                no |                                                 no |                                no | shares the launcher-only minimal runtime + reserved `AGOR_CLOUD_*` policy; command receives bounded heartbeat JSON on stdin and no session/payload env |
| Schedule                                    | schedule creator                                                |                            creator globals |        no arbitrary source-session selection copy |                                       creator/tool |      no unless explicitly gateway | next run resolves fresh values                                                                                                                         |
| Message gateway                             | configured Agor execution owner                                 |                              owner globals | gateway sessions do not borrow foreign selections |                              configured owner/tool |            channel fallback/force | platform and connector credentials remain gateway-specific                                                                                             |
| MCP tool/server                             | authenticated caller/token subject                              |       only explicit template/resolver uses | session MCP association does not itself grant env | per-user grant for caller or explicit shared grant |                                no | MCP redactors cover auth/header/env ciphertext and plaintext                                                                                           |
| Secure env widget                           | authenticated submitter                                         |                                 write only |       owner-only session scope; guests use global |                                                 no |                                no | value bypasses model transcript; shared-session submissions never mutate the session owner's credential profile                                        |
| Users REST/UI/MCP                           | self/admin metadata policy                                      |                                  no values |                         names/scope metadata only |                           presence/config metadata |                                no | select/include/projection cannot bypass `rowToUser`; provider-less actor-less mutation reserved for trusted bootstrap paths                            |
| Socket.IO/realtime                          | tenant channel + service policy                                 |                                  no values |                                no selection event |                                          no values |                          redacted | user events strip self-only fields; selection service audience is `none`                                                                               |
| Analytics                                   | attributed IDs/counts/configured booleans                       |                                         no |                                                no |                                           no value |                          no value | reviewed payload builders do not serialize user JSON or env maps                                                                                       |
| Tenant export/import                        | privileged portability operation                                |                           ciphertext bytes |                                             names |                                   ciphertext bytes |                  ciphertext bytes | master key excluded; archive and DB backup are credential-bearing infrastructure                                                                       |

## Findings, proof, and disposition

Severity reflects confidentiality/tenant impact under the deployment's stated trust model, not exploitability from an unauthenticated internet client.

### High — daemon ambient secrets reached executor and Git children (fixed)

**Proof:** both templated `spawn('sh', ...)` paths, the local fixed-command default, the CODEX_HOME auth helper, and the executor-heartbeat command inherited `process.env`; `createGit` also spread `process.env`. Setting labelled master/DB/JWT/provider canaries in the parent made them present in captured child options. This did not require a DTO read.

**Impact:** an external launcher, a compromised fixed executor, or code executed by Git could receive deployment-wide credentials, crossing every user and tenant boundary.

**Fix:** minimal ambient allowlists at `spawn-executor`, Codex auth dispatch, the heartbeat callback, and `@agor/git`; JSON stdin retained. One centralized trusted-launcher environment policy gives exactly two operator-configured external paths—the templated executor launcher and executor-heartbeat callback—the explicit reserved `AGOR_CLOUD_*` runtime-service namespace exception. The exception does not enter session env, executor payload, or heartbeat JSON. Proxy URLs, provider tokens, Git identity, XDG paths, and account startup context are absent unless supplied through the authenticated user's explicit mapping. The daemon-resolved Git safety policy is the sole explicit session-process overlay.

### High — managed lifecycle confused branch ownership with execution authority (fixed)

**Proof:** `resolveEnvironmentExecutorContext` used `branch.created_by` while the command token was issued to the authenticated `params.user`. A collaborator with lifecycle permission could arrange a branch command/log output that observed the creator's global env.

**Fix:** one `executionUserId` supplies the command token, decrypted env, and delegated home. Provider-less internal health/lifecycle automation has an explicit creator fallback.

### High — cross-owner same-name session selection (fixed)

**Proof:** create users A/B, give both a session-scoped variable with the same name, select the name on B's session, then resolve A with `sessionId=B`. The old `asSet(sessionId)` returned the name and disclosed A's value to A's task despite A never selecting it for an A-owned session.

**Fix:** `asSetForOwner` joins `sessions.created_by=userId`; create/bulk/initialization routes validate that every selection is an existing session-scoped variable of the session creator. Foreign resolution returns no session-scoped value.

### High — fixed Git operation admitted process/config execution controls (fixed)

**Proof:** resolved generic env could contain `GIT_CONFIG_COUNT/KEY/VALUE`, `GIT_SSH_COMMAND`, askpass, editor/pager, external diff, template/exec path, proxy command, repository/object path, and trace controls. A direct `@agor/git` caller could also supply generic loader/shell controls such as `LD_PRELOAD`, `NODE_OPTIONS`, or `BASH_ENV`. `createGit` opted into simple-git's corresponding unsafe flags.

**Fix:** generic user mappings remain generic only in the user's own executor. Managed Git uses a typed token/proxy/TLS DTO returned by an executor-only exact-command service; ordinary users, admins, service accounts, and provider-less calls cannot reveal it. The raw token is consumed into a canonical-host Authorization header in a clean transport repository, then removed before local checkout/worktree operations.

### High — process-wide env mutation used only per-user exclusion (fixed)

**Proof:** overlap `withUserEnvironment(A)` and `withUserEnvironment(B)`. Because the locks were keyed by user, both mutated the single process-wide `process.env`; each callback could observe the other's value.

**Fix:** one FIFO process-global mutex with `finally` restoration. New executor paths should continue to pass explicit env objects rather than use this compatibility helper.

### Medium — missing master key could regress to plaintext (fixed)

**Proof:** the legacy utility returned plaintext when `AGOR_MASTER_SECRET` was empty, even though current startup usually fails before service registration. Direct library/service use or a bootstrap regression could therefore persist an unencrypted value.

**Fix:** encrypt/decrypt fail closed for absent or explicitly empty keys. Product documentation now matches actual fail-fast startup and states that online master-key rotation does not exist.

### Medium — gateway double encryption and corrupt-ciphertext fallback (fixed)

**Proof:** Feathers create hook encrypted `agentic_config.envVars`, then `GatewayChannelRepository` encrypted again. Repository decryption returned the inner envelope; prompt performed a compensating second decrypt. Other corrupt values were returned unchanged and could be used as credentials.

**Fix:** repository is the single writer; prompt retains a read-only double-envelope compatibility step; failed secret opens drop the field and final runtime filtering prevents use. New and old binaries can read new single envelopes; the new prompt can read historical double envelopes.

### Medium — invalid/NUL maps reached process spawn (fixed)

**Proof:** Node rejects NUL in env values at spawn. Direct/provider-less gateway data and imported/old JSON could bypass the Profile validator, producing deterministic failures on every future task/action. Invalid/lowercase/shell-like names were not universally filtered at final merge.

**Fix:** canonical portable-name, NUL, and byte-size checks at ingress and final runtime filters; gateway service also rejects duplicates, empty values, oversize values, and unresolved redaction sentinels. There is deliberately no semantic deny-list for a user's own mapping.

### Medium — env mutation and selection cleanup were not atomic/concurrency-safe (fixed)

**Proof:** SQLite user JSON patches performed read/modify/write without a native transaction or CAS, allowing two unrelated secret rotations to lose one update. Deleting a session-scoped var or changing it to global left stale selection metadata. Selection `setAll` also deleted and reinserted outside a native transaction; failure could leave an empty set, and concurrent PostgreSQL replicas could commit the union of two replacement requests.

**Fix:** per-tenant/user process mutex, SQLite `BEGIN IMMEDIATE`/PostgreSQL tenant transaction, JSON snapshot CAS, and cleanup of owned-session selection names in the same transaction. Selection replacement is one tenant transaction and locks its parent session row across PostgreSQL replicas; idempotent add is a single conflict-safe insert. A stale cross-process/replica request fails closed instead of silently overwriting. Delete/global-scope cleanup covers all sessions owned by that user without materializing an unbounded session-ID parameter list.

### Medium — legacy internal helper bypassed scope filtering (fixed)

**Proof:** `UsersService.getEnvironmentVariables` decrypted every stored generic entry regardless of `global`/`session` scope. It was not transport-exposed and had no current caller, but its stated purpose invited a terminal/background path to bypass selection and lifetime rules later.

**Fix:** the helper now delegates to the canonical resolver without a session ID, so it returns globals only. Any future session consumer must provide an owner-bound session ID explicitly. A regression test stores both scopes and proves the legacy helper excludes the session value.

### Low — selection names had an unnecessary realtime audience (fixed)

**Proof:** `session-env-selections` was publishable to branch/session channels despite having no browser subscriber. Names such as provider-specific token identifiers are credential metadata.

**Fix:** default-deny audience `none`; API authorization remains for explicit reads/writes.

### Low — artifact dotenv synthesis did not escape carriage returns (fixed)

**Proof:** artifact runtime values were quoted and escaped for backslash, quote, and LF, but a stored CR remained literal. Dotenv readers that accept CR as a record boundary could interpret the remainder of one consented value as another synthesized variable.

**Fix:** synthesized artifact values escape both CR and LF. A deterministic regression asserts that neither record separator survives in the generated line. This does not change the explicit artifact-consent boundary: trusted artifact code can still read the value the viewer approved.

### High residual — generic envelope has no AAD/version/key rotation (decision required)

Ciphertext swapping between legacy fields under one deployment key authenticates. There is no supported online key rotation, key ID, re-encryption job, or rolling mixed-reader bridge. See rollout decisions below.

### Medium residual — aggregate env size has no resolved-process cap (decision required)

Each value is capped at 10 KiB, but the user map has no count/aggregate-byte quota. Enough values can exceed OS `ARG_MAX`/environment limits and make tasks fail. A portable cap and error contract should be chosen rather than guessed.

### Medium residual — mixed identity when prompting another user's session (decision required)

Generic task credentials are prompter-bound while branch mounts/home remain session-owner-bound. The behavior avoids automatic secret lending but composes two authorities in one process. Product must decide whether cross-owner prompting should be prohibited, fully re-attributed, or explicitly retain this high-trust composition.

### Low residual — widget secret and selection are separate writes

The widget writes only to the authenticated submitter. A shared-session guest may choose global scope (which already follows that guest into any prompted task) but cannot create a session-scoped value on somebody else's session. For an owner submission, the encrypted user write and session-selection write remain separate durable steps: a failure after the first is confidentiality-safe but can leave an unselected value for operator recovery.

### Medium adjacent residual — plaintext credential classes

SQLite MCP OAuth grant columns and gateway inbound `channel_key` are plaintext by current design. Neither is a generic env value, but both are secret-bearing database fields found during the requested inventory. Migrating OAuth grants requires legacy detection/re-encryption and compatibility tests; encrypting `channel_key` requires a lookup fingerprint/hash plus encrypted material or a deliberate bearer-token hashing contract. These should be separate security changes.

### Low residual — empty/whitespace/rename/tombstone UX

The API preserves nonempty leading/trailing whitespace but the current UI trims entry values; empty means invalid and `null` means delete; no tombstone can suppress a lower-precedence gateway/global value; rename is not atomic. These are product semantics, not silently changed in this audit.

### Operational residual — deletion and historical copies

Deleting a row removes live references and selection metadata but cannot erase bytes already copied into SQLite WAL/pages, PostgreSQL WAL, replicas, portability archives, snapshots, logs generated by user commands, or provider backups. Backup retention and destruction remain operator responsibilities. A running process also retains its launch snapshot until termination.

`agor init`'s recommended re-initialization backup is especially sensitive: it renames the whole Agor home, so encrypted database values and the plaintext config copy of the deployment master key coexist. This audit forces the backup root to mode `0700`, but it is still intentionally decryptable and must be retained/destroyed as a credential backup rather than a value-redacted export.

### Operational residual — delegated substrate environment

Agor now prevents the daemon environment from becoming an external helper's environment, except for the documented operator-controlled `AGOR_CLOUD_*` launcher namespace on two trusted paths: templated executor launch and the executor-heartbeat callback. Agor includes those credentials only in the immediate trusted launcher/helper environment; it does not include them in executor payload/session env or heartbeat JSON, and it discards helper output instead of treating it as a logging channel. Configuring either command therefore designates that operator-authored process as part of the launcher trust boundary; arbitrary user-authored commands must never use this policy. A conforming helper must terminate the credential grant with both an explicit descendant environment and containment that prevents same-UID `/proc` inspection of the helper/daemon. After the launcher crosses into an external substrate, that substrate owns the executor's initial process environment and containment. Executor commands overlay ordinary authenticated payload variables but preserve substrate-owned `HOME`, `PATH`, identity, `LD_*`, and `DYLD_*` values. Certification must prove the descendant environment, process/UID namespace boundary, workload identity, and pod-owned credential behavior; Agor cannot sanitize an opaque external launcher without an explicit descriptor contract.

### Low residual — decryption timing oracle is not a public boundary

Malformed legacy envelopes are rejected before scrypt while well-formed wrong-key envelopes perform scrypt and GCM verification, so the helper is not constant-time across format classes. Normal APIs expose neither ciphertext nor a caller-controlled decrypt oracle; choosing stored ciphertext requires trusted repository/DB access. Error text is normalized. A future envelope API should preserve that external non-oracle property rather than claim cryptographic constant-time parsing.

## Adversarial boundary review

- **Foreign IDs / tenant IDs:** PostgreSQL tests use two tenants and force RLS on users, sessions, and selections. The resolver cannot join a foreign-tenant session or user through a non-superuser connection. SQLite relies on globally unique IDs and the single-tenant trust model.
- **Role escalation:** normal User DTOs never expose stored JSON. Admins receive metadata, not values. Role checks and actor-still-current predicates remain in the final user mutation statement.
- **Provider-less Feathers:** direct calls do not bypass service validation. Actor-less User mutations remain a documented narrow bootstrap seam; service-account mutations are denied unless explicitly trusted. Session-selection initialization now validates owner/scope even on the internal path.
- **Projection/include tricks:** env values live inside repository `users.data`, but every service read maps through `rowToUser`; external queries cannot request raw JSON. Raw database access is deployment compromise.
- **Realtime replacement events:** User events are tenant-routed and strip self-only fields; session env selection publication is disabled; gateway events pass the transport redactor.
- **MCP:** Users tools consume normal User DTOs. MCP server/gateway tools use centralized redactors. Executor/task tokens carry tenant/user/session/task authority and do not expose a general User secret-read method.
- **Errors/logs:** decryption errors carry no ciphertext/plaintext and now normalize malformed versus wrong-key detail. Rejection logs contain variable names/counts only. Secret-bearing launcher/helper stdout and stderr are discarded. Claude result diagnostics use the centralized closed runtime projection plus stderr presence/byte count; raw provider result fields and raw stderr are not logged or retained for logging. User-authored lifecycle/agent/Git commands can always print values legitimately present in their own process; this is within the ambient-env threat model, not a redaction guarantee.
- **Import/export:** tenant portability never invokes a secret DTO or decryptor; it moves raw ciphertext. The master key is not included, so an archive alone cannot decrypt generic managed values, but the archive must still be protected.
- **HA:** PostgreSQL refresh/executor authority is generation/fingerprint fenced. Env resolution is read-at-launch; no decrypted env cache or cross-replica realtime payload exists.

## Verification

### Deterministic suites

Focused tests added or expanded cover:

- generic encryption parser, key absence/change, authentication, nonce diversity, and error normalization;
- name/value/NUL/byte-size validation and final map filtering;
- same-owner versus foreign-owner selection resolution;
- selection route ownership/scope checks and realtime silence;
- two-user process-env overlap;
- lifecycle actor env/home/token consistency;
- gateway single envelope, historical double-envelope read, corrupt secret fail-closed, duplicates/sentinel/unsafe map validation;
- user delete/scope cleanup, transaction rollback, and JSON compare-and-swap behavior;
- fixed local and templated executor daemon-secret stripping;
- reserved `AGOR_CLOUD_*` delivery to both trusted external invocation paths—the templated executor launcher and heartbeat helper—without launcher-credential payload/session-env/heartbeat-JSON disclosure, while undefined values and unrelated daemon secrets remain absent;
- delegated pod `HOME`, `LD_*`, and `DYLD_*` precedence while ordinary authenticated payload env remains usable;
- Git process-env stripping and user process-control rejection;
- artifact dotenv CR/LF record-injection escaping;
- PostgreSQL non-superuser forced-RLS resolution with two tenants, users, and a replica-shaped second client.

Validation results on the final PR head are recorded in the PR and completion report. The intended commands are:

```bash
pnpm --filter @agor/git test
pnpm --filter @agor/core exec vitest run \
  src/db/encryption.test.ts \
  src/config/env-validation.test.ts \
  src/config/env-locking.test.ts \
  src/config/env-resolver.test.ts \
  src/db/repositories/session-env-selections.test.ts
pnpm --filter @agor/daemon exec vitest run \
  src/services/branches.test.ts \
  src/services/gateway-channels.agentic-config.test.ts \
  src/services/users.git-env.test.ts \
  src/utils/realtime-publish.test.ts \
  src/utils/spawn-executor.configured.test.ts \
  src/utils/executor-codex-auth.test.ts \
  src/utils/executor-heartbeat-callback.test.ts
pnpm --filter @agor/cli exec vitest run src/commands/init.test.ts \
  -t "forces a re-init backup root"
pnpm --filter @agor/daemon exec vitest run src/services/artifacts.test.ts \
  -t "quotes dotenv values without permitting CR/LF record injection"
pnpm test:postgres:docker
pnpm test:ha:docker
pnpm check:multitenancy-boundaries
pnpm exec biome check <changed source/test/docs files>
pnpm --filter @agor/git exec tsc --noEmit --customConditions source
pnpm --filter @agor/core exec tsc --noEmit --customConditions source
pnpm --filter @agor/daemon exec tsc --noEmit --customConditions source
```

Observed results on the audit working tree:

- focused `@agor/git`: 3 files, 10 tests passed;
- focused core security suites: 5 files, 111 tests passed;
- focused daemon security suites: 7 files, 267 tests passed;
- focused CLI private-backup regression: 1 passed (23 unrelated tests skipped by the name filter);
- focused artifact dotenv regression: 1 passed (60 unrelated tests skipped by the name filter);
- SQLite concurrency/cleanup follow-up: 9 tests passed;
- PostgreSQL disposable Docker runner: application role verified `NOSUPERUSER`/`NOBYPASSRLS`; 36 files, 187 tests passed, 0 failed/skipped; interruption cleanup passed;
- custom-condition TypeScript checks for Git, core, and daemon passed; the CLI-wide
  check remains blocked by its existing unbuilt `@agor/daemon` package-resolution
  dependency, while the changed CLI module imports and focused test passed;
- the full CLI `init.test.ts` subprocess cases were attempted from the unbuilt
  workspace and hit the existing missing `@agor-live/client`/`@agor/core` dist
  resolution (9 integration failures); the new source-level backup-permission
  regression passes independently;
- production-shaped Docker image compilation passed as part of the HA harness;
- full repository lint passed (2,471 files; 330 frontend design-system fixtures);
- multitenancy, daemon-filesystem, realtime, and short-ID boundary checks passed;
- full core run reached 3,781 passing tests and 88 intentional skips. Three suites could not resolve the unbuilt `@agor/git` package from core's Vitest config (the Git package's own full suite passed); one unrelated 100-chunk gateway test timed out while the HA image build saturated the host and passed immediately in isolation (6/6).

- full daemon: 268 files passed, 19 intentionally skipped; 3,541 tests passed and 130 skipped;
- opt-in two-replica HA Docker integration passed, including cross-replica realtime, tenant isolation, failover, Redis fencing/recovery, ACL invalidation, and non-superuser PostgreSQL deployment paths.

No user-managed development server was started.

## Rollout, rollback, and mixed versions

### Data compatibility

- No schema migration is introduced.
- Generic ciphertext serialization is unchanged; old and new binaries can read values written by this change.
- A historical raw plaintext value written while the old helper had no master key is intentionally no longer readable as a credential. It is skipped as an invalid envelope and must be replaced by its owner after the deployment key is configured.
- Gateway new writes are a single historical envelope. Old readers already decrypt one envelope, and the new reader additionally handles old double envelopes. Mixed-version writes remain readable.
- Selection cleanup deletes only name metadata for a removed value or any scope transition.
- Git/env narrowing is a behavioral security change, not a persisted-data change.

### Rolling HA

- Drain old replicas before claiming the runtime disclosure fixes are effective. An old replica can still launch with daemon ambient env, resolve foreign selection names, publish selection metadata, or use creator lifecycle env.
- After all replicas run the fixed version, no cache flush or data migration is necessary.
- Templated/delegated launcher operators must use substrate workload identity, an explicit out-of-band launcher mechanism, or the reserved operator-controlled `AGOR_CLOUD_*` launcher contract documented above. Only that prefix is forwarded from the daemon ambient environment, and only to the trusted templated launcher and trusted executor-heartbeat helper; their authenticated/bounded stdin payloads remain free of those ambient credentials. See [`preset-io/agor-cloud#198`](https://github.com/preset-io/agor-cloud/issues/198).
- Host SSH/GPG agent forwarding is intentionally removed. Configure a user-scoped agent inside the execution substrate if SSH/GPG capability is required.

### Rollback

- Database rollback is not needed; the data format is unchanged.
- Code rollback reopens the runtime disclosure defects and may recreate gateway double envelopes. Do not roll back as a mitigation for launcher configuration; fix the launcher identity instead.
- Preserve the exact old `AGOR_MASTER_SECRET` throughout rollback/restore. Replacing it is not a rollback and makes stored ciphertext unreadable.
- A tenant export containing generic ciphertext is portable only to a deployment with the same master key under the current envelope.

## Decisions required from Max

1. **Generic secret envelope v2:** approve a bridge release/keyring design with version, key ID, purpose and AAD binding (`tenant/user/name` or the appropriate row/field), idempotent re-encryption, progress/audit state, crash rollback, export/import semantics, and old-reader drain gates.
2. **Cross-owner prompt identity:** prohibit, fully re-attribute, or explicitly retain the current prompter-credentials + owner-home/FS composition.
3. **Inheritance:** finalize fork/subsession/btw/callback/gateway/schedule selection semantics beyond the current name-copy behavior (PD-17 remains open).
4. **Admin secret management:** retain write/replace/delete without reveal, or require owner-only/step-up approval for destructive changes. Host admins remain trusted either way.
5. **Unset semantics and limits:** choose tombstones, atomic rename, whitespace UI behavior, and a portable maximum count/aggregate resolved-env byte limit.
6. **Adjacent plaintext stores:** schedule migration/hashing work for SQLite OAuth grants and gateway inbound keys.
7. **Widget atomicity:** decide whether the owner-only secret+selection flow needs a one-transaction API.
8. **Master-secret strength:** decide whether a bridge release should warn and then reject standalone nonempty keys shorter than the documented 32 random bytes.
9. **Artifact disclosure:** confirm that consent means arbitrary artifact code may read/exfiltrate the selected viewer globals; otherwise move to a tool-mediated capability.

## Security invariants after this PR

1. A missing deployment master key cannot produce a new plaintext managed env value.
2. Normal API/UI/MCP/realtime reads cannot return a generic env plaintext or ciphertext, even to an admin.
3. A session-scoped name resolves only when the session belongs to the same execution user; legacy generic helpers return globals only.
4. Every untrusted env map is validated at ingress and filtered again at a process boundary.
5. Fixed executors, ordinary credential helpers, and Git children do not inherit the daemon's credential-bearing environment; only trusted templated launcher and executor-heartbeat helper shells receive the documented `AGOR_CLOUD_*` operator exception in addition to the minimal runtime allowlist.
6. A managed lifecycle command uses one authenticated actor consistently for token, env, and delegated home.
7. Managed Git receives only its typed DTO; authenticated transport and mutable-repository execution never coexist with the raw user token or generic secret bag.
8. Concurrent users cannot overlap compatibility `process.env` mutation, and concurrent User JSON patches cannot silently replace each other.
9. Gateway credentials have one encrypt-on-write boundary; unreadable stored representations never become runtime credentials.
10. Selection names do not travel on realtime channels; values never travel in analytics.
11. Decrypted task env exists only in the daemon launch scope, authenticated executor payload/stdin, and intended child process; it is not cached or written to a task/session row. Ambient launcher credentials exist only in the daemon and the two immediate trusted external launcher/helper environments, never in task/session env, executor payload, heartbeat JSON, helper output logs, or a conforming helper's separately contained workload descendants.
12. These invariants do not claim defense from the host/daemon administrator, an intentionally secret-bearing process, user-authored commands that print their own env, physical historical backups, or the unresolved legacy-envelope swapping/rotation limitations above.
