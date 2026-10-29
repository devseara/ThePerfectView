'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { getEventListeners } = require('node:events');
const source = fs.readFileSync(path.join(__dirname, '../public/client.js'), 'utf8');

function legacyClient() {
  const timers = new Set();
  const context = vm.createContext({
    // Neither static helper exists, as on older mobile WebKit.
    AbortSignal: {}, AbortController,
    document: { documentElement: { dataset: {} }, querySelector: () => null, readyState: 'loading', addEventListener() {} },
    localStorage: { getItem: () => null },
    setTimeout(callback, milliseconds) {
      const id = setTimeout(() => { timers.delete(id); callback(); }, milliseconds);
      timers.add(id); return id;
    },
    clearTimeout(id) { timers.delete(id); clearTimeout(id); }
  });
  vm.runInContext(source, context);
  return { request: context.tpfRequestWithTimeout, timers };
}
function waitUntilAborted(signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error('Aborted by browser'), { name: 'AbortError' }));
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}

test('legacy browser can complete a request without AbortSignal.any or timeout; resources are released', async () => {
  const { request, timers } = legacyClient(), parent = new AbortController();
  const value = await request(async signal => { assert.equal(signal.aborted, false); return { completed: 31 }; }, parent.signal, 1000);
  assert.equal(value.completed, 31);
  assert.equal(timers.size, 0);
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
});

test('changing date cancels a pending request, and an already-cancelled request never starts', async () => {
  const { request, timers } = legacyClient(), parent = new AbortController();
  const work = request(waitUntilAborted, parent.signal, 1000);
  parent.abort();
  await assert.rejects(work, { name: 'AbortError' });
  let calls = 0;
  await assert.rejects(request(async () => { calls++; }, parent.signal, 1000), { name: 'AbortError' });
  assert.equal(calls, 0); assert.equal(timers.size, 0);
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
});

test('legacy request timeout covers response reading and is reported as a timeout', async () => {
  const { request, timers } = legacyClient(), parent = new AbortController();
  await assert.rejects(request(async signal => {
    // Headers have arrived, but the response body has not finished.
    const response = await Promise.resolve({ json: () => waitUntilAborted(signal) });
    return response.json();
  }, parent.signal, 5), { name: 'TimeoutError' });
  assert.equal(parent.signal.aborted, false);
  assert.equal(timers.size, 0);
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
});

test('network failures retain their original error and do not leave timers running', async () => {
  const { request, timers } = legacyClient(), parent = new AbortController();
  const failure = new Error('Network unavailable');
  await assert.rejects(request(async () => { throw failure; }, parent.signal, 1000), error => error === failure);
  assert.equal(timers.size, 0);
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
});
