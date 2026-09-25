#!/usr/bin/env node
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';

// Regression for our version-scoped @vitest/browser patch. Exercise the actual
// installed implementation, not a copy of the fix. These are private internals:
// fail loudly on an upstream change so the patch can be reviewed/retired.
const require = createRequire(new URL('../apps/agor-ui/package.json', import.meta.url));
const source = readFileSync(require.resolve('@vitest/browser'), 'utf8');
const handlerSource = source.match(/class BrowserServerCDPHandler \{[\s\S]*?\n\}/)?.[0];
const removeSource = source.match(/\tremoveCDPHandler\(sessionId\) \{[\s\S]*?\n\t\}/)?.[0];
assert.ok(handlerSource, 'review upstream BrowserServerCDPHandler and retire/update the patch');
assert.ok(removeSource, 'review upstream removeCDPHandler and retire/update the patch');
const Handler = vm.runInNewContext(`(${handlerSource})`);
const removeHandler = vm.runInNewContext(`({${removeSource}}).removeCDPHandler`);

test('disconnect removes all owned CDP listeners before closing tester RPC', async () => {
  const session = new EventEmitter();
  const delivered = [];
  let closed = false;
  const handler = new Handler(session, {
    async cdpEvent(event, payload) {
      // An event after close is an unhandled rejection, as in the hosted abort.
      // No rejection filter/catch or global uncaught-error handler is installed.
      if (closed) throw new Error('[birpc] rpc is closed, cannot call "cdpEvent"');
      delivered.push([event, payload]);
    },
  });
  handler.on('Debugger.scriptParsed', 'first');
  handler.on('Debugger.scriptParsed', 'second');
  handler.on('Runtime.exceptionThrown', 'exception');
  session.emit('Debugger.scriptParsed', { scriptId: 'live' });
  assert.equal(delivered.length, 1);

  const server = { cdps: new Map([['tester', handler]]) };
  // Match the WebSocket-close ordering in Vitest's installed server.
  removeHandler.call(server, 'tester');
  closed = true;
  session.emit('Debugger.scriptParsed', { scriptId: 'late' });
  session.emit('Runtime.exceptionThrown', { exceptionId: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(delivered.length, 1);
  assert.equal(session.listenerCount('Debugger.scriptParsed'), 0);
  assert.equal(session.listenerCount('Runtime.exceptionThrown'), 0);
  assert.equal(server.cdps.size, 0);
  assert.equal(Object.keys(handler.listenerIds).length, 0);
  removeHandler.call(server, 'tester'); // duplicate close is harmless
});

test('disconnect preserves other CDP subscribers and active tester errors', () => {
  const session = new EventEmitter();
  let otherEvents = 0;
  session.on('Debugger.scriptParsed', () => otherEvents++);
  const removed = new Handler(session, { cdpEvent: () => assert.fail('removed tester called') });
  const activeError = new Error('active tester failure must remain visible');
  const active = new Handler(session, {
    cdpEvent: () => {
      throw activeError;
    },
  });
  removed.on('Debugger.scriptParsed', 'removed');
  active.on('Debugger.scriptParsed', 'active');
  const server = {
    cdps: new Map([
      ['removed', removed],
      ['active', active],
    ]),
  };
  removeHandler.call(server, 'removed');
  assert.equal(session.listenerCount('Debugger.scriptParsed'), 2);
  assert.throws(
    () => session.emit('Debugger.scriptParsed', {}),
    (error) => error === activeError
  );
  assert.equal(otherEvents, 1);
  assert.equal(server.cdps.get('active'), active);
  removeHandler.call(server, 'active');
  session.emit('Debugger.scriptParsed', {});
  assert.equal(otherEvents, 2);
});
