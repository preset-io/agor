/**
 * Unit tests for the onboarding kickoff prompt builder.
 *
 * These assert the prompt actually encodes the behavioral contract this
 * feature depends on - since the "onboarding agent" IS this prompt text,
 * a regression here is a regression in the product, not just a string
 * change.
 */

import { describe, expect, it } from 'vitest';
import { buildOnboardingKickoffPrompt } from './kickoff-prompt';

const baseInput = {
  namespaceSlug: 'onboarding-abc12345',
  docPath: 'progress.md',
};

describe('buildOnboardingKickoffPrompt', () => {
  it('embeds the exact namespace slug and doc path so the agent never has to guess its own scope', () => {
    const prompt = buildOnboardingKickoffPrompt({ ...baseInput, reason: 'auto' });
    expect(prompt).toContain('onboarding-abc12345');
    expect(prompt).toContain('progress.md');
  });

  it('never frames AI-connection as a step, and never instructs a credential check', () => {
    const prompt = buildOnboardingKickoffPrompt({ ...baseInput, reason: 'auto' });
    expect(prompt.toLowerCase()).not.toMatch(/step 1.*connect.*ai/);
    expect(prompt).toContain('is already connected');
    expect(prompt).not.toContain('agor_users_get_current');
  });

  it('lists exactly the 2 core + 4 optional steps, keyed by stable ids', () => {
    const prompt = buildOnboardingKickoffPrompt({ ...baseInput, reason: 'auto' });
    for (const stepId of [
      'repo_branch',
      'first_prompt',
      'board_zone',
      'invite_or_assistant',
      'mcp_connection',
      'first_artifact',
    ]) {
      expect(prompt).toContain(stepId);
    }
  });

  it('instructs picking a subset of optional steps rather than running all of them', () => {
    const prompt = buildOnboardingKickoffPrompt({ ...baseInput, reason: 'auto' });
    expect(prompt).toMatch(/pick 1-3/);
    expect(prompt).toMatch(/never (run|track) all four|never mechanically/);
  });

  it('instructs combining first_prompt and first_artifact when the work has a visual output', () => {
    const prompt = buildOnboardingKickoffPrompt({ ...baseInput, reason: 'auto' });
    expect(prompt).toMatch(/judgment call/i);
    expect(prompt).toContain('agor_artifacts_publish');
  });

  it('never instructs calling AskUserQuestion', () => {
    const prompt = buildOnboardingKickoffPrompt({ ...baseInput, reason: 'auto' });
    expect(prompt).toMatch(/never call it/);
    expect(prompt).toContain('AskUserQuestion');
  });

  it('mirrors the env_vars widget dismissal phrasing for whole-flow dismissal', () => {
    const prompt = buildOnboardingKickoffPrompt({ ...baseInput, reason: 'auto' });
    expect(prompt).toContain(
      "don't re-request immediately - ask whether to proceed without, or move on to other work."
    );
  });

  it('caps the todo list at 5 items and excludes AI-connection from it', () => {
    const prompt = buildOnboardingKickoffPrompt({ ...baseInput, reason: 'auto' });
    expect(prompt).toMatch(/<=5-item/);
    expect(prompt).toMatch(/never an "AI connected" entry/);
  });

  it('deep-links to Settings > MCP Servers instead of building an inline capture', () => {
    const prompt = buildOnboardingKickoffPrompt({ ...baseInput, reason: 'auto' });
    expect(prompt).toContain('/settings/mcp/');
    expect(prompt).toContain('agor_mcp_servers_list');
  });

  it('varies the trigger framing between auto and manual, and manual overrides a prior dismissal', () => {
    const autoPrompt = buildOnboardingKickoffPrompt({ ...baseInput, reason: 'auto' });
    const manualPrompt = buildOnboardingKickoffPrompt({ ...baseInput, reason: 'manual' });
    expect(autoPrompt).not.toEqual(manualPrompt);
    expect(manualPrompt).toMatch(/overrides a prior dismissal/);
  });

  it('instructs writing progress immediately, not batching or speculating', () => {
    const prompt = buildOnboardingKickoffPrompt({ ...baseInput, reason: 'auto' });
    expect(prompt).toMatch(/not batched, not speculative/);
    expect(prompt).toContain('expectedVersion');
  });

  it('instructs no internal-mechanics narration', () => {
    const prompt = buildOnboardingKickoffPrompt({ ...baseInput, reason: 'auto' });
    expect(prompt).toMatch(/do not narrate/i);
  });
});
