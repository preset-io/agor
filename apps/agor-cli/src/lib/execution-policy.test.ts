import { describe, expect, it } from 'vitest';
import { executionPolicyFor } from './execution-policy';

describe('executionPolicyFor', () => {
  it.each([
    ['login', 'bootstrap'],
    ['auth:login', 'bootstrap'],
    ['daemon:start', 'local'],
    ['db:migrate', 'local'],
    ['repo:add-local', 'local'],
    ['branch:cd', 'local'],
    ['repo:list', 'connection'],
    ['session:list', 'connection'],
  ] as const)('classifies %s as %s', (command, policy) => {
    expect(executionPolicyFor(command)).toBe(policy);
  });
});
