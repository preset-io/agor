import { describe, expect, it } from 'vitest';
import { knowledgeTransferWriteSchema } from '../types/knowledge-transfer';
import {
  knowledgeTransferValidationIssues,
  knowledgeTransferValidationSummary,
} from './transfer-validation';

describe('safe Knowledge transfer validation diagnostics', () => {
  it('retains field/reason from current and legacy validators, never input values', () => {
    const result = knowledgeTransferWriteSchema.safeParse({
      action: 'namespace',
      bundle: 'secret-token',
      slug: 'bad slug',
      display_name: 'Private title',
      description: null,
      'private-key-name': 'private-content',
    });
    if (result.success) throw new Error('Invalid fixture accepted');
    const issues = knowledgeTransferValidationIssues(result.error.issues);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ['resume'], code: 'invalid_type' }),
        expect.objectContaining({ path: ['bundle'], code: 'invalid_format' }),
        expect.objectContaining({ path: ['slug'], code: 'invalid_format' }),
      ])
    );
    for (const secret of ['secret-token', 'Private title', 'private-key-name', 'private-content']) {
      expect(JSON.stringify(issues)).not.toContain(secret);
      expect(knowledgeTransferValidationSummary(result.error.issues)).not.toContain(secret);
    }
    expect(
      knowledgeTransferValidationSummary([
        { path: ['cursor'], message: 'Too big: expected string to have <=100 characters' },
      ])
    ).toContain('cursor: Value exceeds');
    expect(
      knowledgeTransferValidationSummary([
        { path: ['resume'], message: 'Invalid input: expected boolean, received undefined' },
      ])
    ).toContain('resume: Missing field or wrong type');
  });

  it('bounds untrusted issue data and redacts arbitrary paths, keys and messages', () => {
    const privateValue = 'Bearer private-token\u001b[2J\nprivate document';
    const issues = [
      { path: [privateValue], message: privateValue, code: privateValue },
      { path: ['entry', 'provenance', privateValue], code: 'invalid_type' },
      { path: [], code: 'unrecognized_keys', keys: [privateValue, '$limit'] },
      { path: [], message: `Unrecognized key: "${privateValue}"` },
      null,
    ];
    const result = knowledgeTransferValidationIssues(issues);
    expect(JSON.stringify(result)).not.toContain(privateValue);
    expect(result[2].path).toEqual(['$limit']);
    expect(result[1].path).toEqual(['entry', 'provenance']);
    expect(knowledgeTransferValidationIssues(Array(100).fill(issues[0]))).toHaveLength(8);
    expect(knowledgeTransferValidationIssues({})).toEqual([]);
    expect(knowledgeTransferValidationIssues(result)).toEqual(result);
  });
});
