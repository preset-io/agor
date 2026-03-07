# Design Review: Permission & Model Configuration

**Reviewer**: Claude Code Agent
**Date**: 2026-03-07
**Specs Reviewed**:
- `specs/worktree-permission-config.md` (Worktree-level default agentic config)
- `specs/zone-model-config.md` (Zone trigger model configuration)

---

## Executive Summary

**Overall Assessment**: **REVISE - Important Issues to Address**

Both specifications propose valuable features with solid investigation and clear use cases. However, they introduce **overlapping configuration hierarchies without a unified design**, creating potential confusion and inconsistency. Additionally, critical interactions between the two features are not addressed.

**Key Concerns**:
1. No unified inheritance hierarchy across worktree defaults and zone triggers
2. Missing product reasoning (WHY these features are needed)
3. Security implications of worktree-level permission defaults not fully addressed
4. Incomplete interaction model between the two features
5. Agent UX concerns for complex MCP parameters

**Recommendation**: Revise both specs with a **unified configuration model** that clearly defines precedence, security boundaries, and cross-feature interactions.

---

## Strengths of the Design

### Worktree Permission Config (Spec 1)

✅ **Thorough Investigation**: Excellent analysis of current behavior, clearly documenting the gap
✅ **Multiple Options**: Presents Option 1 (full config) vs Option 2 (simple mode) with trade-offs
✅ **Backward Compatibility**: Non-breaking changes using JSON blob storage
✅ **Testing Checklist**: Comprehensive test scenarios covering all agent types
✅ **Clear Use Cases**: Automation worktree and experimentation worktree examples are compelling

### Zone Model Config (Spec 2)

✅ **Focused Scope**: Wisely excludes permission modes (security boundary)
✅ **Simple Schema**: Minimal changes to existing `ZoneTrigger` interface
✅ **Clear Examples**: Research zone (Opus) and Implementation zone (Sonnet) demonstrate value
✅ **Safe Defaults**: Zone config is a default, not a restriction - users can override
✅ **Key Decisions Table**: Excellent documentation of design decisions

---

## Issues Found

### Critical Issues

#### 1. **No Unified Configuration Hierarchy** ⚠️ CRITICAL

**Problem**: The two specs propose overlapping inheritance hierarchies without coordination:

**Spec 1 Proposes**:
```
Explicit override → Worktree default → User default → SDK default
```

**Spec 2 Proposes**:
```
Zone trigger → Most recent session → User defaults
```

**But what if BOTH exist?** If a worktree has `default_agentic_config.modelConfig` AND a zone has `trigger.modelConfig`, which wins?

**Impact**: Unpredictable behavior, user confusion, potential bugs

**Recommendation**: Define a **single, unified hierarchy** for all config sources:

```
Proposed Unified Hierarchy (by field):

Permission Mode:
  1. Explicit override (spawn/fork with permissionMode param)
  2. Worktree default (worktree.default_agentic_config[tool].permissionMode)
  3. User default (user.default_agentic_config[tool].permissionMode)
  4. SDK default

Model Config:
  1. Explicit override (not currently supported)
  2. Zone trigger (zone.trigger.modelConfig) ← NEW, zone-specific
  3. Worktree default (worktree.default_agentic_config[tool].modelConfig)
  4. Most recent session in worktree (current behavior)
  5. User default (user.default_agentic_config[tool].modelConfig)
  6. SDK default

MCP Servers:
  1. Worktree default (worktree.default_agentic_config[tool].mcpServerIds)
  2. User default (user.default_agentic_config[tool].mcpServerIds)
  3. Empty array
```

**Why different hierarchies?**
- **Permission modes**: Security control - worktree-wide makes sense
- **Model config**: Zone-specific optimization makes sense (Research zone uses Opus, Implementation uses Sonnet)
- **MCP servers**: Worktree context makes sense (specific tools for specific work)

**Which spec zone**: Revisit **BOTH specs** with unified hierarchy documented

---

#### 2. **Missing Product Reasoning** ⚠️ CRITICAL

**Problem**: Neither spec includes a "Product Reasoning" section explaining:
- What user pain points are being solved?
- What workflows are being enabled?
- Why is this worth the added complexity?

**Current Evidence**:
- Spec 1 has use cases (automation worktree, safe experimentation)
- Spec 2 has examples (research zone, implementation zone)
- But neither explains the **underlying user need**

**Questions Unanswered**:
1. Are users actually asking for this?
2. What workflows are currently painful without this?
3. How many users would benefit?
4. What's the alternative (workarounds)?

**Impact**: Risk of building features that add complexity without proportional value

**Recommendation**: Add a "Product Reasoning" section to BOTH specs:
- User stories (As a X, I want Y, so that Z)
- Current pain points
- Proposed workflow improvements
- Success metrics

**Which spec zone**: Add **new section** to both specs before "Current State"

---

#### 3. **Security Boundary Confusion** ⚠️ CRITICAL

**Problem**: Spec 1 proposes worktree-level permission defaults, but the security model is unclear.

**From the spec**:
> "Should worktree RBAC permissions affect who can set default_agentic_config?"
> "Proposed: Only worktree owners can modify"

**But**:
1. How is "owner" enforced? (Not specified in implementation)
2. What if a malicious owner sets `bypassPermissions` on a shared worktree?
3. How do users discover that their sessions are using worktree defaults vs their own preferences?
4. Should there be user-level overrides ("never use worktree defaults")?

**Existing Code Evidence** (from `apps/agor-daemon/src/mcp/routes.ts:1456-1457`):
```typescript
// Determine permission mode from user defaults only
// MCP tools should not override user preferences - they're too complex for agents to manage
```

This comment suggests a design philosophy that **user preferences should be sacred**. Worktree defaults would violate this.

**Impact**:
- Security risk: Worktree owners can bypass user's permission preferences
- UX confusion: Users don't know why their sessions have unexpected permissions
- Audit trail gaps: Hard to trace why a session has specific permissions

**Recommendation**:
1. Add **explicit user consent** for worktree defaults override
2. Add **UI indicators** showing "This session is using worktree defaults"
3. Add **audit logging** for permission mode inheritance decisions
4. Consider **user-level opt-out**: "Never use worktree permission defaults"

**Alternative Design**: Only allow worktree defaults for **non-security fields** (model config, MCP servers) but keep permission modes strictly user-controlled

**Which spec zone**: Revisit **Spec 1 Architecture** section

---

#### 4. **Type Reuse Missing** ⚠️ IMPORTANT

**Problem**: Spec 2 defines `modelConfig` inline but doesn't reference existing types.

**From Spec 2**:
```typescript
modelConfig?: {
  mode?: 'alias' | 'exact';
  model?: string;
  thinkingMode?: 'auto' | 'manual' | 'off';
  manualThinkingTokens?: number;
  provider?: string;
}
```

**But** `packages/core/src/types/user.ts` already defines:
```typescript
export interface DefaultModelConfig {
  mode?: 'alias' | 'exact';
  model?: string;
  thinkingMode?: 'auto' | 'manual' | 'off';
  manualThinkingTokens?: number;
}
```

**Missing**: `provider` field (not in existing type)

**Issues**:
1. Type duplication violates DRY principle
2. `provider` field is new - is it needed? What values are valid?
3. Should zone triggers use `DefaultModelConfig` or a subset?

**Impact**: Type drift, maintenance burden, potential bugs

**Recommendation**:
1. **Reuse** `DefaultModelConfig` from `@agor/core/types`
2. **Document** why `provider` is excluded (or add it to base type if needed)
3. **Update** Spec 2 to import and reference existing types

**Which spec zone**: Revisit **Spec 2 Section 1** (Schema)

---

### Important Issues

#### 5. **Fork/Spawn Inheritance Ambiguity** ⚠️ IMPORTANT

**Problem**: Spec 1 states conflicting inheritance rules:

**Line 304-305**:
> "Apply to model config inheritance, MCP server selection, Codex sandbox/approval settings"

**Line 434-436**:
> "Should worktree defaults apply to forked/spawned sessions?"
> "Current behavior: Fork/spawn inherits from parent session"
> "Proposed: Keep current behavior (parent takes precedence over worktree)"

**Conflict**: If fork/spawn inherits from parent, then worktree defaults are **bypassed** for most sessions (since most sessions are spawned from root sessions).

**Scenario**:
1. Worktree has `default_agentic_config.permissionMode = 'bypassPermissions'`
2. User creates initial session (gets bypass mode from worktree)
3. User spawns child session (inherits from parent = bypass mode)
4. User changes worktree config to `permissionMode = 'default'`
5. Spawned sessions still have bypass mode (stale inheritance)

**Impact**:
- Worktree defaults only apply to **root sessions** (limited usefulness)
- Confusing mental model (why doesn't spawn respect updated worktree config?)

**Recommendation**:
1. **Clarify** that worktree defaults only apply to new root sessions
2. **Add** UI indicator showing inheritance source ("From parent session" vs "From worktree defaults")
3. **Consider** alternative: Worktree defaults override for ALL sessions (more powerful but riskier)

**Which spec zone**: Revisit **Spec 1 "Permission Inheritance Hierarchy"** and **Open Questions**

---

#### 6. **MCP Tool Parameter Complexity** ⚠️ IMPORTANT

**Problem**: Both specs add complex nested parameters to MCP tools.

**Spec 1** (`agor_worktrees_create`):
```typescript
defaultAgenticConfig: {
  type: 'object',
  additionalProperties: true,
  description: 'Default agent configuration for sessions created in this worktree (permissions, model, MCP servers)',
}
```

**Spec 2** (`agor_boards_update` zone trigger):
```typescript
trigger?: {
  behavior: "always_new"|"show_picker",
  agent?: "claude-code"|"codex"|"gemini"|"opencode",
  modelConfig?: {
    mode?: "alias"|"exact",
    model?: string,
    thinkingMode?: "auto"|"manual"|"off",
    manualThinkingTokens?: number,
    provider?: string
  }
}
```

**Existing Philosophy** (from `routes.ts:1456-1457`):
> "MCP tools should not override user preferences - they're too complex for agents to manage"

**Concerns**:
1. Can agents construct valid `defaultAgenticConfig` objects?
2. What happens if agents pass malformed config?
3. Do agents understand permission modes well enough to set them?
4. Schema validation is loose (`additionalProperties: true`)

**Impact**:
- Agent errors and confusion
- Invalid configurations persisted to database
- Debugging difficulty

**Recommendation**:
1. **Add** schema validation with `additionalProperties: false`
2. **Document** each field with examples in MCP tool description
3. **Consider** separate MCP tools for simple cases:
   - `agor_worktrees_set_permission_mode` (simple)
   - `agor_worktrees_set_model_config` (simple)
   - `agor_worktrees_update` (complex, for advanced use)
4. **Test** with actual agent interactions before shipping

**Which spec zone**: Add **new section** "MCP Tool UX" to Spec 1

---

#### 7. **UI Implementation Gaps** ⚠️ IMPORTANT

**Problem**: Both specs mention UI changes but provide minimal detail.

**Spec 1**:
> "Update UI to show/edit worktree defaults"

**Spec 2**:
> "Show zone model indicator (optional)"
> "Update zone editor (ZoneConfigModal.tsx, optional)"

**Questions**:
1. Where in the UI are worktree defaults configured? (Worktree settings panel?)
2. How do users discover this feature exists?
3. How are zone model configs edited? (Inline? Modal?)
4. What visual indicators show config inheritance? (Badges? Tooltips?)

**Current UI Evidence**:
- `ZoneTriggerModal.tsx` already has complex config pre-population logic (lines 140-150)
- Adding zone trigger config requires careful integration

**Impact**:
- Implementation blockers
- Poor UX if not thoughtfully designed
- Potential for confusing UI states

**Recommendation**:
1. **Add** wireframes or UI mockups to both specs
2. **Specify** exact UI locations for configuration
3. **Design** visual indicators for inheritance source
4. **Plan** progressive disclosure (don't overwhelm users)

**Which spec zone**: Add **new section** "UI Design" to both specs

---

### Minor Issues

#### 8. **Migration Documentation** ⚠️ MINOR

**Problem**: Spec 1 states "No schema change needed (already in JSON blob)" but this is incomplete.

**Reality**:
1. Schema doesn't change (true)
2. TypeScript types DO change (need update to `Worktree` interface)
3. Repository serialization/deserialization needs update
4. Database indexes might benefit from materialized columns (performance)

**Impact**: Implementation confusion, missing steps

**Recommendation**:
1. **Document** TypeScript type updates explicitly
2. **Consider** adding materialized column `has_default_config` for filtering
3. **Update** migration notes with full checklist

**Which spec zone**: Revisit **Spec 1 "Add Migration"** section

---

#### 9. **Error Handling Missing** ⚠️ MINOR

**Problem**: Neither spec addresses error handling.

**Scenarios**:
1. Invalid model name in zone trigger (e.g., `model: "opus-99"`)
2. Invalid permission mode in worktree config (e.g., `permissionMode: "invalid"`)
3. MCP server ID references non-existent server
4. Agent passes malformed JSON to MCP tool

**Impact**: Runtime errors, poor UX, debugging difficulty

**Recommendation**:
1. **Add** validation at MCP tool layer (before persisting)
2. **Add** validation at session creation (with fallback to defaults)
3. **Document** error messages for common failures
4. **Add** test cases for error scenarios

**Which spec zone**: Add **new section** "Error Handling" to both specs

---

#### 10. **Naming Consistency** ⚠️ MINOR

**Problem**: Inconsistent naming conventions across specs.

**Spec 1**:
- `default_agentic_config` (snake_case, matches DB schema)

**Spec 2**:
- `modelConfig` (camelCase, matches TypeScript)

**Existing Codebase**:
- DB schema uses snake_case (`permission_mode`, `model_config`)
- TypeScript uses camelCase (`permissionMode`, `modelConfig`)
- JSON blobs use snake_case (`custom_context`, `schedule_cron`)

**Impact**: Confusion about which convention to use

**Recommendation**:
1. **Use snake_case** for JSON blob fields (matches existing `custom_context`, `schedule`)
2. **Use camelCase** for TypeScript interfaces (matches existing types)
3. **Document** naming convention explicitly in both specs

**Which spec zone**: Update **Spec 2 Section 1** to use `model_config`

---

## Codebase Alignment Review

### ✅ Good Alignment

1. **JSON Blob Storage**: Both specs use `data` JSON blobs, matching existing patterns (`custom_context`, `schedule`)
2. **MCP Tool Patterns**: Follow existing `agor_worktrees_update` and `agor_boards_update` patterns
3. **Type Structure**: Spec 1's `DefaultAgenticConfig` matches existing `user.default_agentic_config` structure
4. **Backward Compatibility**: Both specs are non-breaking (optional fields)

### ⚠️ Potential Misalignment

1. **Permission Philosophy**: Spec 1 contradicts existing comment "MCP tools should not override user preferences"
2. **UI Complexity**: ZoneTriggerModal is already complex (150+ lines); adding zone trigger config requires careful integration
3. **Inheritance Patterns**: Current codebase has simple user → SDK default hierarchy; these specs add 2-3 more layers

---

## Extensibility Analysis

**Good**:
- JSON blob storage allows future fields without migrations
- Optional fields allow gradual adoption
- Clear upgrade path from simple to complex configurations

**Concerns**:
- What happens when we add **board-level** defaults? (Another layer in hierarchy?)
- What about **repo-level** defaults? (Env config already exists, should agent config too?)
- How do we deprecate fields later if design changes?

**Recommendation**:
1. **Document** future extensibility plans
2. **Reserve** namespace in JSON blobs (e.g., `agentic_config.v2` for breaking changes)
3. **Plan** for hierarchy complexity limits (don't exceed 5 layers)

---

## Complexity Assessment

**Is this the simplest approach that could work?**

**Spec 1 (Worktree Defaults)**:
- **Option 1** (full config): More complex but more powerful
- **Option 2** (simple mode): Simpler but less flexible
- **Verdict**: Option 2 might be sufficient for MVP, Option 1 for future

**Spec 2 (Zone Model Config)**:
- **Design**: Minimal, focused on model config only
- **Verdict**: ✅ Appropriately simple

**Combined Complexity**:
- **Before**: User defaults → SDK defaults (2 layers)
- **After**: Zone trigger → Worktree defaults → User defaults → SDK defaults (4+ layers)
- **Verdict**: ⚠️ Significant complexity increase - justify with user research

---

## Missing Pieces

1. **Product Reasoning**: No explanation of user pain points or workflows
2. **User Research**: No evidence of user demand for these features
3. **UI Design**: No wireframes, mockups, or detailed UI specs
4. **Agent UX Testing**: No plan to test MCP tools with actual agents
5. **Performance Impact**: No analysis of query performance with additional config layers
6. **Documentation Plan**: No plan for user-facing docs (how do users learn about this?)
7. **Feature Discovery**: How do users discover these features exist?
8. **Metrics**: No success metrics or rollout plan
9. **A/B Testing**: Should we test these features with subset of users first?
10. **Rollback Plan**: What if these features cause confusion or bugs?

---

## Specific Recommendations

### For Spec 1 (Worktree Permission Config)

1. **Add Product Reasoning section** explaining user pain points
2. **Revise security model** with user consent and opt-out mechanisms
3. **Clarify fork/spawn inheritance** with examples and UI indicators
4. **Add UI design section** with wireframes and configuration flows
5. **Simplify MCP tool parameters** or add schema validation
6. **Document unified hierarchy** across all config sources
7. **Consider starting with Option 2** (simple mode) for MVP

### For Spec 2 (Zone Model Config)

1. **Add Product Reasoning section** explaining workflows enabled
2. **Reuse existing types** (`DefaultModelConfig`) instead of inline definitions
3. **Document interaction** with worktree defaults (unified hierarchy)
4. **Add UI design section** for zone configuration editor
5. **Specify validation** for model names (or defer to SDK)
6. **Add visual indicators** showing zone model config in session cards

### For Both Specs

1. **Write unified hierarchy document** covering all config sources
2. **Add error handling section** with validation rules and fallback behavior
3. **Add integration testing plan** covering cross-feature scenarios
4. **Add rollout plan** (feature flag? gradual rollout? beta users?)
5. **Add success metrics** (usage, errors, user feedback)
6. **Add documentation plan** (user guide, tooltips, help text)

---

## Overall Verdict

**REVISE - Important Issues to Address**

Both specifications show solid investigation and clear use cases, but require revision to address:

1. **Critical**: Unified configuration hierarchy across both features
2. **Critical**: Product reasoning justifying the complexity increase
3. **Critical**: Security model for worktree permission defaults
4. **Important**: UI design and implementation details
5. **Important**: MCP tool parameter complexity and agent UX

**Next Steps**:

1. **Combine specs** into single "Configuration Hierarchy" design document
2. **Add product reasoning** with user research and pain points
3. **Design unified hierarchy** with clear precedence rules
4. **Add UI mockups** for all configuration touchpoints
5. **Simplify or validate** MCP tool parameters
6. **Add security controls** for worktree permission defaults
7. **Write integration tests** covering cross-feature scenarios

**Estimated Revision Effort**: 2-3 days

**Implementation Risk After Revision**: Medium (complex feature with security implications, but well-scoped)

---

## Review Checklist Results

| Criteria | Status | Notes |
|----------|--------|-------|
| **Completeness** | ⚠️ Partial | Missing product reasoning, UI design, error handling |
| **Coherence** | ❌ Issues | No unified hierarchy, specs operate independently |
| **Codebase Alignment** | ✅ Good | Follows JSON blob patterns, MCP tool conventions |
| **Abstraction Level** | ✅ Good | Interfaces at appropriate level |
| **API Design** | ⚠️ Needs Work | MCP parameters complex, validation missing |
| **Data Design** | ✅ Good | Types sound, schema sensible, migrations planned |
| **Error Handling** | ❌ Missing | Not addressed in either spec |
| **Extensibility** | ✅ Good | JSON blobs allow future expansion |
| **Complexity** | ⚠️ Concern | 2x increase in hierarchy layers - justify with research |
| **UX Concerns** | ⚠️ Partial | Examples good, but UI details missing |
| **Missing Pieces** | ❌ Many | Product reasoning, UI design, testing, metrics |

---

**Final Recommendation**: **REVISE** both specs with focus on unified hierarchy, product justification, and security model. Consider shipping Spec 2 (zone model config) first as it's simpler and less risky, then iterate on Spec 1 (worktree defaults) with user feedback.
