# Zone Trigger Configuration UI - Design Decision

## Decision: Always Show Config Options (Collapsed for Reuse)

### Why This Approach

Instead of showing/hiding configuration based on create vs reuse mode (which created complexity and confusion), we decided to:

1. **Always render** the agentic tool configuration section
2. **Expand by default** for create_new mode
3. **Collapse by default** for reuse_existing mode
4. **Pre-populate** with selected session's current config when reusing

### Benefits

#### 1. Consistency

Same form structure regardless of which path the user takes. No hidden logic based on mode selection.

#### 2. Clarity

Users can always see what config is being used:

- Creating new? See blank form ready for input
- Reusing? See the session's current settings collapsed

#### 3. Reduced Mental Burden

User doesn't have to wonder:

- "Is the form hidden or just not shown?"
- "What settings are being applied to this reused session?"
- "Are my selected options actually being used?"

#### 4. Future-Proof

When we add backend support for custom config on fork/spawn, the UI is already in place:

- Just remove the "read-only" alert
- Allow editing for fork/spawn (or all modes)
- Submit the edited values to the backend

#### 5. Graceful Degradation

For prompt action on reuse:

- Form is shown for reference (users see current config)
- Values are NOT sent (prompt doesn't need to change settings)
- If backend later supports changing session config via prompt, we can enable it

### Alternative Approaches Considered

#### Option A: Show/Hide Conditionally (Original Code)

```
Create new:     Show agent cards + config form (expanded)
Reuse + prompt: Hide form entirely
Reuse + fork:   Show agent cards + config form (expanded)
```

**Rejected** because:

- Inconsistent experience confuses users
- Form values were collected but not used in some paths
- Hard to explain what config is actually being applied

#### Option B: Different Forms for Create vs Reuse

Create separate form components with different logic.

**Rejected** because:

- More code duplication
- Harder to maintain consistency
- Doesn't solve the fundamental confusion

#### Option C: Always Show, Always Editable

```
Create new:     Show form (expanded), allow editing
Reuse + prompt: Show form (collapsed), allow editing
Reuse + fork:   Show form (collapsed), allow editing
```

**Rejected** because:

- Backend doesn't support changing session config yet
- Would create orphaned form values that aren't applied
- Same problem we're trying to fix

#### Option D: Always Show, Pre-Populated, Smart Editability

```
Create new:     Show form (expanded), allow editing
Reuse + prompt: Show form (collapsed), read-only (info alert)
Reuse + fork:   Show form (collapsed), allow editing (for future use)
```

**Selected** because:

- Best of both worlds: informational and future-proof
- Clear intent via collapse state and alerts
- No confusion about what's being applied
- Backward compatible (prompt action unchanged)
- Ready for backend enhancements

### Implementation Details

#### Pre-Population Logic

```typescript
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

This automatically syncs the form to the selected session whenever:

- User switches between sessions
- Mode changes from create to reuse
- Selected session's config changes (unlikely but defensive)

#### Collapse State Control

```typescript
<Collapse
  defaultActiveKey={mode === 'create_new' ? ['agentic-tool-config'] : []}
  // expanded for create_new, collapsed for reuse_existing
/>
```

#### Info Alert for Reuse

```typescript
{mode === 'reuse_existing' && (
  <Alert
    message="Showing current configuration. These settings are for reference."
    type="info"
    showIcon
  />
)}
```

Clearly communicates that this is informational, not editable (for now).

### Data Flow Clarity

#### For Create New

```
User fills form → Submits → Handler uses all form values → New session created with config
```

#### For Reuse + Prompt

```
Form pre-populated with session config → User sees current settings (collapsed) → Submits
→ Handler ONLY sends prompt → Prompt executed with session's existing config
```

#### For Reuse + Fork/Spawn

```
Form pre-populated with session config → User sees current settings (collapsed) → Submits
→ Handler includes config in params → Fork/spawn inherits parent config (backend ignores extras for now)
→ Future: Backend accepts and applies config to new session
```

### Future Enhancement Path

When backend is updated to support custom config on fork/spawn:

1. Change info alert condition:

   ```typescript
   {mode === 'reuse_existing' && selectedAction === 'prompt' && (
     <Alert message="Showing current configuration. These settings are for reference." />
   )}
   ```

2. Remove/update alert for fork/spawn (allow editing)

3. Update backend spawn/fork endpoints to accept config

4. Update handler to pass config to fork/spawn endpoints

### Testing Scenarios

1. **Create new → form expanded, user can edit** ✓
2. **Reuse + prompt → form collapsed, shows session config, prompt sent** ✓
3. **Reuse + fork → form collapsed, shows session config, fork created** ✓
4. **Reuse + spawn → form collapsed, shows session config, spawn created** ✓
5. **Switch sessions → form updates to show new session's config** ✓
6. **Modal close/open → form resets to defaults** ✓

### Conclusion

This approach provides:

- **Clarity**: Always visible, never hidden
- **Consistency**: Same structure everywhere
- **Flexibility**: Ready to extend when backend is ready
- **Safety**: Doesn't create orphaned values or unexpected behaviors
- **UX**: Clear signals via collapse state and alerts

It's the "boring, obvious" solution that just works.
