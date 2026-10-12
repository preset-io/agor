import { expect, it } from 'vitest';
import { deletionErrorCategory } from './branch-deletion-diagnostics';

it('recognizes server transaction-abort evidence, not HTTP errors or transport failures', () => {
  expect(deletionErrorCategory({ cause: { code: '40P01', message: '/secret SQL' } })).toBe(
    'database_deadlock_abort'
  );
  expect(deletionErrorCategory({ cause: { code: '40001' } })).toBe('database_serialization_abort');
  for (const error of [
    { code: 500 },
    { code: 'ECONNRESET' },
    new Error('token /secret'),
    { code: 'unsafe arbitrary code' },
  ])
    expect(deletionErrorCategory(error)).toBe('outcome_unknown');
});
