# Zone Trigger Permission Mode Mutation - Fix Summary

## Problem

When reusing an existing session via zone trigger with fork/spawn actions, the permission mode (and other config like agent, model, MCP servers) appeared to be getting "mutated" or lost. Users were selecting different permissions in the modal, but the settings didn't persist correctly.

## Root Causes

### Issue 1: Inconsistent UI Pattern

The modal showed/hid agent configuration options based on whether you were creating new or reusing a session:

- **Create new**: Show agent selection + config form (expanded)
- **Reuse with prompt**: Hide form entirely
- **Reuse with fork/spawn**: Show agent selection + config form

This created confusion about:

1. What config is actually being used for reuse
2. Whether form values were even being applied
3. Whether existing session settings were being properly displayed

### Issue 2: Form Values Collected But Not Used for Reuse

In the handler code, when reusing a session:

```typescript
// Form values collected but never used
const formValues = form.getFieldsValue();
...(selectedAction === 'fork' || selectedAction === 'spawn'
  ? {
      agent: selectedAgent,
      modelConfig: formValues.modelConfig,
      permissionMode: formValues.permissionMode,
      mcpServerIds: formValues.mcpServerIds,
    }
  : {}),
```

These values were passed to `onExecute()`, but in the handler itself, they were **completely ignored**:

```typescript
case 'fork': {
  const forkedSession = (await client
    .service(`sessions/${targetSessionId}/fork`)
    .create({})) as Session;  // ❌ NO params passed
  await client.service(`sessions/${forkedSession.session_id}/prompt`).create({
    prompt: renderedTemplate,
    // ❌ permissionMode not passed
  });
}
```

### Issue 3: Backend Doesn't Accept Config on Fork/Spawn

The fork/spawn endpoints don't accept configuration parameters:

- **Fork**: Only accepts `{ prompt?: string; task_id?: string }`
- **Spawn**: Only accepts `{ prompt?: string; title?: string; agent?: string; task_id?: string }`

Neither accepts `permissionMode`, `modelConfig`, or `mcpServerIds`.

### Issue 4: Permission Mode Not Persisted

Even though the prompt endpoint accepts `permissionMode`, it's only used for that execution—it's never saved to the session's `permission_config.mode` in the database.

## Solution Implemented

**Always show agentic tool configuration (collapsed by default for reuse), with pre-populated values from the selected session.**

### Changes to ZoneTriggerModal.tsx

#### 1. Pre-populate Form with Selected Session Config

When a session is selected for reuse, automatically populate the form with its current settings:

```typescript
// Pre-populate form with selected session's config when reusing
useEffect(() => {
  if (mode === 'reuse_existing' && selectedSession) {
    form.setFieldsValue({
      agent: selectedSession.agentic_tool,
      permissionMode: selectedSession.permission_config?.mode,
      modelConfig: selectedSession.model_config,
    });
  }
}, [mode, selectedSession, form]);
```

#### 2. Unified Agent Configuration UI

Moved the agent config section outside the conditional logic:

- **For create_new**: Expanded by default, user selects agent and configures settings
- **For reuse_existing**: Collapsed by default, shows pre-populated current config with info alert
- Same form structure in both cases—no hidden complexity

#### 3. Clarified Data Flow for Reuse

For reuse mode, explicitly handle what data gets sent:

- **Prompt action**: Only send prompt text (form is informational only)
- **Fork/spawn actions**: Include config in the call (future-proofing for backend support)

```typescript
const params: Parameters<typeof onExecute>[0] = {
  sessionId: selectedSessionId,
  action: selectedAction,
  renderedTemplate: editableTemplate,
};

if (selectedAction === 'fork' || selectedAction === 'spawn') {
  params.agent = formValues.agent || selectedSession?.agentic_tool;
  params.modelConfig = formValues.modelConfig;
  params.permissionMode = formValues.permissionMode;
  params.mcpServerIds = formValues.mcpServerIds;
}

await onExecute(params);
```

#### 4. Better UX Signals

- Collapse shows current agent type: `Session Configuration (claude-code)`
- Info alert on reuse: "Showing current configuration. These settings are for reference."
- Clear visual distinction between create vs reuse modes

## Benefits

1. **Visual Clarity**: Same config structure regardless of create/reuse path
2. **No Hidden State**: Current session config is always visible (collapsed)
3. **Prevents Confusion**: Users can see exactly what config is being used
4. **Future-Proof**: Ready for backend updates to support fork/spawn with custom config
5. **Consistent**: Agentic tool config always shown consistently

## What This Fix Does NOT Change

- **Backend behavior**: Fork/spawn still inherit parent config (unchanged)
- **Permission mode for reuse**: Still uses session's existing permission_mode (unchanged)
- **Prompt execution**: Permission modes are not persisted to DB (unchanged, requires separate backend work)

## Future Improvements

To fully support changing config on reuse with fork/spawn:

1. **Backend**: Update spawn endpoint to accept and apply `permissionMode`, `modelConfig`, `mcpServerIds`
2. **UI**: Remove the info alert and allow editing for fork/spawn actions (currently read-only for reference)
3. **Session updates**: Patch newly created fork/spawn sessions with provided config before executing prompt

Example future enhancement:

```typescript
// Update spawn endpoint to support this
const spawnedSession = await client.service(`sessions/${targetSessionId}/spawn`).create({
  agent: selectedAgent,
  permissionMode: selectedFormMode,
  modelConfig: selectedModelConfig,
  mcpServerIds: selectedMcpServers,
});
```

## Testing Checklist

- [ ] Create new session via zone trigger → config form is expanded and allows selection
- [ ] Reuse session via zone trigger with prompt action → config form is collapsed, shows current settings
- [ ] Reuse session via zone trigger with fork action → config form shows current settings, prompt is sent correctly
- [ ] Reuse session via zone trigger with spawn action → config form shows current settings, child session created correctly
- [ ] Switching between sessions in reuse mode → form values update to show selected session's config
- [ ] Modal closes properly after execution → next time opened, defaults are reset
