import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RailwayAPI } from './api.mjs';

test('reports operation and safe error category, never raw errors or secrets; no retry', async () => {
  let calls = 0;
  const api = new RailwayAPI('synthetic-secret', async () => {
    calls++;
    return new Response(
      JSON.stringify({
        errors: [
          {
            message: 'name too long synthetic-secret',
            extensions: { code: 'untrusted-secret-code' },
          },
        ],
      })
    );
  });
  await assert.rejects(
    api.query(
      'mutation PreviewEnvironment($input:EnvironmentCreateInput!){environmentCreate(input:$input){id}}'
    ),
    error => {
      assert.match(error.message, /PreviewEnvironment \(HTTP 200; name length validation\)/);
      assert.doesNotMatch(error.message, /synthetic-secret|untrusted-secret-code/);
      return true;
    }
  );
  assert.equal(calls, 1);
});
