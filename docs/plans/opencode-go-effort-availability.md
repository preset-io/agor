# Plan: OpenCode Go effort availability

**Status:** implemented on this branch for PR #2619.

## Symptom and concrete reproduction

The failing Agor session is `01a051ab-93b0-76d2-a592-ae211b36efdc` (parent
`01a05196-64ea-720f-8283-a8c840388f65`) with:

```json
{
  "agentic_tool": "opencode",
  "model_config": {
    "mode": "exact",
    "provider": "opencode-go",
    "model": "qwen3.8-flash",
    "effort": "high"
  }
}
```

Task `01a051ab-93c4-74df-8ca1-ab287da89d3f` failed in about 62 seconds with
`tool_use_count: 0` and exactly:

> The selected OpenCode reasoning effort is not available for this session
> owner's provider/model and branch configuration; choose a supported effort or
> leave it unset

The executor connected, started the pinned OpenCode `1.14.33` server, and read
`/config/providers` and `/provider`. It did not create an OpenCode session or
submit an LLM prompt. This places the failure in Agor's pre-prompt availability
check rather than in an OpenCode Go inference request.

An otherwise equivalent session, `01a051ad-1406-7311-b7de-deceb3d28fe2`, used
the same owner, branch, exact `opencode-go/qwen3.8-flash` pair, and no effort.
Task `01a051ad-1418-7762-acd2-51ea5eacb996` created an OpenCode session and made
LLM calls before later failing with an unrelated `fetch failed`. That is direct
evidence that leaving effort unset passes Agor's model/effort admission and that
the provider/model pair itself resolves.

The repro branch contains no project `opencode.json`, `opencode.jsonc`, or
`.opencode` configuration. A branch-local variant override is therefore not the
cause in this repro.

## Current-main failure path

All repository citations in this section refer to this planning branch at
`384733b4b` (the current-main snapshot supplied for this investigation).

1. Agor's shared `EffortLevel` is `low | medium | high | xhigh | max`, and the
   selected value is persisted under `session.model_config.effort`
   (`packages/core/src/types/session.ts:3-7`, `packages/core/src/types/session.ts:341-360`).
2. The OpenCode integration advertises all five values as a **tool-wide**
   capability, without considering provider or model
   (`packages/agentic-tool-opencode/src/shared/index.ts:18-25`).
3. `AgenticToolConfigForm` passes that tool-wide list directly to
   `EffortSelector`; the selector only filters against the supplied global list
   (`apps/agor-ui/src/components/AgenticToolConfigForm/AgenticToolConfigForm.tsx:78-82`,
   `apps/agor-ui/src/components/AgenticToolConfigForm/AgenticToolConfigForm.tsx:118-135`,
   `apps/agor-ui/src/components/EffortSelector/EffortSelector.tsx:32-58`,
   `apps/agor-ui/src/components/EffortSelector/EffortSelector.tsx:63-77`). Thus
   the UI offers `high` for every OpenCode model.
4. The standalone form field is folded into `model_config` and sent on session
   creation (`apps/agor-ui/src/components/AgenticToolConfigForm/agenticConfigHelpers.ts:38-47`,
   `apps/agor-ui/src/hooks/useSessionActions.ts:85-101`). MCP behaves similarly:
   its common schema accepts any of the five efforts and `coerceModelConfig`
   passes the object through (`apps/agor-daemon/src/mcp/tools/sessions.ts:59-135`).
5. Session creation only performs special model validation for Codex. OpenCode
   is checked for a complete exact provider/model pair, not whether that pair
   exposes the requested effort
   (`apps/agor-daemon/src/services/sessions.ts:279-286`,
   `packages/agentic-tool-opencode/src/shared/model-configuration.ts:19-31`).
6. The executor forwards the persisted provider, model, and effort unchanged
   (`packages/executor/src/handlers/sdk/opencode.ts:147-159`).
7. After starting OpenCode, `OpenCodeTool` calls
   `assertExplicitModelAvailable` **before** resolving/creating an OpenCode
   session (`packages/agentic-tool-opencode/src/runtime/opencode-tool.ts:743-758`).
   The check finds the exact provider/model in live OpenCode discovery and, when
   effort is set, requires `selectedModel.variants` to contain that exact key
   (`packages/agentic-tool-opencode/src/runtime/opencode-tool.ts:867-915`). The
   reported string is thrown at lines 910-913. If admitted, the same value is
   sent as OpenCode's `variant` at lines 1020-1032.

The validator deliberately checks both candidate map keys and each model's
reported `id` (`packages/agentic-tool-opencode/src/runtime/opencode-tool.ts:886-891`).
The repro is consequently neither an exact-mode/alias mismatch nor a missing
provider/model pair. It is the requested variant key that is absent.

## Root cause

### Contract mismatch

Agor exposes effort as a tool-global five-value control, while the pinned
OpenCode runtime exposes reasoning as a provider/model-specific `variants` map
and Agor correctly enforces that live map at execution time. Neither the
server-free catalog nor live catalog projection carries variant names:

- `OpenCodeCatalogModel` only has `id`, `name`, and `status`
  (`packages/core/src/types/opencode-models.ts:8-12`).
- The known-model helper constructs only those fields
  (`packages/agentic-tool-opencode/src/shared/known-models.ts:14-19`).
- Live discovery also projects models down to `id`, `name`, and `status`,
  discarding `variants` (`packages/agentic-tool-opencode/src/runtime/auth-handler.ts:177-270`,
  especially lines 228-235).
- The model selector only selects provider/model and has no model-effort
  contract (`packages/agentic-tool-opencode/src/ui/useOpenCodeModelCatalog.ts:23-26`,
  `packages/agentic-tool-opencode/src/ui/OpenCodeModelSelector.tsx:45-96`).
- `agor_models_list` returns an empty model list for OpenCode and tells MCP
  callers to use a provider catalog that the MCP response does not expose
  (`apps/agor-daemon/src/mcp/tools/sessions.ts:1682-1701`,
  `apps/agor-daemon/src/mcp/tools/sessions.ts:1759-1763`).

The UI and MCP can therefore persist a combination that looks supported from
Agor's public capability metadata but is rejected by Agor's more accurate live
runtime check. The roughly one-minute delay is runtime startup/discovery, not
reasoning or tool use.

### Why `qwen3.8-flash + high` is rejected

Agor pins both the OpenCode SDK/package and managed CLI to `1.14.33`
(`packages/agentic-tool-opencode/src/shared/known-models.ts:7`,
`packages/agentic-tool-opencode/package.json:53-56`,
`packages/agentic-tool-opencode/src/runtime/binary.ts:61-99`). In that OpenCode
release, the provider transform returns no variants for model IDs containing
`qwen`; it also lacks the newer model-catalog schema needed to consume
`reasoning_options`. See the exact upstream implementation in
[OpenCode 1.14.33's variant transform](https://github.com/anomalyco/opencode/blob/v1.14.33/packages/opencode/src/provider/transform.ts#L427-L457)
and [provider model conversion](https://github.com/anomalyco/opencode/blob/v1.14.33/packages/opencode/src/provider/provider.ts#L989-L1037),
together with that release's [accepted model-catalog schema](https://github.com/anomalyco/opencode/blob/v1.14.33/packages/opencode/src/provider/models.ts#L27-L78).
The live `qwen3.8-flash` model therefore has no `variants.high` key (in fact, no
native variants at all) and the exact runtime check rejects it. The
[models.dev catalog](https://models.dev/api.json) observed on 2026-08-30
described low/medium/xhigh reasoning choices for this model, but the pinned
runtime cannot use that newer metadata; moreover, `high` is not one of those
declared choices, so silently mapping or forcing it would still be wrong.

### OpenCode Go model inventory

Current main does not curate `opencode-go`, so a credential-backed provider is
shown with zero known models
(`packages/agentic-tool-opencode/src/shared/known-models.ts:127-135`). PR #2605
proposes 25 active models. Applying OpenCode `1.14.33`'s provider conversion to
the `opencode-go` metadata observed for those exact entries on 2026-08-30 gives
the following Agor-selectable variant keys (excluding OpenCode-only names such
as `none` or `minimal`):

| Agor effort keys exposed by pinned runtime | Proposed #2605 models                                                                                                                                                                                               | Count |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----: |
| `low, medium, high, xhigh`                 | `gpt-5.6-luna`, `muse-spark-1.2-contributor`                                                                                                                                                                        |     2 |
| `low, medium, high, max`                   | `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp`, `deepseek-v4-pro`                                                                                                                                              |     3 |
| `low, medium, high`                        | `hy3`, `hy4-preview`, `longcat-2.0`, `mimo-v2.5`, `mimo-v2.5-pro`                                                                                                                                                   |     5 |
| none                                       | `glm-5.1`, `glm-5.2`, `glm-5.3`, `glm-5.3-flash`, `grok-4.6`, `kimi-k2.6`, `kimi-k2.7-code`, `kimi-k3`, `minimax-m2.7`, `minimax-m3`, `qwen3.6-plus`, `qwen3.7-max`, `qwen3.7-plus`, `qwen3.8-flash`, `qwen3.8-max` |    15 |

Thus 15 of the 25 proposed models reject **every** explicit Agor effort under
the pinned runtime; only 10 expose any compatible key. This substantiates the
report that the problem affects “most” OpenCode Go models. The catalog's lack
of model-level effort metadata is the Agor product bug; the empty native variant
sets are also a limitation/behavior of the pinned upstream runtime.

## Relationship to PR #2605

The related worktree is at commit `b3f95e956` (`feat(opencode): add OpenCode Go
provider and surface runtime-unavailable errors`), based on older main
`66ed08618`; the reviewed local diff is 12 files, +243/-8. It:

- adds `opencode-go` to the curated known-provider catalog with the 25 models
  enumerated above and suggested model `gpt-5.6-luna`;
- propagates an environment marker used by credential/provider discovery; and
- makes OpenCode binary/runtime-unavailable failures visible in provider
  settings, with tests for those behaviors.

It does **not** change `OpenCodeCatalogModel`, retain live `variants`, change
the global `reasoningEffortLevels`, make `EffortSelector` model-aware, change
the MCP model/effort contract, or alter `assertExplicitModelAvailable`. Its
new models still contain only `id`/`name`/`status`, and its tests do not cover
effort. There is no separate plan/design document in that commit.

Therefore #2605 is adjacent but does not fix this bug. It makes the affected
models selectable and thereby exposes the pre-existing mismatch more often.
The mismatch predates that PR (the current validator and global effort
capability were introduced independently). Relevant drift from #2605's base to
current main includes newer agentic-integration/config-home capability plumbing,
but no change that resolves OpenCode effort behavior. The implementation should
either extend #2605 before merge or land immediately after it from a current-main
rebase; duplicating its 25-model catalog addition on this planning branch would
be wrong.

## Recommended fix

Keep runtime validation strict, but make the selectable effort values
model-aware and expose the same safe metadata to UI and MCP callers. This is the
smallest correct Agor-style fix because it prevents known-invalid choices while
retaining the live, branch-aware check as the final authority.

1. **Add a model-level safe effort read model.** Extend
   `OpenCodeCatalogModel` with an optional field such as
   `reasoningEffortLevels?: EffortLevel[]`. Preserve the semantic distinction
   between “unknown/not discovered” and “known to have no Agor-compatible
   variants”; an explicit empty array must not be collapsed into missing data.
   Store only variant key names intersected with the shared `EffortLevel` enum,
   never OpenCode's variant option bodies.
2. **Populate the curated OpenCode Go models alongside #2605.** Add the exact
   pinned-runtime values in the table above to #2605's 25 entries. Centralize a
   pure filtering/helper function so known-catalog tests, live projection, MCP,
   and runtime diagnostics use the same set of Agor-recognized keys. Record the
   OpenCode version used to derive the static data; the catalog already exposes
   `runtimeVersion`.
3. **Retain safe live variant names during authenticated discovery.** Extend the
   existing owner/tenant/branch-scoped discovery projection in
   `runtime/auth-handler.ts` to include filtered variant names. Live discovery
   should override static advice when available because project configuration
   may add, remove, or alter variants. Continue to discard all variant option
   bodies and provider configuration so the endpoint remains a safe read model.
4. **Make effort selection follow the selected exact model.** Have the package-
   owned OpenCode selector/integration provide the selected model's effective
   effort list to `AgenticToolConfigForm`, rather than always using the tool-wide
   five-value list. For a known empty list, show only inherited/unset (with copy
   that this model has no explicit effort in the configured runtime). For
   unknown metadata, preserve an explicit “validated at runtime” state rather
   than falsely treating it as unsupported. When the user changes provider or
   model, clear an incompatible stale effort or surface immediate form
   validation before saving; do not silently persist it.
5. **Expose the same discovery to MCP.** Make `agor_models_list` return OpenCode
   provider/model entries with `reasoningEffortLevels`, or add a narrowly scoped
   read-only OpenCode catalog tool if changing the generic shape would be
   incompatible. Document that an empty list means omit `modelConfig.effort`,
   missing metadata is runtime-validated, and live branch configuration remains
   authoritative. Keep the common five-value input enum; validity depends on
   the exact pair. Also correct its “default: high” description for OpenCode:
   unset means inherit the runtime/model default, not force `high`.
6. **Improve, but do not weaken, the final runtime diagnostic.** Continue to
   reject before prompt submission when live `selectedModel.variants` lacks the
   requested key. Include the requested value and filtered supported values in
   the error; if there are none, explicitly say to leave effort unset. Never
   include variant payloads or provider configuration in the error.

Do not add a static hard rejection to generic session creation. The live model
map is owner-, provider-, and branch-dependent; manual exact pairs and branch
variant overrides can legitimately differ from the server-free catalog. Static
metadata should prevent bad choices and improve guidance, while the existing
pre-prompt runtime validation remains the authoritative fail-closed boundary.

## Alternatives considered

| Alternative                                               | Why reject it                                                                                                                                                                                |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Silently ignore/strip an unsupported effort               | The persisted session would claim a setting the runtime did not apply, making runs irreproducible and hiding user error.                                                                     |
| Map `high` to another variant                             | OpenCode exposes named native variants, not an ordered compatibility contract. `qwen3.8-flash`'s newer declared values do not even include `high`; there is no defensible universal mapping. |
| Add only the 25 model names from #2605                    | That is exactly what #2605 does; names/status alone cannot drive effort availability.                                                                                                        |
| Globally remove effort for OpenCode                       | Ten of the 25 proposed OpenCode Go models expose useful supported effort keys, and other providers/models also support variants.                                                             |
| Send the unknown variant and let upstream decide          | It lies in UI/state and removes Agor's useful fail-fast guarantee; pinned OpenCode's variant contract is the live source of truth.                                                           |
| Hard-reject from the static catalog during session create | It would reject valid manual or branch-overridden configurations and cannot reflect owner-specific live provider state.                                                                      |
| Upgrade OpenCode as the sole fix                          | An upgrade is a broader SDK/binary/catalog change and does not remove per-model differences. Even newer metadata does not make `high` valid for every model. It can be evaluated separately. |

## Test plan

### Catalog and filtering

- Extend `known-models.test.ts` to assert all 25 #2605 models and their explicit
  effort metadata, including `qwen3.8-flash: []`, positive GPT/DeepSeek cases,
  and unchanged credential-gated visibility.
- Unit-test the shared filter: accept only `low|medium|high|xhigh|max`, discard
  `none`, `minimal`, arbitrary names, and option values; distinguish unknown
  metadata from a known empty list.
- Pin expectations to OpenCode `1.14.33` so a runtime upgrade forces deliberate
  review rather than silently making the UI stale.

### Live discovery and security

- Extend `auth-handler.integration.test.ts` so discovered models contain safe
  variant key names only, branch-added/removed variants are reflected, and
  variant option bodies/secrets are never returned.
- Preserve current credential gating and authenticated subject resolution.
  Because this is tenant/user/branch-owned discovery, add proportional negative
  coverage proving one user/tenant cannot inspect another owner's provider or
  variant metadata.

### UI

- Replace the current OpenCode form expectation that always exposes all five
  levels with model-specific tests.
- Cover a supported model, a known-empty model, unknown/manual exact metadata,
  inherited/unset behavior, and switching from a supported model with a saved
  effort to an incompatible model.
- Verify Codex and other tool behavior remains unchanged.
- Verify a collaborator who cannot read the session owner's private provider
  catalog does not accidentally substitute the collaborator's own catalog for
  the stored exact pair; leave final validation to the owner-scoped runtime.

### MCP and service behavior

- Add MCP tests for OpenCode provider/model/effort discovery and for accurate
  unset/inherited guidance.
- Verify create/spawn/prompt preserve an omitted effort, while the shared input
  schema still accepts all five values for pairs that support them.
- Do not add false static rejection for manual exact or branch-overridden pairs.

### Runtime

- Extend `opencode-tool.test.ts` with: `qwen3.8-flash + high` rejected before
  session creation; the same pair unset admitted; a supported exact variant
  admitted and sent; and a branch-provided supported variant admitted.
- Assert the revised error lists only filtered safe keys and never serializes
  variant payloads or provider configuration.
- Manually repeat the concrete repro: the UI/MCP discovery must prevent or warn
  about `qwen3.8-flash + high`; unset must reach OpenCode prompt submission; a
  listed supported pair must still pass.
- Run scoped core/OpenCode package, daemon MCP, and UI tests plus typecheck/lint.
  Do not start dev servers or run a workspace build for this change.

## Risks and open questions

- **Catalog drift:** OpenCode `1.14.33` can consume a refreshed external model
  catalog while Agor's curated metadata is static. Decide whether static values
  are generated at release time or maintained manually, and make the pin/drift
  visible in tests. Live discovery must remain authoritative.
- **Known empty versus unknown:** This distinction controls whether UI disables
  effort or allows a runtime-validated advanced choice. It needs an explicit
  type/API contract, not truthiness.
- **Branch overrides:** Server-free metadata cannot see project variants. The
  UI should prefer authenticated branch discovery when available and degrade to
  advisory static metadata without introducing a static daemon rejection.
- **Existing invalid sessions:** Opening an already stored incompatible effort
  should show a warning and an unset path. Do not mutate persisted configuration
  merely by rendering the form.
- **Private owner catalogs:** Session collaborators may not be entitled to the
  owner's provider details. Reuse existing authenticated subject/tenant
  boundaries and do not expose credentials or variant bodies.
- **Runtime upgrade:** Newer OpenCode releases may understand
  `reasoning_options`, changing the 15/25 count and valid values. Treat upgrading
  the exact CLI/SDK pair as separate, reviewed work with regenerated metadata.
- **#2605 sequencing:** Coordinate the model metadata with the older-base PR so
  its catalog addition is not duplicated or lost during rebase onto current
  main.

## Implementation boundaries

- No deployment or modification of the original failing session.
- No automatic effort mapping, silent fallback, or change to the shared five
  `EffortLevel` values.
- No OpenCode CLI/SDK upgrade or adoption of newer model-catalog semantics.
- No change to OpenCode Go credentials, billing, rate limits, or unrelated
  runtime-unavailable error handling from #2605.
- No retroactive mutation of stored sessions or branch configuration.
