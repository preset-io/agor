import { expect, it } from 'vitest';
import { requestMethod } from './request-method.js';

it('labels protocol operations without retaining arbitrary request content', () => {
  for (const method of ['initialize', 'server/discover', 'tools/list', 'tools/call']) {
    expect(requestMethod({ method, params: { secret: 'private' } })).toBe(method);
  }
  expect(requestMethod([{ method: 'private' }])).toBe('batch');
  for (const body of [undefined, null, 'private', { method: 'private' }, { method: {} }]) {
    expect(requestMethod(body)).toBe('other');
  }
});
