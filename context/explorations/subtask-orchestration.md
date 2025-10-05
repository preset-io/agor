# Subtask Orchestration & Agent Delegation

Related: [[agent-interface]], [[models]], [[core]], [[native-cli-feature-gaps]]

**Status:** Exploration
**Date:** January 2025

---

## The Challenge

**How do we get agents to spawn Agor-tracked subtasks instead of using their native delegation mechanisms?**

### The Problem

**Native agent delegation:**
```typescript
// Claude Code has a Task tool
Agent: "I'll delegate the database schema to a subtask"
Agent uses Task tool internally
→ Spawns subprocess, completes, returns result
→ Agor has NO visibility into this subprocess
→ Can't fork it, can't view its conversation, can't generate report
```

**What we want:**
```typescript
// Agor-managed subtask
User: "Build auth system with database schema subtask"
Agent: "I'll delegate the schema design"
→ Agent calls `agor session subtask --prompt "Design user table schema"`
→ Agor creates new session with parent_session_id
→ Full observability: view conversation, fork, generate report
→ Can continue prompting child session after completion
```

### Why This Matters

**Observability Benefits:**
- See full conversation in subtask session
- Fork subtask if it goes wrong
- Generate reports for subtasks
- Visual session tree in Agor UI

**Reusability Benefits:**
- Continue prompting child session after parent completes
- Share subtask sessions with team
- Analyze patterns across subtasks

**Native Task Tool Limitations:**
- ❌ No conversation history access
- ❌ Can't fork if subtask makes wrong decision
- ❌ Can't continue prompting after subtask completes
- ❌ No report generation
- ❌ Not visible in Agor session tree

---

## Core Insight: Prompt Engineering + Tool Injection

**Key idea:** Teach agents to use `agor session subtask` CLI instead of their native Task tool.

**Two approaches:**
1. **System-level prompt injection** - Modify agent's system prompt
2. **Per-task prompt wrapping** - Wrap user prompts with instructions

---

## Approach 1: System Prompt Injection

**Concept:** Modify the agent's system prompt to always use Agor for delegation.

### Implementation

```typescript
// When creating Agor-managed session
const systemPrompt = `
You are an AI coding assistant working within the Agor orchestration platform.

IMPORTANT: When you need to delegate work to a subtask or subprocess:
- DO NOT use your native Task tool
- INSTEAD, use the Agor CLI: \`agor session subtask\`

How to create Agor subtasks:
1. Prepare a clear, focused prompt for the subtask
2. Use bash tool to run: agor session subtask --prompt "your prepared prompt"
3. The command will output a session_id when the subtask completes
4. You can reference that session_id in your response to the user

Example:
User: "Build an auth system with database schema"
You: "I'll handle the API endpoints and delegate the schema to a subtask"

Correct approach:
\`\`\`bash
agor session subtask --prompt "Design PostgreSQL schema for user authentication with users, sessions, and roles tables. Include proper indexes and constraints."
\`\`\`

Incorrect approach (don't do this):
Using your native Task tool directly - this bypasses Agor's tracking.

Why Agor subtasks?
- Full conversation observability
- Can be forked if issues arise
- Generates structured reports
- Maintains session tree for user visibility
`;

// Create session with modified system prompt
const session = await agentClient.createSession({
  systemPrompt: systemPrompt,
  initialPrompt: userPrompt
});
```

### Pros & Cons

**Pros:**
✅ Agent automatically uses Agor for all delegations
✅ Works for entire session (don't need per-prompt injection)
✅ Clean separation: agent knows it's in Agor context

**Cons:**
❌ Requires SDK support for custom system prompts
❌ May conflict with agent's built-in system prompt
❌ Agent might ignore instructions and use Task tool anyway
❌ Doesn't work if agent has hardcoded system prompt

**Likelihood by Agent:**
- **Claude Code:** ⚠️ Unknown if SDK allows system prompt override
- **OpenAI/Codex:** ✅ Yes, system message is first message
- **Cursor:** ❌ Likely no control over system prompt
- **Gemini:** ✅ Yes, system instructions supported

---

## Approach 2: Per-Task Prompt Wrapping

**Concept:** Wrap each user prompt with instructions about Agor context.

### Implementation

```typescript
async function executeTaskWithAgorContext(
  userPrompt: string,
  sessionId: string
) {
  // Wrap user prompt with Agor instructions
  const wrappedPrompt = `
[AGOR CONTEXT]
You are working in an Agor-managed session (ID: ${sessionId}).

When delegating subtasks:
- Use: \`agor session subtask --prompt "..."\` (Agor-tracked)
- Avoid: Your native Task tool (not tracked by Agor)

Agor subtasks provide full observability, forking, and report generation.

[USER REQUEST]
${userPrompt}
`;

  return await session.executeTask(wrappedPrompt);
}
```

### Enhanced Version with Examples

```typescript
function wrapPromptWithAgorContext(userPrompt: string, sessionId: string) {
  return `
[AGOR SESSION CONTEXT]
Session ID: ${sessionId}
Platform: Agor Orchestration

DELEGATION GUIDELINES:
When you need to spawn a subtask or delegate work, use Agor's subtask system:

Correct pattern:
\`\`\`bash
# Prepare a focused prompt for the subtask
agor session subtask --prompt "Clear, specific subtask description with context"
\`\`\`

Example scenario:
User asks: "Build auth API with database schema and tests"

Your approach:
1. Main task: Implement auth API endpoints
2. Subtask 1: Database schema design
   \`\`\`bash
   agor session subtask --prompt "Design PostgreSQL schema for authentication: users, sessions, roles tables with proper constraints"
   \`\`\`
3. Subtask 2: Test suite
   \`\`\`bash
   agor session subtask --prompt "Write integration tests for auth endpoints: signup, login, logout, token refresh"
   \`\`\`

Benefits of Agor subtasks:
- Full conversation history visible to user
- Can be forked if approach needs revision
- Generates structured reports automatically
- Appears in user's session tree visualization

---

USER REQUEST:
${userPrompt}
`;
}
```

### Pros & Cons

**Pros:**
✅ Works without SDK system prompt support
✅ Can adjust instructions per task
✅ More explicit (agent sees context every time)
✅ Easy to A/B test different prompting strategies

**Cons:**
❌ Adds tokens to every prompt (higher cost)
❌ Agent might get "instruction fatigue"
❌ More brittle (agent might still ignore)
❌ Verbose for users who see raw prompts

**Likelihood of Success:**
- Higher than system prompt approach
- Agents generally respect in-prompt instructions
- Can be refined based on agent behavior

---

## Approach 3: Tool Replacement / Interception

**Concept:** Replace agent's native Task tool with Agor's subtask command.

### How It Works

**Step 1: Detect when agent wants to use Task tool**
```typescript
execution.onToolCall((tool) => {
  if (tool.name === 'Task' || tool.name === 'delegate') {
    // Agent wants to spawn subtask
    interceptTaskTool(tool);
  }
});
```

**Step 2: Intercept and redirect to Agor**
```typescript
async function interceptTaskTool(toolCall: ToolCall) {
  const subtaskPrompt = toolCall.input.prompt;

  // Create Agor subtask instead
  const childSession = await agor.session.subtask({
    parentSessionId: currentSessionId,
    prompt: subtaskPrompt,
    agent: 'claude-code' // or same as parent
  });

  // Wait for completion
  const result = await childSession.waitForCompletion();

  // Return result to parent agent as if Task tool succeeded
  return {
    toolCallId: toolCall.id,
    output: {
      success: true,
      sessionId: childSession.sessionId,
      result: result.summary
    }
  };
}
```

### Pros & Cons

**Pros:**
✅ Transparent to agent (no prompt engineering needed)
✅ Works even if agent ignores prompt instructions
✅ Can inject additional context into subtask
✅ Full control over subtask execution

**Cons:**
❌ Requires SDK to expose tool interception
❌ Complex to implement (async tool handling)
❌ May break agent's assumptions about Task tool behavior
❌ Hard to debug if interception fails

**SDK Requirements:**
```typescript
interface TaskExecution {
  onToolCall(handler: (tool: ToolCall) => Promise<ToolResult>): void;
  interceptTool(name: string, handler: InterceptHandler): void;
}
```

**Likelihood:**
- **Claude Code:** ⚠️ Maybe - if SDK exposes tool hooks
- **OpenAI:** ❌ No - function calling doesn't allow interception
- **Cursor:** ❌ Unlikely
- **Gemini:** ❌ Unlikely

---

## Approach 4: Hybrid (Prompt + Tool Detection)

**Concept:** Use prompt wrapping + detect when agent uses Task tool anyway, then migrate.

### Implementation

```typescript
class AgorSubtaskOrchestrator {
  async executeTask(prompt: string, sessionId: string) {
    // Wrap prompt (Approach 2)
    const wrappedPrompt = wrapPromptWithAgorContext(prompt, sessionId);

    const execution = await session.executeTask(wrappedPrompt);

    // Monitor for native Task tool usage (Approach 3 detection)
    const subtasks: ChildSession[] = [];

    execution.onToolCall(async (tool) => {
      if (tool.name === 'Task' || tool.name === 'bash') {
        const command = tool.input.command;

        // Check if it's an Agor subtask command
        if (command.includes('agor session subtask')) {
          // ✅ Agent followed instructions!
          const childSessionId = await handleAgorSubtask(command);
          subtasks.push({ sessionId: childSessionId, type: 'agor' });
        } else if (this.looksLikeTaskDelegation(tool)) {
          // ⚠️ Agent used native Task tool - warn but allow
          console.warn('Agent used native Task tool instead of Agor subtask');
          subtasks.push({
            sessionId: null,
            type: 'native',
            warning: 'Not tracked by Agor'
          });
        }
      }
    });

    const result = await execution;

    return {
      result,
      subtasks,
      compliance: subtasks.every(s => s.type === 'agor')
    };
  }

  private looksLikeTaskDelegation(tool: ToolCall): boolean {
    // Heuristics to detect native task delegation
    return tool.name === 'Task'
      || (tool.name === 'bash' && tool.input.command?.includes('task'));
  }
}
```

### Pros & Cons

**Pros:**
✅ Best of both worlds (prompt + detection)
✅ Can warn user if agent doesn't comply
✅ Graceful degradation (works even if agent ignores)
✅ Collects data on agent compliance rates

**Cons:**
❌ Complex implementation
❌ Still requires prompt wrapping (token overhead)
❌ Detection heuristics might miss edge cases

**Recommendation:** **This is probably the best approach** for V1.

---

## User Experience: Creating Subtasks

### UI Flow

**Scenario:** User wants to delegate a subtask

**Option A: Explicit Subtask Button**
```
┌─────────────────────────────────────────┐
│ Session: Build Auth System              │
├─────────────────────────────────────────┤
│ Input Box:                              │
│ ┌─────────────────────────────────────┐ │
│ │ Design the database schema for      │ │
│ │ user authentication...              │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ [Send]  [Fork]  [🎯 Create Subtask]    │
└─────────────────────────────────────────┘
```

**When user clicks "Create Subtask":**
1. Agor prepares subtask context
2. Sends wrapped prompt to parent agent:
   ```
   "Please help prepare an optimal prompt for a subtask based on:
   [User's subtask description]

   Then execute: agor session subtask --prompt '[your prepared prompt]'"
   ```
3. Agent refines prompt and creates Agor subtask
4. New session appears in tree as child

**Option B: Agent-Initiated Subtask**
```
Agent response:
"I'll handle the API implementation and delegate the schema design
to a focused subtask."

Running: agor session subtask --prompt "..."
↓
[Agor UI shows new child session appearing in tree]
```

**Option C: Auto-Detect Pattern**
```
User prompt: "Build auth with separate subtasks for schema and tests"

Agor detects keywords: "subtasks", "separate", "delegate"
→ Suggests subtask mode in UI
→ Or automatically instructs agent to use subtasks
```

---

## Agent-Specific Strategies

### Claude Code

**Native Capability:** Has Task tool for delegation

**Agor Strategy:**
```typescript
// System prompt or per-task wrapping
const instructions = `
When delegating work, prefer Agor subtasks over your Task tool:

Native Task tool:
- Spawns subprocess (no Agor visibility)
- Can't fork or continue conversation after completion

Agor subtask:
\`\`\`bash
agor session subtask --agent claude-code --prompt "focused task description"
\`\`\`
- Full conversation history
- Forkable if approach needs revision
- Generates reports automatically
`;
```

**Compliance Detection:**
```typescript
execution.onToolCall((tool) => {
  if (tool.name === 'Task') {
    logWarning('Claude used native Task instead of Agor subtask');
    // Could inject reminder for next prompt
  } else if (tool.name === 'bash' && tool.input.includes('agor session subtask')) {
    logSuccess('Claude correctly used Agor subtask');
  }
});
```

---

### Cursor

**Native Capability:** Unknown (may not have explicit subtask tool)

**Agor Strategy:**
- Likely doesn't need special handling
- If Cursor delegates, it's probably via prompting, not tool
- Agor prompt wrapping should work

---

### OpenAI/Codex

**Native Capability:** No built-in subtask mechanism

**Agor Strategy:**
```typescript
// Codex doesn't have native subtasks, so easier to control
const systemMessage = {
  role: 'system',
  content: `
  When you need to delegate focused work, use:
  \`agor session subtask --prompt "clear task description"\`

  This creates a new AI session optimized for the subtask.
  `
};
```

**Likely Compliance:** High (no competing tool to use instead)

---

### Gemini

**Native Capability:** Unknown

**Agor Strategy:** Similar to Codex (system instructions + prompt wrapping)

---

## Technical Implementation

### Agor CLI: `agor session subtask`

**Command:**
```bash
agor session subtask \
  --prompt "Design PostgreSQL schema for auth" \
  --agent claude-code \
  --concepts database,security \
  --sync  # Wait for completion (default: async)
```

**What it does:**
1. Creates new session with `parent_session_id` set
2. Loads specified concepts into context
3. Executes prompt
4. Returns session_id when complete (if --sync)

**In Agent Context:**
```bash
# Agent runs this via bash tool
agor session subtask --prompt "Design user table schema" --sync

# Output:
# Subtask session created: 01933f2b
# Status: running...
# Status: completed
# Session ID: 01933f2b
# Summary: Created users table with id, email, password_hash...
```

**Agent sees output, can reference in response:**
```
"I've delegated the schema design to a subtask (session 01933f2b).
The subtask created a users table with proper constraints..."
```

---

### Agor Daemon: Subtask Handler

```typescript
// Feathers service for subtasks
class SubtaskService {
  async create(data: CreateSubtaskRequest, params) {
    const { prompt, parentSessionId, agent, concepts, sync } = data;

    // Create child session
    const childSession = await this.sessionsService.create({
      agent,
      concepts,
      genealogy: {
        parent_session_id: parentSessionId,
        spawn_point_task_id: params.currentTaskId
      }
    });

    // Execute task
    const execution = await this.agentClients[agent]
      .getSession(childSession.session_id)
      .executeTask(prompt);

    if (sync) {
      // Wait for completion
      const result = await execution;
      return {
        sessionId: childSession.session_id,
        status: 'completed',
        summary: result.summary
      };
    } else {
      // Return immediately
      return {
        sessionId: childSession.session_id,
        status: 'running'
      };
    }
  }
}
```

---

## Observability & Compliance Tracking

### Measure Agent Compliance

**Track how often agents follow instructions:**

```typescript
interface SubtaskComplianceMetrics {
  sessionId: string;
  totalSubtasks: number;
  agorTracked: number;      // Used agor session subtask
  nativeTools: number;       // Used Task tool
  complianceRate: number;    // agorTracked / totalSubtasks
}

// Example analytics
{
  sessionId: '01933e4a',
  totalSubtasks: 5,
  agorTracked: 4,
  nativeTools: 1,
  complianceRate: 0.80  // 80% compliance
}
```

**Display in UI:**
```
Session Tree:
├─ Session A (claude-code) ✅ 100% Agor subtasks
│   ├─ Subtask 1 (Agor-tracked)
│   └─ Subtask 2 (Agor-tracked)
│
└─ Session B (claude-code) ⚠️ 60% Agor subtasks
    ├─ Subtask 3 (Agor-tracked)
    ├─ Subtask 4 (Native Task - not visible)
    └─ Subtask 5 (Agor-tracked)
```

---

## Prompt Engineering Best Practices

### Effective Delegation Instructions

**❌ Too vague:**
```
"When delegating, use Agor subtasks instead of Task tool"
```

**✅ Clear with examples:**
```
When you need to delegate focused work to a subtask:

DO THIS:
\`\`\`bash
agor session subtask --prompt "Clear, focused task description"
\`\`\`

NOT THIS:
Using your native Task tool (bypasses Agor tracking)

Example:
User: "Build auth with database schema"
You: "I'll handle endpoints and delegate schema..."

Correct:
\`\`\`bash
agor session subtask --prompt "Design PostgreSQL schema for user auth: users, sessions, roles tables"
\`\`\`
```

### Context Preparation for Subtasks

**Agent should prepare optimal subtask prompts:**

```typescript
// Instead of just passing user prompt through
const userSubtaskRequest = "design the schema";

// Agent prepares comprehensive subtask prompt
const preparedPrompt = `
Design PostgreSQL database schema for user authentication.

Requirements:
- Users table: id, email, password_hash, created_at
- Sessions table: token, user_id, expires_at
- Roles table: role_name, permissions (JSONB)
- Proper indexes on foreign keys
- UUID primary keys

Constraints:
- Email uniqueness
- Cascade deletes for sessions when user deleted
- Check constraint on expires_at (must be future)

Output format:
- SQL migration file
- ER diagram (mermaid)
- Index strategy explanation
`;

await bash(`agor session subtask --prompt "${preparedPrompt}"`);
```

**This is huge value:** Agent enriches user's vague request into detailed subtask context.

---

## Future: Multi-Agent Subtasks

**V2 feature:** Parent and child can be different agents

```bash
# Parent: Claude Code working on API
# Delegates schema to Gemini (better at data modeling)

agor session subtask \
  --prompt "Design database schema..." \
  --agent gemini \
  --concepts database
```

**Cross-agent delegation benefits:**
- Use best tool for each job
- Gemini for schemas, Claude for reasoning, Codex for boilerplate
- Full observability across agent types

---

## Open Questions

### 1. Should subtasks auto-start or require confirmation?

**Option A: Auto-start**
- Agent calls `agor session subtask`, Agor immediately creates child session
- Faster, agent-driven

**Option B: Confirm**
- Agent signals intent, user confirms in UI modal
- More control, but interrupts flow

**Recommendation:** Auto-start (trust agent), with UI notification

---

### 2. How to handle deeply nested subtasks?

**Scenario:**
```
Session A
└─ Subtask B
   └─ Subtask C
      └─ Subtask D
```

**Concerns:**
- Tree gets very deep
- Context drift across levels
- Hard to visualize

**Recommendation:**
- Limit depth to 3 levels (configurable)
- Warn if agent tries to go deeper
- Provide "flatten" option to merge subtask back into parent

---

### 3. Sync vs Async subtasks?

**Sync (--sync flag):**
- Parent waits for subtask completion
- Gets result back immediately
- Blocking

**Async (default):**
- Parent continues while subtask runs
- Checks status later
- Non-blocking

**Recommendation:** Default to sync for simplicity, allow async for advanced use

---

### 4. What if agent refuses to use Agor subtasks?

**Fallback strategy:**
1. Detect native Task tool usage
2. Show warning in UI: "Subtask not tracked by Agor"
3. Offer to migrate: "Convert to Agor subtask?" button
4. If user clicks, pause parent, create Agor subtask with same prompt

---

## Success Criteria

**V1 Subtask System is successful if:**
1. ✅ Agents comply 80%+ of the time with Agor subtask instructions
2. ✅ Users can see full conversation history in subtask sessions
3. ✅ Subtasks appear correctly in session tree UI
4. ✅ Can fork subtasks independently of parent
5. ✅ Reports generated for subtasks
6. ✅ Can continue prompting child session after parent completes

---

## Implementation Roadmap

### Phase 1: Basic Subtask Support
1. Implement `agor session subtask` CLI command
2. Add `parent_session_id` to Session model
3. Create SubtaskService in Feathers
4. Test with hardcoded prompts

### Phase 2: Prompt Engineering
1. Design system prompt for Claude Code
2. Implement per-task prompt wrapping
3. A/B test different instruction phrasings
4. Measure compliance rates

### Phase 3: Tool Detection
1. Monitor tool calls for native Task usage
2. Log compliance metrics
3. Build UI warnings for non-Agor subtasks
4. Implement migration flow

### Phase 4: UI Integration
1. Add "Create Subtask" button to session input
2. Show subtask nodes in session tree canvas
3. Display compliance badges
4. Build subtask-specific filtering/views

### Phase 5: Multi-Agent Delegation
1. Support `--agent` flag for cross-agent subtasks
2. Test Gemini subtasks from Claude parent
3. Build agent recommendation system

---

## Related Explorations

- [[agent-interface]] - How we interface with agent SDKs
- [[native-cli-feature-gaps]] - Features we might lose via SDK
- [[models]] - Session and Task data models
- [[core]] - The 5 primitives (Session, Task, Spawn)

---

## Key Insights

**The Big Bet:**
Prompt engineering + CLI injection can make agents prefer Agor subtasks over native tools.

**Why It Should Work:**
1. Agents are instruction-followers (especially Claude)
2. Clear examples in prompts improve compliance
3. Bash tool access means agents can run `agor` commands
4. Benefits are tangible (observability, forking, reports)

**Fallback:**
Even if compliance is imperfect, we can detect and migrate native subtasks to Agor post-hoc.

**The Value:**
Agor-tracked subtasks turn ephemeral agent delegations into **persistent, forkable, reportable sessions** - core to the session tree vision.
