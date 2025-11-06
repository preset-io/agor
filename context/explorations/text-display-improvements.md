# Text Display Improvements

Related: [[tool-blocks]], [[conversation-ui]], [[frontend-guidelines]], [[tool-streaming-and-progress]]

**Status:** Exploration
**Date:** January 2025

---

## Executive Summary

Text content in Agor messages can become overwhelming - long bash output, file reads, and assistant responses can dominate the UI. We already have a **CollapsibleText component** that works well, but it's only used in 2 places. Additionally, **ANSI color codes** from bash/terminal output are displayed as raw escape sequences instead of styled output.

**Key Finding:** We have `ansi-to-react` library installed and working in EnvironmentLogsModal, but tool results don't use it. Extending CollapsibleText to support ANSI and applying it to assistant responses will dramatically improve readability.

---

## Current State Analysis

### 5 Text Content Sources

| Source                   | Component                    | Truncation  | ANSI Support     | Status              |
| ------------------------ | ---------------------------- | ----------- | ---------------- | ------------------- |
| **Assistant Text**       | MessageBlock.tsx:410         | ❌ None     | N/A              | 🔴 Needs truncation |
| **Bash/Tool Output**     | ToolUseRenderer.tsx:110      | ✅ 10 lines | ❌ Raw codes     | 🟡 Needs ANSI       |
| **Extended Thinking**    | ThinkingBlock.tsx:93         | ✅ 10 lines | N/A              | ✅ Working          |
| **Agent Chain Thoughts** | AgentChain.tsx:334           | ❌ None     | N/A              | 🔴 Needs truncation |
| **Environment Logs**     | EnvironmentLogsModal.tsx:141 | N/A         | ✅ ansi-to-react | ✅ Working          |

### Current CollapsibleText Component

**Location:** `apps/agor-ui/src/components/CollapsibleText/CollapsibleText.tsx`

**Features:**

- Uses Ant Design's `Typography.Paragraph` with ellipsis
- Default: 10 lines (configurable via `TEXT_TRUNCATION.DEFAULT_LINES`)
- Props: `maxLines`, `preserveWhitespace`, `code`, `style`, `className`
- Automatic "show more/less" controls

**Usage Pattern:**

```tsx
<CollapsibleText code preserveWhitespace>
  {longToolOutput}
</CollapsibleText>
```

**Currently Used In:**

1. ToolUseRenderer.tsx:110 - Tool result output
2. ThinkingBlock.tsx:93 - Extended thinking blocks

**NOT Used In:**

1. MessageBlock.tsx - Assistant text responses (can be 5000+ lines)
2. AgentChain.tsx - Agent thought text blocks
3. Any component needing ANSI color support

---

## Problems to Solve

### Problem 1: Long Assistant Responses Dominate UI

**Example:** Assistant writes 200-line code explanation with no truncation.

**Impact:** User has to scroll past massive walls of text to see tool outputs.

**Solution:** Apply CollapsibleText to assistant text blocks in MessageBlock.

### Problem 2: ANSI Escape Codes Display as Raw Text

**Example:**

```
\u001b[32m✓\u001b[0m Tests passed
\u001b[31m✗\u001b[0m 3 errors found
```

**Impact:** Terminal output loses color/formatting, harder to read.

**Solution:** Wrap tool output in `<Ansi>` component (from `ansi-to-react`).

### Problem 3: Agent Thoughts Can Be Very Long

**Example:** Agent writes 50-line reasoning about architecture decisions.

**Impact:** Collapsed AgentChain becomes hard to read when expanded.

**Solution:** Apply CollapsibleText to thought text blocks.

---

## Proposed Solutions

### Phase 1: ANSI Color Support in Tool Output

#### 1.1 Create AnsiText Component

**File:** `apps/agor-ui/src/components/AnsiText/AnsiText.tsx` (NEW)

````typescript
import Ansi from 'ansi-to-react';
import React from 'react';

interface AnsiTextProps {
  children: string;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * AnsiText - Renders text with ANSI escape codes as styled output
 *
 * Uses ansi-to-react to convert terminal color codes to HTML/CSS.
 *
 * Usage:
 * ```tsx
 * <AnsiText>{bashOutput}</AnsiText>
 * ```
 */
export const AnsiText: React.FC<AnsiTextProps> = ({
  children,
  className,
  style
}) => {
  return (
    <div className={className} style={style}>
      <Ansi>{children}</Ansi>
    </div>
  );
};
````

#### 1.2 Create CollapsibleAnsiText Component

Combines CollapsibleText with ANSI support:

**File:** `apps/agor-ui/src/components/CollapsibleText/CollapsibleAnsiText.tsx` (NEW)

```typescript
import Ansi from 'ansi-to-react';
import { Typography } from 'antd';
import React from 'react';
import { TEXT_TRUNCATION } from '../../constants/ui';

const { Paragraph } = Typography;

interface CollapsibleAnsiTextProps {
  children: string;
  maxLines?: number;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * CollapsibleAnsiText - Combines CollapsibleText with ANSI color support
 *
 * Perfect for bash output, git logs, test results, etc.
 */
export const CollapsibleAnsiText: React.FC<CollapsibleAnsiTextProps> = ({
  children,
  maxLines = TEXT_TRUNCATION.DEFAULT_LINES,
  className,
  style,
}) => {
  const computedStyle: React.CSSProperties = {
    ...style,
    whiteSpace: 'pre-wrap',
    fontFamily: 'monospace',
  };

  return (
    <Paragraph
      className={className}
      style={computedStyle}
      ellipsis={{
        rows: maxLines,
        expandable: true,
        symbol: 'show more',
      }}
    >
      <Ansi>{children}</Ansi>
    </Paragraph>
  );
};
```

#### 1.3 Detect Tool Types That Need ANSI Support

Create a utility to identify terminal output:

**File:** `apps/agor-ui/src/utils/ansi.ts` (NEW)

```typescript
/**
 * Checks if text contains ANSI escape codes
 */
export function hasAnsiCodes(text: string): boolean {
  // ANSI escape code pattern: ESC [ ... m
  const ansiPattern = /\u001b\[[\d;]*m/;
  return ansiPattern.test(text);
}

/**
 * List of tools that typically output terminal content
 */
export const TERMINAL_OUTPUT_TOOLS = [
  'Bash',
  'bash',
  'sh',
  'npm',
  'git',
  'docker',
  'pytest',
  'jest',
  'cargo',
  'go',
];

/**
 * Checks if tool output should be rendered with ANSI support
 */
export function shouldUseAnsiRendering(toolName: string, output: string): boolean {
  // Check if tool is known to produce terminal output
  const isTerminalTool = TERMINAL_OUTPUT_TOOLS.includes(toolName);

  // OR check if output contains ANSI codes
  const hasAnsi = hasAnsiCodes(output);

  return isTerminalTool || hasAnsi;
}
```

#### 1.4 Update ToolUseRenderer to Use ANSI Support

**File:** `apps/agor-ui/src/components/ToolUseRenderer/ToolUseRenderer.tsx`

```typescript
import { CollapsibleText } from '../CollapsibleText';
import { CollapsibleAnsiText } from '../CollapsibleText/CollapsibleAnsiText';
import { shouldUseAnsiRendering } from '../../utils/ansi';

export const ToolUseRenderer: React.FC<ToolUseRendererProps> = ({ toolUse, toolResult }) => {
  // ... existing code ...

  const resultText = getResultText();
  const hasContent = resultText.trim().length > 0;

  // NEW: Detect if we should use ANSI rendering
  const useAnsi = shouldUseAnsiRendering(toolUse.name, resultText);

  return toolResult ? (
    <div>
      <div
        style={{
          padding: token.sizeUnit,
          borderRadius: token.borderRadius,
          background: isError ? 'rgba(255, 77, 79, 0.05)' : 'rgba(82, 196, 26, 0.05)',
          border: `1px solid ${isError ? token.colorErrorBorder : token.colorSuccessBorder}`,
        }}
      >
        {/* Use CollapsibleAnsiText for terminal output, CollapsibleText otherwise */}
        {useAnsi ? (
          <CollapsibleAnsiText
            style={{
              fontSize: 11,
              margin: 0,
              ...((!hasContent && {
                fontStyle: 'italic',
                color: token.colorTextSecondary,
              }) as React.CSSProperties),
            }}
          >
            {hasContent ? resultText : '(no output)'}
          </CollapsibleAnsiText>
        ) : (
          <CollapsibleText
            code
            preserveWhitespace
            style={{
              fontSize: 11,
              margin: 0,
              ...((!hasContent && {
                fontStyle: 'italic',
                color: token.colorTextSecondary,
              }) as React.CSSProperties),
            }}
          >
            {hasContent ? resultText : '(no output)'}
          </CollapsibleAnsiText>
        )}
      </div>

      {/* ... existing input parameters code ... */}
    </div>
  ) : null;
};
```

---

### Phase 2: Truncate Long Assistant Responses

#### 2.1 Apply CollapsibleText to MessageBlock

**File:** `apps/agor-ui/src/components/MessageBlock/MessageBlock.tsx`

Update text block rendering (around line 410):

```typescript
import { CollapsibleText } from '../CollapsibleText';

// In the text block rendering section:
if (block.type === 'text') {
  // For assistant messages, check if text is long enough to need truncation
  const shouldTruncate = block.text.split('\n').length > 15;

  if (shouldTruncate) {
    return (
      <CollapsibleText
        key={index}
        maxLines={10}
        style={{
          marginBottom: token.sizeUnit,
        }}
      >
        {block.text}
      </CollapsibleText>
    );
  }

  // Short text: render normally with MarkdownRenderer
  return (
    <div key={index} style={{ marginBottom: token.sizeUnit }}>
      <MarkdownRenderer content={block.text} />
    </div>
  );
}
```

**Issue:** MarkdownRenderer handles markdown formatting. CollapsibleText uses plain text.

**Solution:** Enhance CollapsibleText to support markdown OR create CollapsibleMarkdown component.

#### 2.2 Create CollapsibleMarkdown Component

**File:** `apps/agor-ui/src/components/CollapsibleText/CollapsibleMarkdown.tsx` (NEW)

```typescript
import { Typography } from 'antd';
import React, { useState } from 'react';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { TEXT_TRUNCATION } from '../../constants/ui';

const { Paragraph } = Typography;

interface CollapsibleMarkdownProps {
  children: string;
  maxLines?: number;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * CollapsibleMarkdown - Renders markdown with truncation support
 *
 * NOTE: Ant Design's ellipsis doesn't work well with complex HTML from markdown.
 * This implementation uses line counting instead.
 */
export const CollapsibleMarkdown: React.FC<CollapsibleMarkdownProps> = ({
  children,
  maxLines = TEXT_TRUNCATION.DEFAULT_LINES,
  className,
  style,
}) => {
  const [expanded, setExpanded] = useState(false);

  const lines = children.split('\n');
  const shouldTruncate = lines.length > maxLines + 5; // Add threshold

  if (!shouldTruncate) {
    return <MarkdownRenderer content={children} />;
  }

  const displayContent = expanded ? children : lines.slice(0, maxLines).join('\n');

  return (
    <div className={className} style={style}>
      <MarkdownRenderer content={displayContent} />

      {!expanded && (
        <div style={{ marginTop: 8, fontStyle: 'italic', opacity: 0.6 }}>
          ... ({lines.length - maxLines} more lines)
        </div>
      )}

      <div style={{ marginTop: 8 }}>
        <a
          onClick={() => setExpanded(!expanded)}
          style={{ fontSize: 12, cursor: 'pointer' }}
        >
          {expanded ? 'show less' : 'show more'}
        </a>
      </div>
    </div>
  );
};
```

#### 2.3 Use CollapsibleMarkdown in MessageBlock

```typescript
if (block.type === 'text') {
  return (
    <CollapsibleMarkdown
      key={index}
      maxLines={10}
      style={{ marginBottom: token.sizeUnit }}
    >
      {block.text}
    </CollapsibleMarkdown>
  );
}
```

---

### Phase 3: Truncate Agent Thought Text

#### 3.1 Apply CollapsibleMarkdown to AgentChain Thoughts

**File:** `apps/agor-ui/src/components/AgentChain/AgentChain.tsx`

Update thought text rendering (around line 334):

```typescript
import { CollapsibleMarkdown } from '../CollapsibleText/CollapsibleMarkdown';

// In the thought rendering section:
if (item.type === 'thought' && item.block.type === 'text') {
  return (
    <ThoughtChain.Item
      key={`thought-${index}`}
      icon={<BulbOutlined />}
      title="Thought"
      type="thought"
    >
      <CollapsibleMarkdown maxLines={8}>
        {item.block.text}
      </CollapsibleMarkdown>
    </ThoughtChain.Item>
  );
}
```

---

## Implementation Strategy

### Phase 1: ANSI Support (1-2 days)

- [x] ~~Create `AnsiText` component~~ (simple wrapper)
- [ ] Create `CollapsibleAnsiText` component
- [ ] Create `utils/ansi.ts` with detection logic
- [ ] Update `ToolUseRenderer` to use ANSI rendering
- [ ] Test with Bash tool output (colors should appear)
- [ ] Test with git output (colors should appear)

### Phase 2: Assistant Text Truncation (1 day)

- [ ] Create `CollapsibleMarkdown` component
- [ ] Update `MessageBlock` to use `CollapsibleMarkdown`
- [ ] Test with long assistant responses
- [ ] Verify markdown rendering works inside truncated blocks

### Phase 3: Agent Thought Truncation (1 day)

- [ ] Update `AgentChain` to use `CollapsibleMarkdown`
- [ ] Test with long thinking blocks
- [ ] Adjust `maxLines` for optimal UX

---

## Text Type Classification

### Terminal Output (Needs ANSI)

- Bash command output
- Git command output
- npm/pnpm output
- Test runner output (pytest, jest)
- Docker command output
- Build tool output (cargo, go build)

**Detection:** Check for ANSI codes OR known terminal tool names

**Rendering:** `CollapsibleAnsiText`

### File Content (No ANSI)

- Read tool results
- Grep results
- File diffs

**Rendering:** `CollapsibleText` with `code` prop

### Markdown Content (No ANSI)

- Assistant text responses
- Agent thoughts
- Extended thinking

**Rendering:** `CollapsibleMarkdown`

### Structured Data (No Truncation)

- JSON responses (already have custom renderers)
- TodoList (custom renderer)
- File impact graphs (future)

**Rendering:** Custom renderers

---

## Size Formatting Utility

For displaying file/output sizes in tool streaming progress:

**File:** `apps/agor-ui/src/utils/format.ts`

```typescript
/**
 * Formats byte count to human-readable string
 *
 * @example
 * formatBytes(1024) // "1KB"
 * formatBytes(2500000) // "2.4MB"
 * formatBytes(500) // "500B"
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0B';

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  const value = bytes / Math.pow(k, i);
  const formatted = i === 0 ? value : value.toFixed(1);

  return `${formatted}${sizes[i]}`;
}
```

**Usage in tool streaming:**

```typescript
// Show character count as KB
const charCount = tool.inputCharCount || 0;
const displaySize = formatBytes(charCount);

<Text type="secondary">({displaySize})</Text>
```

---

## Testing Plan

### Manual Testing Scenarios

**ANSI Support:**

1. Run bash command: `pnpm test --color=always` (should show colored output)
2. Run git command: `git status` (should show colored file states)
3. Run npm install (should show progress bars styled)

**Assistant Text Truncation:**

1. Ask Claude to "explain React hooks in detail" (expect 100+ line response)
2. Verify "show more" appears after 10 lines
3. Click "show more" - full markdown should render correctly

**Agent Thought Truncation:**

1. Create complex task requiring long reasoning
2. Expand AgentChain
3. Verify thoughts are truncated with "show more"

---

## Edge Cases

### ANSI Detection False Positives

**Issue:** File containing ANSI codes gets rendered with ANSI (could be source code)

**Solution:** Only use ANSI for known terminal tools. For other tools (Read, Grep), skip ANSI even if codes present.

### Markdown Inside Code Blocks

**Issue:** CollapsibleMarkdown might truncate in middle of code fence

**Solution:** Enhanced line-splitting that respects code fence boundaries:

````typescript
function smartTruncate(markdown: string, maxLines: number): string {
  const lines = markdown.split('\n');
  let inCodeFence = false;
  let truncateAt = maxLines;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith('```')) {
      inCodeFence = !inCodeFence;
    }

    // If we're at max lines and inside code fence, extend to end of fence
    if (i >= maxLines && inCodeFence) {
      truncateAt = i + 1;
    } else if (i >= maxLines && !inCodeFence) {
      truncateAt = i;
      break;
    }
  }

  return lines.slice(0, truncateAt).join('\n');
}
````

### Very Long Single Lines

**Issue:** Line-based truncation doesn't help if single line is 10,000 chars

**Solution:** Add character limit fallback:

```typescript
const MAX_CHARS_BEFORE_TRUNCATE = 5000;

if (text.length > MAX_CHARS_BEFORE_TRUNCATE) {
  // Show first N chars with "show more"
}
```

---

## File Checklist

### Files to Create

- [ ] `apps/agor-ui/src/components/AnsiText/AnsiText.tsx`
- [ ] `apps/agor-ui/src/components/CollapsibleText/CollapsibleAnsiText.tsx`
- [ ] `apps/agor-ui/src/components/CollapsibleText/CollapsibleMarkdown.tsx`
- [ ] `apps/agor-ui/src/utils/ansi.ts`
- [ ] `apps/agor-ui/src/utils/format.ts` (for byte formatting)

### Files to Modify

- [ ] `apps/agor-ui/src/components/ToolUseRenderer/ToolUseRenderer.tsx`
- [ ] `apps/agor-ui/src/components/MessageBlock/MessageBlock.tsx`
- [ ] `apps/agor-ui/src/components/AgentChain/AgentChain.tsx`

### Existing Files (Reference)

- ✅ `apps/agor-ui/src/components/CollapsibleText/CollapsibleText.tsx` (already good)
- ✅ `apps/agor-ui/src/components/EnvironmentLogsModal/EnvironmentLogsModal.tsx` (ANSI reference)
- ✅ `apps/agor-ui/src/constants/ui.ts` (TEXT_TRUNCATION constants)

---

## Success Criteria

### User Experience

- ✅ Bash output shows colors (green ✓, red ✗, etc.)
- ✅ Long assistant responses collapse to 10 lines
- ✅ "show more" reveals full content with markdown intact
- ✅ Agent thoughts don't overwhelm expanded AgentChain view

### Performance

- ✅ ANSI rendering doesn't cause lag (ansi-to-react is fast)
- ✅ CollapsibleMarkdown renders within 16ms (60fps)
- ✅ No layout shift when expanding/collapsing

### Developer Experience

- ✅ Easy to apply truncation to new text types
- ✅ Clear separation: CollapsibleText (code), CollapsibleMarkdown (prose), CollapsibleAnsiText (terminal)
- ✅ Configurable via TEXT_TRUNCATION constants

---

## Future Directions

### Syntax Highlighting for Code Blocks

- Use Prism.js or highlight.js for code fence content
- Auto-detect language from file extensions in Read tool

### Copy Button for Collapsible Blocks

- Add "Copy" button next to "show more"
- Copies full text even if collapsed

### Smart Truncation Based on Content Type

- JSON: Truncate by top-level keys (not lines)
- Tables: Keep headers visible, truncate rows
- Lists: Show first N items

### Search Within Collapsed Content

- Add search box that auto-expands when match found
- Highlight search terms

---

**Status:** Ready for Implementation
**Estimated Effort:** 3-4 days (Phases 1-3)
**Priority:** High (significantly improves readability)
**Dependencies:** None (ansi-to-react already installed)
