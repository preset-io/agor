import { describe, expect, it } from 'vitest';
import { renderSpawnSubsessionPrompt } from './spawn-subsession-template';

describe('renderSpawnSubsessionPrompt', () => {
  it('substitutes the user prompt verbatim', () => {
    const out = renderSpawnSubsessionPrompt({ userPrompt: 'add tests' });
    expect(out).toContain('"""');
    expect(out).toContain('add tests');
  });

  it('renders the child permissionMode into the meta-prompt', () => {
    const out = renderSpawnSubsessionPrompt({
      userPrompt: 'do thing',
      permissionMode: 'plan',
    });
    // The template includes "Permission Mode: <value>" for the child.
    expect(out).toContain('Permission Mode:');
    expect(out).toContain('plan');
  });

  it('autocomputes hasConfig when any config field is present', () => {
    const withConfig = renderSpawnSubsessionPrompt({
      userPrompt: 'x',
      agenticTool: 'codex',
    });
    expect(withConfig).toContain('USER CONFIGURATION:');

    const noConfig = renderSpawnSubsessionPrompt({ userPrompt: 'x' });
    expect(noConfig).not.toContain('USER CONFIGURATION:');
  });

  it('autocomputes hasCallbackConfig from callbackConfig fields', () => {
    const out = renderSpawnSubsessionPrompt({
      userPrompt: 'x',
      callbackConfig: { enableCallback: true, includeLastMessage: true },
    });
    expect(out).toContain('Callback Configuration:');
  });

  it('renders mcpServerIds with @last separator handling', () => {
    const out = renderSpawnSubsessionPrompt({
      userPrompt: 'x',
      mcpServerIds: ['a', 'b', 'c'],
    });
    // Final list form should not have a trailing comma after the last item.
    expect(out).toMatch(/"a",\s*"b",\s*"c"\s*\]/);
  });

  it('does NOT leak parentPermissionMode into the rendered output even if passed', () => {
    // Defence-in-depth pin for the parent-vs-child permissionMode bug:
    // `parentPermissionMode` is not a template variable; if a caller
    // accidentally passes it, the template should not surface it.
    const out = renderSpawnSubsessionPrompt({
      userPrompt: 'x',
      // biome-ignore lint/suspicious/noExplicitAny: pinning behaviour for unexpected input
      parentPermissionMode: 'bypassPermissions',
    } as any);
    expect(out).not.toContain('bypassPermissions');
  });
});
