# Agentic-tool integration architecture

> **Status:** Target ownership for the OpenCode integration refactor. This
> document records the intended seams; code remains ground truth while the
> branch is migrated.

## Goal

Adding an agentic tool should require:

1. implementing one package;
2. registering that package once at the application composition root; and
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
packages/agentic-tools/<tool>/
```

The registry is the only place that knows the complete installed tool set.
Consumers ask the selected integration for behavior or capabilities; they do
not switch on the tool name.

## Ownership

| Host owns | Agentic-tool package owns |
| --- | --- |
| Durable `Task` lifecycle and terminal transitions | Tool metadata and capabilities |
| Executor watchdog and finalizer | Tool-specific event interpretation |
| Termination coordinator and forced containment | Cooperative runtime execution and abort |
| Session projection and reconciliation | Configuration validation and normalization |
| Queue, callbacks, and gateway consequences | Model catalog semantics |
| Tenant, user, branch, and execution context | Permission descriptors and translation |
| Authentication authorization and credential storage boundary | Tool-specific authentication protocol |
| Unix/process containment and remote quiescence policy | Managed tool process protocol |
| Shared persistence and transport | Tool-specific UI contributions |

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

### Runtime

The runtime adapter reports a normalized outcome and cooperative cleanup
evidence:

```ts
execute(context): Promise<NormalizedTurnOutcome>
abort(context): Promise<QuiescenceResult>
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

The existing executor `ToolRegistry` is the runtime composition point. Extend
it; do not add a second runtime registry.

### Authentication and model catalogs

The host authorizes the caller, selects the tenant-scoped credential namespace,
and exposes generic transport. The integration owns OpenCode's provider
discovery, OAuth/API-key protocol, catalog parsing, and tool-specific errors.

Secrets never enter browser registry metadata. UI contributions receive only
authorized host clients and non-secret state.

### UI contributions

Shared UI renders stable slots rather than switching on tool names:

```text
model selector slot
settings/authentication slot
configuration summary slot
```

An integration supplies a contribution only when it needs custom UI. The host
retains layout, accessibility, loading/error boundaries, and authorization.

## Package shape

OpenCode should converge on:

```text
packages/agentic-tools/opencode/
  package.json
  src/
    index.ts               public descriptor
    shared/                metadata, types, config, permissions
    runtime/               SDK/server lifecycle and event translation
    daemon/                auth and model-catalog adapters
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

Canonical persisted types that are genuinely shared remain in `@agor/core`;
OpenCode-only protocol and presentation types live with OpenCode.

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
`packages/agentic-tools/opencode/`, reviewers should be able to answer one of:

1. it defines or composes a shared host contract;
2. it removes a replaced tool-name branch;
3. it is a focused behavioral test for the boundary; or
4. it records an intentionally deferred host refactor.

If none applies, the change belongs in the OpenCode package or outside this PR.
