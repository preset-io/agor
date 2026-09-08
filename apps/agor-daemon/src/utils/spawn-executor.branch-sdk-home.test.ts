import { describe, expect, it } from 'vitest';
import { substituteTemplateVariables } from './spawn-executor.js';

// Delegated-mode {branch_sdk_home} template variable (design §7.4).
describe('substituteTemplateVariables: {branch_sdk_home}', () => {
  it('substitutes the absolute path, shell-escaped as one opaque argument', () => {
    const out = substituteTemplateVariables('launch --sdk-home {branch_sdk_home}', {
      branch_sdk_home: '/data/branch-homes/abc',
    });
    expect(out).toBe("launch --sdk-home '/data/branch-homes/abc'");
  });

  it('renders an empty (escaped) argument when the branch has no SDK home', () => {
    const out = substituteTemplateVariables('launch --sdk-home {branch_sdk_home}', {
      branch_sdk_home: '',
    });
    // Never leaves the literal placeholder in the command.
    expect(out).not.toContain('{branch_sdk_home}');
    expect(out).toBe("launch --sdk-home ''");
  });

  it('renders empty when the variable is omitted entirely (inert default)', () => {
    const out = substituteTemplateVariables('launch --sdk-home {branch_sdk_home}', {});
    expect(out).not.toContain('{branch_sdk_home}');
    expect(out).toBe("launch --sdk-home ''");
  });

  it('escapes a path containing shell metacharacters (no word-split / glob)', () => {
    const out = substituteTemplateVariables('x {branch_sdk_home}', {
      branch_sdk_home: "/data/b h/'; rm -rf /",
    });
    expect(out).toBe("x '/data/b h/'\\''; rm -rf /'");
  });
});
