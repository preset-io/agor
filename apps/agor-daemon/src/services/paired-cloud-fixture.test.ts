import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createPairedCloudChannel } from './test-support/paired-cloud-fixture';

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  const requests: Array<{ id: string; method: string }> = [];
  child.stdin.on('data', (chunk) => requests.push(JSON.parse(String(chunk))));
  const channel = createPairedCloudChannel(child as unknown as ChildProcessWithoutNullStreams);
  const reply = (value: unknown) => child.stdout.write(`${JSON.stringify(value)}\n`);
  return { child, channel, requests, reply };
}

describe('paired fixture CLI framing (not provider acceptance)', () => {
  it('correlates concurrent raw transport calls without replacing response data', async () => {
    const { channel, requests, reply, child } = fixture();
    const first = channel.call('request', { bodyBase64: 'AAEC' });
    const second = channel.call('counters');
    reply({ id: requests[1].id, ok: true, result: { calls: 2 } });
    const raw = JSON.stringify({ id: requests[0].id, ok: true, result: { bodyBase64: 'AAEC' } });
    child.stdout.write(raw.slice(0, 7));
    child.stdout.write(`${raw.slice(7)}\n`);
    expect(await first).toEqual({ bodyBase64: 'AAEC' });
    expect(await second).toEqual({ calls: 2 });
    child.emit('exit', 0);
    await channel.stop();
  });
  it('does not leak rejected worker response text into diagnostics', async () => {
    const { channel, requests, reply, child } = fixture();
    const call = channel.call('seed');
    const assertion = expect(call).rejects.toThrow(/^Paired fixture operation rejected$/);
    reply({ id: requests[0].id, ok: false, error: 'synthetic-sensitive-response' });
    await assertion;
    child.emit('exit', 0);
    await channel.stop();
  });
  it('fails every pending request on malformed or uncorrelated output', async () => {
    const { channel, reply, child } = fixture();
    const call = channel.call('start');
    const assertion = expect(call).rejects.toThrow('transport unavailable');
    reply({ id: 'unknown', ok: true, result: {} });
    await assertion;
    expect(child.kill).toHaveBeenCalled();
    await expect(channel.call('counters')).rejects.toThrow('transport unavailable');
    await channel.stop();
  });
  it('bounds unterminated frames and startup lifetime', async () => {
    const first = fixture();
    const oversized = first.channel.call('start');
    const oversizedAssertion = expect(oversized).rejects.toThrow('transport unavailable');
    first.child.stdout.write(Buffer.alloc(2 * 1024 * 1024 + 1, 65));
    await oversizedAssertion;
    await first.channel.stop();
    const second = fixture();
    await expect(second.channel.call('start', undefined, 1)).rejects.toThrow(
      'transport unavailable'
    );
    expect(second.child.kill).toHaveBeenCalled();
    await second.channel.stop();
  });
});
