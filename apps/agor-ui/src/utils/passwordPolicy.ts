import {
  type PasswordPolicyRequirements,
  SECURE_PASSWORD_POLICY_REQUIREMENTS,
} from '@agor/core/config/browser';
import type { FormItemProps } from 'antd';

export function passwordPolicyRequirements(
  advertised?: PasswordPolicyRequirements
): PasswordPolicyRequirements {
  return advertised ?? { ...SECURE_PASSWORD_POLICY_REQUIREMENTS };
}

export function passwordPolicyHelp(requirements: PasswordPolicyRequirements): string {
  return `Use at least ${requirements.min_length} characters (maximum ${requirements.max_utf8_bytes} UTF-8 bytes). Common passwords are rejected; spaces and all character types are allowed.`;
}

export function passwordRules(
  advertised: PasswordPolicyRequirements | undefined,
  options: { required: boolean }
): NonNullable<FormItemProps['rules']> {
  const requirements = passwordPolicyRequirements(advertised);
  return [
    ...(options.required ? [{ required: true, message: 'Please enter a password' }] : []),
    {
      validator: async (_rule: unknown, value: unknown) => {
        if (!options.required && (value === undefined || value === '')) return;
        if (typeof value !== 'string' || value.length === 0) {
          throw new Error('Please enter a password');
        }
        if (Array.from(value).length < requirements.min_length) {
          throw new Error(`Password must be at least ${requirements.min_length} characters`);
        }
        if (new TextEncoder().encode(value).byteLength > requirements.max_utf8_bytes) {
          throw new Error(`Password must be at most ${requirements.max_utf8_bytes} UTF-8 bytes`);
        }
      },
    },
  ];
}
