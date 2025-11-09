# Text Display Patterns

**Status:** ✅ Implemented (Nov 2025)
**Related:** [[conversation-ui]], [[tool-blocks]]

---

## Overview

Long-form text (logs, bash output, assistant replies) stays readable via shared components:

- `CollapsibleText` / `CollapsibleMarkdown` – truncates after N lines with "show more" controls.
- `CollapsibleAnsiText` + `AnsiText` – renders colored terminal output using `ansi-to-react`.
- `TEXT_TRUNCATION` token centralizes limits so UX stays consistent.

## Implementation

- Components live under `apps/agor-ui/src/components/CollapsibleText/`.
- `MessageBlock`, `ToolUseRenderer`, `ThinkingBlock`, and `AgentChain` reuse them.
- ANSI rendering is also used in `EnvironmentLogsModal` for logs.

## Usage

Import the appropriate variant and wrap long content:

```tsx
import { CollapsibleText } from '../CollapsibleText';

<CollapsibleText maxLines={12} preserveWhitespace code>
  {stdout}
</CollapsibleText>
```

Use `CollapsibleMarkdown` when you already have parsed markdown blocks.

_Source exploration archived at `context/archives/text-display-improvements.md`._
