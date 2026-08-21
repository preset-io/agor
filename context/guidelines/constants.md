# Shared Runtime Identifiers

**A shared runtime identifier or closed family has one domain-owned source of truth. Consumers import that declaration or its type instead of creating parallel declarations.**

Runtime identifiers are strings whose exact value affects behavior or compatibility: event names, service and route names, config and metadata keys, permission or status values, channel prefixes, storage keys, and similar protocol values.

This is the runtime-value companion to the "Centralize types" rule in `AGENTS.md`. A shared TypeScript type is not enough if call sites still reconstruct its string values as independent declarations.

## Decide by meaning, not repetition

A string is a candidate for centralization when changing it would require coordinated changes across consumers or boundaries. Ask:

1. Does the exact value identify behavior, a protocol, or persisted data?
2. Is it consumed in more than one place or across a package, process, API, or storage boundary?
3. Are call sites reconstructing the same value or closed family independently?

If yes, give it a domain-owned declaration. Do not centralize strings merely because their text happens to repeat.

These normally stay inline:

- UI, log, and error copy
- test fixtures and example data
- object property names already governed by a type or schema
- a genuinely local implementation detail
- a single comparison against a properly typed union

```ts
function handle(event: StreamingEventType) {
  if (event === 'streaming:chunk') {
    // Fine: TypeScript verifies this member of the canonical union.
  }
}
```

## Preferred patterns

### One shared value

```ts
// apps/agor-daemon/src/realtime/redis-realtime.ts
export const FEATHERS_RELAY_EVENT = 'agor:feathers-publication:v1';
```

Import the declaration rather than repeating the raw value at consumers.

### A closed family

Declare the runtime values first and derive the type from them:

```ts
// packages/core/src/types/knowledge.ts
export const KNOWLEDGE_VISIBILITIES = ['public', 'private'] as const;

export type KnowledgeVisibility = (typeof KNOWLEDGE_VISIBILITIES)[number];
```

This keeps the runtime list and compile-time union structurally inseparable.

### Families with meaningful subsets

Name meaningful subsets instead of reconstructing them at call sites. When a broader type already owns the family, constrain the subset with `satisfies`:

```ts
// packages/core/src/types/gateway.ts
export type ChannelType =
  'slack' | 'discord' | 'whatsapp' | 'telegram' | 'github' | 'teams' | 'shortcut';

export const DURABLE_GATEWAY_LISTENER_CHANNEL_TYPES = [
  'slack',
  'github',
  'shortcut',
] as const satisfies readonly ChannelType[];
```

## Put ownership where readers expect it

- **One module:** keep a local constant beside the behavior it controls.
- **One package:** export it from the domain module, not a generic constants bucket.
- **Multiple packages:** place the declaration in the owning `packages/core` domain and export it through the existing package surface.
- **Existing schema or registry:** derive from that source instead of creating a parallel declaration.

Avoid generic `constants.ts` dumping grounds. The declaration should live where a reader would look to understand the domain.

## Review and enforcement

This is a semantic design rule, enforced through type-driven APIs and code review. A repository-wide duplicate-string scanner cannot reliably distinguish protocol identifiers from copy, fixtures, and coincidental text; a domain-specific scanner would enforce only one example rather than the project-wide rule.

When reviewing code that introduces or changes a runtime identifier, verify that:

- its owner is clear;
- consumers import rather than reconstruct it;
- closed families derive their types from runtime declarations;
- meaningful subsets are named and constrained or composed; and
- no parallel source of truth was introduced.
