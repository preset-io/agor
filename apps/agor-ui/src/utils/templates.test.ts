import { describe, expect, it } from 'vitest';
import { isUnrenderedTemplate } from './templates';

describe('isUnrenderedTemplate', () => {
  it('flags a template with an expression that came back as written', () => {
    expect(isUnrenderedTemplate('Review {{branch.name}', 'Review {{branch.name}')).toBe(true);
  });

  it('does not flag a filled template or one without expressions', () => {
    expect(isUnrenderedTemplate('Review {{branch.name}}', 'Review feature-x')).toBe(false);
    expect(isUnrenderedTemplate('Review this branch.', 'Review this branch.')).toBe(false);
  });
});
