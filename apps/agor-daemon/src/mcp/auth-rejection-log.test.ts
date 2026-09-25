import { afterEach, expect, it, vi } from 'vitest';
import { createMcpAuthRejectionLogger } from './auth-rejection-log.js';

afterEach(() => vi.restoreAllMocks());

it('bounds each reason independently and reports suppressed counts without request content', () => {
  let now = 0;
  const log = createMcpAuthRejectionLogger(() => now);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  for (let i = 0; i < 1000; i++) log('wrong_segment_count', 'secret-method', 'authorization');
  log('expired', 'POST', 'authorization');
  log('secret_missing', 'GET', 'api_key');
  log('verify_error', 'DELETE', 'authorization');
  expect(warn).toHaveBeenCalledTimes(2);
  expect(error).toHaveBeenCalledTimes(2);
  expect(warn.mock.calls[0]).toEqual([
    '[mcp.auth] rejected reason=wrong_segment_count sample_method=other sample_source=authorization sample_rpc=other client_hint=unknown suppressed=0',
  ]);
  now = 60_000;
  log('wrong_segment_count', 'GET', 'api_key');
  expect(warn).toHaveBeenLastCalledWith(
    '[mcp.auth] rejected reason=wrong_segment_count sample_method=GET sample_source=api_key sample_rpc=other client_hint=unknown suppressed=999'
  );
  expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-method');
  now = 120_000;
  log('wrong_segment_count', 'POST', 'authorization');
  expect(warn.mock.lastCall?.[0]).toContain('suppressed=0');
});

it('keeps probe failures from hiding tool-call failures and bounds arbitrary RPC names', () => {
  const log = createMcpAuthRejectionLogger(() => 0);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  for (let i = 0; i < 100; i++) {
    log('wrong_segment_count', 'POST', 'authorization', { method: 'initialize' });
    log('wrong_segment_count', 'POST', 'authorization', {
      method: `private-${i}`,
      params: 'secret',
    });
  }
  log('wrong_segment_count', 'POST', 'authorization', { method: 'tools/call', params: 'secret' });
  expect(warn).toHaveBeenCalledTimes(3);
  expect(warn.mock.lastCall?.[0]).toContain('sample_rpc=tools/call');
  expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private|secret/);
});

it('allowlists spoofable client hints without adding sampling buckets or retaining raw text', () => {
  let now = 0;
  const log = createMcpAuthRejectionLogger(() => now);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  for (const hint of ['claude', 'codex', 'gemini', 'copilot', 'cursor', 'opencode']) {
    now += 60_000;
    log('wrong_segment_count', 'POST', 'authorization', {}, hint);
    expect(warn.mock.lastCall?.[0]).toContain(`client_hint=${hint}`);
  }
  for (const hint of ['private-secret\ninjected', ['codex'], 'codex, claude', 'CODEX', undefined]) {
    now += 60_000;
    log('wrong_segment_count', 'POST', 'authorization', {}, hint);
    expect(warn.mock.lastCall?.[0]).toContain('client_hint=unknown');
  }
  const count = warn.mock.calls.length;
  for (let i = 0; i < 100; i++) {
    log('wrong_segment_count', 'POST', 'authorization', {}, `private-${i}`);
  }
  log('wrong_segment_count', 'POST', 'authorization', {}, 'codex');
  expect(warn).toHaveBeenCalledTimes(count);
  expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private|injected/);
});
