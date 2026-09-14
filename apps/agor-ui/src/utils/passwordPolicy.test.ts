import { describe, expect, it } from 'vitest';
import { passwordPolicyHelp, passwordPolicyRequirements, passwordRules } from './passwordPolicy';

describe('password policy form hints', () => {
  it('uses the secure fallback and describes password-manager-friendly rules', () => {
    const requirements = passwordPolicyRequirements();
    expect(requirements).toMatchObject({ profile: 'secure', min_length: 15, max_utf8_bytes: 72 });
    expect(passwordPolicyHelp(requirements)).toContain('all character types are allowed');
  });

  it('rejects short and bcrypt-truncated values without pretending to enforce the deny-list', async () => {
    const rules = passwordRules(undefined, { required: true });
    const validator = rules.find(
      (rule) => typeof rule === 'object' && rule !== null && 'validator' in rule
    );
    if (!validator || typeof validator !== 'object' || !('validator' in validator)) {
      throw new Error('validator rule missing');
    }
    const validate = validator.validator as (_rule: unknown, value: unknown) => Promise<void>;
    await expect(validate({}, 'short')).rejects.toThrow(/at least 15/);
    await expect(validate({}, 'x'.repeat(73))).rejects.toThrow(/at most 72/);
    await expect(validate({}, 'a unique local passphrase')).resolves.toBeUndefined();
  });
});
