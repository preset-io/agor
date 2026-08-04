# Agentic-tool integration architecture

> **Status:** Ownership contract implemented for the OpenCode integration
> surfaces added by #2078. Named legacy seams remain below. Code remains ground
> truth.

## Goal

Adding an agentic tool should require:

1. implementing one package;
2. adding one explicit composition entry in each build surface it participates
   in; and
3. adding only genuinely shared host behavior to an existing host contract.

Removing that registration and package should remove the integration. The
daemon, executor, and UI must not accumulate new tool-name branches or parallel
maps containing the same tool metadata.

This is a monorepo plug-in boundary, not a runtime third-party plug-in system.
Registration is explicit, statically typed, and shipped with Agor.

## Terminology

- **Agentic tool:** an executable runtime integration such as Claude Code,
  Codex, Gemini, or OpenCode.
- **Model provider:** a service that supplies models, such as Anthropic,
  OpenAI, Google, or a provider exposed through OpenCode.
- **Agentic-tool package:** the code that translates between one agentic tool
  and Agor's host contracts.
- **Host:** shared Agor lifecycle, security, persistence, supervision, and
  presentation infrastructure.

OpenCode is an agentic tool. Its provider catalog is OpenCode-owned data; it
does not make each model provider an Agor runtime adapter.

## Boundary

```text
apps and shared host services
        |
        | one explicit registry lookup
        v
AgenticToolIntegration
  metadata
  configuration
  model catalog
  permissions
  authentication
  runtime adapter
  UI contributions
        |
        v
packages/agentic-tool-<tool>/
```

`@agor/agentic-tools` is the only package that knows the complete installed
tool set. Because the daemon, executor, and browser are separate build roots,
each surface has one explicit typed projection of the canonical descriptor.
Those registrations contain no duplicated tool behavior or metadata.
Consumers ask the selected integration for behavior or capabilities; they do
not switch on the tool name.

## Ownership

| Host owns                                                    | Agentic-tool package owns                  |
| ------------------------------------------------------------ | ------------------------------------------ |
| Durable `Task` lifecycle and terminal transitions            | Tool metadata and capabilities             |
| Executor watchdog and finalizer                              | Tool-specific event interpretation         |
| Termination coordinator and forced containment               | Cooperative runtime execution and abort    |
| Session projection and reconciliation                        | Configuration validation and normalization |
| Queue, callbacks, and gateway consequences                   | Model catalog semantics                    |
| Tenant, user, branch, and execution context                  | Permission descriptors and translation     |
| Authentication authorization and credential storage boundary | Tool-specific authentication protocol      |
| Unix/process containment and remote quiescence policy        | Managed tool process protocol              |
| Shared persistence and transport                             | Tool-specific UI contributions             |

An integration may return facts and evidence to these owners. It does not
replace them.

## Integration contract

The shared descriptor should stay capability-oriented and may grow only for a
requirement shared by more than one integration or necessary to eliminate a
host tool-name branch.

Conceptually:

```ts
interface AgenticToolIntegration {
  metadata: AgenticToolMetadata;
  capabilities: AgenticToolCapabilities;
  configuration: AgenticToolConfigurationAdapter;
  runtime: AgenticToolRuntimeAdapter;
  models?: AgenticToolModelCatalog;
  permissions: AgenticToolPermissionDescriptor;
  authentication?: AgenticToolAuthenticationAdapter;
  ui?: AgenticToolUIContributions;
}
```

The initial implementation may expose smaller surface-specific entrypoints
backed by the same descriptor. Do not create independent daemon, executor, and
UI registries with duplicated knowledge.

### Configuration

The host owns precedence and persistence. The selected integration owns
tool-specific validation and normalization:

```text
explicit input -> branch override -> user default -> integration fallback
                                  |
                                  v
                    integration.configuration.normalize()
```

OpenCode owns the rule that provider and model form one exact, atomic
selection. The generic resolver must not know that rule.

User and workspace defaults are tool-scoped. Selecting OpenCode never consults
another tool's workspace default. A personal default reference is valid only
when its selected inline, preset, or workspace source can materialize a
runnable OpenCode pair on its own; the user write boundary validates that
invariant before persistence. A session may still select a named preset that
inherits from its execution owner's configuration through the ordinary host
precedence rules.

When configured sources still cannot produce a required model selection during
session creation, the host may ask the selected integration for a create-time
fallback. OpenCode derives that fallback from its versioned known-model catalog
and the session owner's saved-provider evidence: prefer the first configured
known provider, then the first known provider that needs no saved credential.
The returned pair is fed through the same generic resolver as the
lowest-precedence source and is persisted on the new Session.

This fallback never overwrites explicit, preset, parent, personal, workspace,
or stale selections. It is not consulted while executing or resuming an
existing Session; execution validates the exact persisted pair and never
silently substitutes another model.

No database migration is required. A legacy `serverUrl` key may remain inert
inside existing JSON configuration until that configuration is rewritten; no
current resolver or runtime consumes it.

### Runtime

The runtime adapter reports a normalized outcome and cooperative cleanup
evidence without speaking durable Task statuses:

```ts
interface TaskRunnerReport {
  turn:
    | { outcome: 'success'; model?: string }
    | { outcome: 'failure'; error_message: string }
    | { outcome: 'interaction_timeout'; error_message: string };
  cleanup: { outcome: 'quiesced' } | { outcome: 'unverified'; reason: string };
}
```

The concrete TypeScript shape may reuse the existing executor runner while the
branch migrates. The architectural rules are fixed:

- the host supplies trusted tenant, user, branch, Task, and execution context;
- the adapter cannot infer or broaden those boundaries;
- raw tool/SDK vocabulary stays inside the integration;
- the adapter does not patch durable terminal Task state;
- failed cooperative cleanup returns evidence to the host termination
  coordinator rather than inventing containment;
- Session reconciliation remains host-owned.

The daemon places adapter-private execution inputs under one opaque
`agenticToolContext` payload field. The selected adapter validates and
interprets that value. Shared prompt payloads and executor runner signatures do
not grow `dataHome`, provider, or other OpenCode-named fields.

The existing executor `ToolRegistry` is the runtime composition point. Extend
it; do not add a second runtime registry.

The same registry optionally exposes bounded auxiliary operations such as
authentication and protected configuration reads. Those operations reuse the
executor's generic subprocess transport but are not Task executions: they do
not create Tasks, report Task lifecycle outcomes, or introduce another durable
lifecycle. The daemon supplies authorized context, the selected adapter parses
its opaque request, and the transport remains unaware of tool-specific
protocols.

For OpenCode, every expected exit returns one runner report after managed
cleanup. The authenticated executor submits it through the generic Task service.
Native question and nested-task controls remain denied until their child-session
events can be routed through Agor's task and permission owners.
For a local executor, the daemon first persists a quiesced success, failure, or
interaction timeout as a nonterminal proposal. It commits the durable terminal
Task state only after wrapper exit and process-group absence. For a remote
executor, the fenced quiescence report is the authoritative containment proof.
Unverified cleanup instead enters the existing termination coordinator and
keeps the Task `stopping` until containment is verified. A termination request
that wins the race consumes a quiesced runner report as cooperative release
evidence rather than allowing the turn result to overwrite the winning cause.

This is the focused #2078 slice of the desired
[task runtime architecture](https://github.com/preset-io/agor/pull/2090): the
existing executor is the `TaskRunner`, the Task service plus termination
coordinator form the current `TaskController`, and existing completion side
effects remain the incremental `SessionReconciler` seam. This PR does not add
three framework classes or a second lifecycle.

The slice advances the "Task terminal before runtime release" failure family,
including interaction-timeout settlement. OpenCode provides cooperative
cleanup evidence; the daemon release gate maps a quiesced report only after the
execution-mode-specific containment proof, or invokes containment for an
unverified report. Existing behavior for other agentic tools remains unchanged
until their runners adopt the same shared report contract.

### Authentication and model catalogs

The host authorizes the caller, selects the tenant-scoped credential namespace,
and exposes generic transport. The integration owns OpenCode's provider
discovery, OAuth/API-key protocol, known-model catalog, credential-evidence
mapping, and tool-specific errors.

Provider management is dynamic: a managed server discovers native
authentication methods and returns refreshed secret-safe settings after a
mutation. Model selection is deliberately lighter. The package ships a
versioned known-model catalog and combines it with a server-free read of the
caller's saved provider IDs. The fixed choices render immediately; one shared,
identity-scoped resource coalesces that availability read and is invalidated by
authentication changes. Unavailable choices are absent from normal selectors,
while a stored unavailable pair remains visible and unlisted configured
providers remain available through exact manual entry. Unconditional refresh
controls are replaced by failure-only retry. The task runtime remains
authoritative for every selected pair. MCP model discovery projects the same
caller-authorized catalog, retaining each provider ID on its models.

Secrets never enter browser registry metadata. UI contributions receive only
authorized host clients and non-secret state.

Provider authorization URLs are validated at the native-runtime boundary
before they become browser-visible. Only HTTPS and narrowly scoped loopback
HTTP URLs are accepted; malformed URLs, embedded credentials, and active-content
schemes fail closed.

### UI contributions

Shared UI renders stable slots rather than switching on tool names:

```text
model selector slot
settings/authentication slot
provider-readiness status slot
configuration summary slot
```

An integration supplies a contribution only when it needs custom UI. The host
retains layout, accessibility, loading/error boundaries, and authorization.
Readiness contributions own tool-specific semantics and reuse their existing
authorized resources; the host renders their normalized status consistently.

## Package shape

OpenCode should converge on:

```text
packages/agentic-tool-opencode/
  package.json
  src/
    shared/                public descriptor, metadata, config, permissions
    runtime/               SDK/server lifecycle, auth, and event translation
    daemon/                host-facing admission and credential contributions
    ui/                    OpenCode UI contributions
```

Surface-specific exports keep dependency direction explicit:

```text
@agor/agentic-tool-opencode
@agor/agentic-tool-opencode/runtime
@agor/agentic-tool-opencode/daemon
@agor/agentic-tool-opencode/ui
```

The package may depend on shared host contracts. Shared host packages must not
import OpenCode. Composition roots import both and register the integration.

Canonical persisted types and public client/service DTOs remain in
`@agor/core`: the generated Agor client must type stable HTTP service routes
without importing a runtime package. Raw OpenCode SDK types, native protocol
interpretation, runtime payloads, and presentation types live with OpenCode.
Core API DTOs are normalized Agor wire contracts and must not re-export the
OpenCode SDK.

## Migration on PR #2078

The branch migrates by replacement, not layering:

1. add the shared descriptor/registry contracts;
2. register thin adapters for existing tools at the current composition roots;
3. route shared configuration and runtime decisions through those contracts;
4. move OpenCode-owned modules into its package;
5. route daemon and UI slots through the registered OpenCode contribution;
6. delete the replaced OpenCode branches, maps, and old files;
7. preserve the behavior and tenant boundaries already covered by #2078.

Physical relocation of legacy Claude Code, Codex, Gemini, Copilot, and Cursor
implementations is not required in this PR. Their thin descriptors prove that
the host contract is general without expanding the refactor.

Daemon-owned Feathers authorization, tenant lookup, and branch access remain
under `apps/agor-daemon/src/integrations/<tool>/`; they must not be pulled into
the executor package. The daemon has one local integration composition root
that registers those services and contributes their tenant-hook paths. Shared
service registration and hook files do not name OpenCode.

Interactive executor commands use one generic bounded JSON-lines transport.
The transport only frames payloads, events, and control messages; the
OpenCode command adapter owns OAuth payload validation and event semantics.
This separation preserves the TaskRunner boundary above: auxiliary operations
remain bounded non-Task commands and never submit runner reports.

Every local OpenCode auxiliary command, interactive or one-shot, uses tracked
process-group containment before releasing its result or credential-mutation
slot. Templated execution is rejected for native-state operations until the
remote substrate supplies equivalent fenced cleanup evidence. An unverified
local cleanup durably retains the wrapper's containment identity under the
daemon's private runtime state before releasing the mutation slot. The next
mutation resumes containment and removes the marker only after verified
absence; a daemon restart is not cleanup proof. The marker stays with the
daemon containment owner rather than granting the daemon access to the
executor-owned native home. Enabling native-state operations on a remote or
multi-replica substrate first requires moving this fence to shared controller
state.

## Native-state and concurrency contract

The daemon derives one opaque tenant-and-user namespace and the executor maps
all four OpenCode XDG roots (`data`, `config`, `cache`, and `state`) beneath it.
Before a managed server starts, the runtime verifies the owned non-symlink
ancestor chain, private state directories, and any existing `auth.json`; it
rechecks the credential file after mutations.
The host-provided subject and Unix identity remain authoritative. This is an
OS-enforced boundary only in strict mode; shared-UID modes provide logical
separation, not protection from another same-UID process.
Hosted `required_from_auth` and delegated Unix-user modes fail admission for
OpenCode authentication and task execution until the execution substrate can
provide a durable per-user native-state home boundary.

OpenCode's native database supports simultaneous task servers for the same
subject. Credential mutations and OAuth attempts are serialized by
namespace in the daemon. Those mutations are not coordinated with an
already-running turn; a connect or disconnect is guaranteed only for later
server starts. If OpenCode adds a native cross-process locking requirement, the
package must implement that at its native-state boundary rather than adding
tool-name locks to host services.

The packaged distribution copies and links both the installed registry and the
OpenCode package as internal `@agor/*` packages. They are not public npm
dependencies and no `workspace:*` reference is allowed to escape the release
artifact.

Development containers are also explicit composition roots. Their dependency
install, package-level `node_modules` mounts, and initial build/watch order must
include every installed agentic-tool package; a clean container smoke check must
resolve the runtime adapter without borrowing host dependencies or build output.

## Deferred legacy seams

The repository still has older exhaustive tool switches that predate this
containment work:

- core default-permission selection and permission-mode mapping;
- executor normalizer selection and the watchdog's native heartbeat filter; and
- host-owned static presentation such as bundled tool artwork.

The wider runtime migration still needs these shared host changes from #2090,
not OpenCode package behavior:

- stable identities for parallel tool and background operations;
- named bounded wait profiles;
- explicit adapter/version conformance modes, including classifying quiet
  after unknown observations as adapter incompatibility rather than a semantic
  stall;
- incremental adoption of the runner report by the five legacy runners, in an
  order chosen by #2090 implementation work:
  - Claude Code;
  - Codex;
  - Gemini;
  - Copilot; and
  - Cursor;
- crash-repairable Session and gateway consequence reconciliation;
- one shared runtime-presentation derivation; and
- removal of the startup-orphan logical-release gap.

They are not extension points for new OpenCode behavior. Migrate each only when
its host contract can express the behavior for every affected tool without
moving UI, runtime, or SDK dependencies into core. This PR replaces the
OpenCode-specific branches it introduced; it does not turn a focused
containment refactor into a repository-wide rewrite of legacy integrations.

## Guardrails

- No runtime package discovery, third-party installation, or generated plug-in
  manifest.
- No second Task lifecycle, operation ledger, execution kernel, or
  reconciliation owner.
- No generic abstraction introduced only to avoid a single local conditional.
- No duplicate map or switch may remain after its registry-owned replacement
  lands.
- Existing unrelated historical tool conditionals are follow-up candidates,
  not automatic scope for this PR.
- Multi-tenant context always enters from the host and remains explicit across
  daemon, executor, credential, and catalog boundaries.

## Review test

For every file changed outside
`packages/agentic-tool-opencode/`, reviewers should be able to answer one of:

1. it defines or composes a shared host contract;
2. it removes a replaced tool-name branch;
3. it is a focused behavioral test for the boundary; or
4. it records an intentionally deferred host refactor.

If none applies, the change belongs in the OpenCode package or outside this PR.
