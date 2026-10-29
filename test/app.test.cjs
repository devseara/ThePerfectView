'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { createApplication } = require('../lib/server.cjs');
const { Store, normalizeLink } = require('../lib/store.cjs');
const { Calendly, parseAvailability, localDate, validateQuery } = require('../lib/calendly.cjs');
const { Availability } = require('../lib/availability.cjs');
const PASSWORD = 'test-only-password-strong-123';
async function temporary(t) {
  const prefix = path.join(os.tmpdir(), 'perfect-view-test-');
  const dir = await fs.mkdtemp(prefix);
  t.after(async () => { if (!path.resolve(dir).startsWith(path.resolve(prefix))) throw new Error('Unsafe cleanup path'); await fs.rm(dir, { recursive: true, force: true }); });
  return dir;
}
async function fixture(t, options = {}) {
  const dataDir = options.dataDir || await temporary(t);
  const app = await createApplication({ dataDir, password: PASSWORD, secureCookies: false, provider: { check: async () => ({ times: [], duration: 15 }) }, ...options });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  t.after(() => new Promise(resolve => { app.server.closeAllConnections(); app.server.close(resolve); }));
  async function request(route, options = {}) { return fetch(origin + route, { ...options, headers: { Origin: origin, ...options.headers } }); }
  async function login() {
    const response = await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
    assert.equal(response.status, 200); return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: (await response.json()).csrf };
  }
  return { ...app, origin, request, login, dataDir };
}

test('equivalent Calendly event links deduplicate; foreign hosts and invalid paths are refused', () => {
  const canonical = 'https://calendly.com/alena-theperfectfranchise/perfectfranchise_intro15min';
  for (const url of [canonical, canonical + '?utm_source=89&date=2026-11-09', canonical.replace('calendly.com', 'www.calendly.com') + '/2026-11-09T15:00:00-05:00', canonical.toUpperCase()]) assert.equal(normalizeLink(url).url, canonical);
  for (const url of ['http://calendly.com/a/b', 'https://calendly.com.evil.test/a/b', 'https://localhost/a/b', 'https://me@calendly.com/a/b', 'https://calendly.com/a/%2Fsecret', 'https://calendly.com/a', 'https://calendly.com:8080/a/b']) assert.throws(() => normalizeLink(url));
});
test('availability distinguishes confirmed empty days from incomplete, conflicting, and wrong-day data', () => {
  const date = '2026-11-01', zone = 'America/New_York';
  const input = (status, spots) => ({ invitee_publisher_error: false, days: [{ date, status, spots }] });
  assert.deepEqual(parseAvailability(input('unavailable', []), date, zone), []);
  assert.throws(() => parseAvailability({}, date, zone));
  const sparseClosedDay = { invitee_publisher_error: false, today: '2026-10-28', availability_timezone: 'America/Los_Angeles', days: [] };
  assert.deepEqual(parseAvailability(sparseClosedDay, '2026-10-29', zone), []);
  assert.throws(() => parseAvailability({ invitee_publisher_error: false, days: [] }, date, zone));
  assert.throws(() => parseAvailability({ ...sparseClosedDay, invitee_publisher_error: true }, date, zone));
  assert.throws(() => parseAvailability(input('available', []), date, zone));
  assert.throws(() => parseAvailability({ ...input('unavailable', []), invitee_publisher_error: true }, date, zone));
  assert.throws(() => parseAvailability(input('unavailable', []), '2026-11-02', zone));
  const repeatedHour = [{ status: 'available', start_time: '2026-11-01T01:30:00-04:00' }, { status: 'available', start_time: '2026-11-01T01:30:00-05:00' }];
  assert.equal(parseAvailability(input('available', repeatedHour), date, zone).length, 2);
  assert.throws(() => parseAvailability(input('available', [{ status: 'available', start_time: '2026-11-02T01:00:00Z' }]), '2026-11-02', zone));
  assert.equal(localDate(new Date('2026-10-28T02:00:00Z'), zone), '2026-10-27');
  assert.throws(() => validateQuery('2026-02-30', zone));
  assert.throws(() => validateQuery('2026-10-28', 'invalid'));
});
test('shared storage persists across restarts and concurrent duplicates cannot both be saved', async t => {
  const root = await temporary(t), first = new Store(root); await first.init();
  const second = new Store(root); await second.init();
  const outcomes = await Promise.allSettled([first.add('Alex', 'https://calendly.com/alex/intro?a=1'), second.add('Alex again', 'https://calendly.com/alex/intro?a=2')]);
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  let db = await second.database(); assert.equal(db.calendars.length, 4);
  for (const row of db.calendars) await first.remove(row.id);
  await second.init(); assert.equal((await second.database()).calendars.length, 0);
});
test('public access hides original URLs, protects files, and cannot mutate the shared list', async t => {
  const app = await fixture(t);
  const list = await (await app.request('/api/calendars')).json();
  assert.equal(list.calendars.length, 3); assert.ok(list.calendars.every(row => !('url' in row)));
  for (const file of ['/app.js', '/data/calendars.json', '/data/session.key', '/lib/server.cjs', '/package.json']) assert.equal((await app.request(file)).status, 404);
  assert.equal((await app.request('/api/admin/calendars', { method: 'POST' })).status, 401);
  assert.equal((await app.request('/api/admin/check-link?url=https://calendly.com/a/b')).status, 401);
  assert.equal((await app.request('/')).status, 200);
  assert.equal((await app.request('/admin')).status, 200);
});
test('admin login, CSRF checks, duplicates, deletion, and logout revoke server-side sessions', async t => {
  const app = await fixture(t), login = await app.login();
  const headers = { Cookie: login.cookie, 'X-CSRF-Token': login.csrf, 'Content-Type': 'application/json' };
  const payload = JSON.stringify({ name: 'Test consultant', url: 'https://calendly.com/new-consultant/intro' });
  assert.equal((await app.request('/api/admin/calendars', { method: 'POST', headers: { Cookie: login.cookie, 'Content-Type': 'application/json' }, body: payload })).status, 403);
  assert.equal((await app.request('/api/admin/calendars', { method: 'POST', headers: { ...headers, Origin: 'https://other.test' }, body: payload })).status, 403);
  const add = await app.request('/api/admin/calendars', { method: 'POST', headers, body: payload }); assert.equal(add.status, 201);
  const { calendar } = await add.json();
  assert.equal((await app.request('/api/admin/calendars', { method: 'POST', headers, body: payload })).status, 409);
  const duplicate = await (await app.request('/api/admin/check-link?url=' + encodeURIComponent('https://www.calendly.com/new-consultant/intro?date=2026-11-09'), { headers })).json(); assert.equal(duplicate.duplicate, 'Test consultant');
  assert.equal((await app.request(`/api/admin/calendars/${calendar.id}`, { method: 'DELETE', headers })).status, 200);
  assert.equal((await app.request('/api/logout', { method: 'POST', headers })).status, 200);
  assert.equal((await app.request('/api/admin/check-link?url=https://calendly.com/a/b', { headers })).status, 401);
});
test('missing admin configuration fails closed; production cookies are secure', async t => {
  const disabled = await fixture(t, { password: '' });
  assert.equal((await disabled.request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: '' }) })).status, 503);
  const enabled = await fixture(t, { secureCookies: true });
  const response = await enabled.request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Max-Age=28800; Secure/);
});
test('changing the admin password invalidates existing sessions', async t => {
  const app = await fixture(t), login = await app.login();
  const replacement = await fixture(t, { dataDir: app.dataDir, password: 'different-password-of-sufficient-length' });
  const session = await (await replacement.request('/api/session', { headers: { Cookie: login.cookie } })).json();
  assert.equal(session.admin, false);
});
test('simultaneous viewers share a refresh; errors remain unknown; forced refresh respects cooldown', async t => {
  const root = await temporary(t), store = new Store(root); await store.init();
  let count = 0;
  const provider = { check: async item => { count++; await delay(20); if (item.name === 'Ben') throw new Error('Unavailable upstream'); return { times: [], duration: 15 }; } };
  const service = new Availability(store, provider), db = await store.database();
  const responses = await Promise.all([service.get(db, '2026-10-28', 'America/New_York'), service.get(db, '2026-10-28', 'America/New_York')]);
  assert.equal(count, 3); assert.equal(responses[0].calendars.find(item => item.name === 'Ben').status, 'error');
  const refreshed = await service.get(db, '2026-10-28', 'America/New_York', true); assert.equal(refreshed.cached, true); assert.equal(count, 3);
  const second = new Availability(new Store(root), provider);
  assert.equal((await second.get(db, '2026-10-28', 'America/New_York')).cached, true); assert.equal(count, 3);
});
async function waitForValue(read, predicate, timeout = 3000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const value = await read(); if (predicate(value)) return value; await delay(10); }
  throw new Error('Timed out waiting for the expected progress.');
}

test('32 calendars publish partial results before a slow calendar finishes; workers share batches', async t => {
  const root = await temporary(t), store = new Store(root); await store.init();
  for (let i = 0; i < 29; i++) await store.add(`Extra ${i}`, `https://calendly.com/person-${i}/intro`);
  let release; const slow = new Promise(resolve => { release = resolve; });
  let active = 0, peak = 0, count = 0, finished = false;
  const seen = new Set();
  const provider = { check: async row => {
    active++; peak = Math.max(peak, active); count++;
    assert.ok(!seen.has(row.id)); seen.add(row.id);
    try { if (row.name === 'Alena') await slow; return { times: [], duration: 15 }; } finally { active--; }
  } };
  const db = await store.database(), first = new Availability(store, provider), second = new Availability(store, provider);
  const work = first.get(db, '2026-10-28', 'America/New_York').then(result => { finished = true; return result; });
  try {
    const partial = await waitForValue(() => second.peek(db, '2026-10-28', 'America/New_York'), value => value.completed === 3);
    assert.equal(finished, false); assert.equal(partial.total, 32); assert.equal(partial.waiting, true);
    assert.equal(partial.calendars.filter(row => row.status === 'empty').length, 3);
    const otherViewer = await second.get(db, '2026-10-28', 'America/New_York');
    assert.equal(otherViewer.waiting, true); assert.equal(count, 4);
  } finally { release(); }
  let result = await work;
  assert.equal(result.completed, 4);
  while (result.waiting) result = await first.get(db, '2026-10-28', 'America/New_York');
  assert.equal(result.completed, 32); assert.equal(result.total, 32); assert.equal(count, 32); assert.ok(peak <= 4);
  const cached = await second.get(db, '2026-10-28', 'America/New_York', true);
  assert.equal(cached.cached, true); assert.equal(count, 32);
});

test('adding one calendar reuses the recent results for existing calendars', async t => {
  const root = await temporary(t), store = new Store(root); await store.init(); let count = 0;
  const service = new Availability(store, { check: async () => { count++; return { times: [], duration: 15 }; } });
  await service.get(await store.database(), '2026-10-28', 'UTC');
  const ids = (await store.database()).calendars.map(row => row.id);
  await store.add('New', 'https://calendly.com/new/intro');
  const result = await service.get(await store.database(), '2026-10-28', 'UTC');
  assert.equal(result.completed, 4); assert.equal(count, 4);
  assert.deepEqual(result.calendars.slice(0, 3).map(row => row.id), ids);
});

test('a timeout in one calendar leaves the remaining calendars checkable', async t => {
  const root = await temporary(t), store = new Store(root); await store.init();
  const service = new Availability(store, { check: async row => { if (row.name === 'Ben') throw new Error('This calendar took too long to respond.'); return { times: [], duration: 15 }; } });
  const result = await service.get(await store.database(), '2026-10-28', 'UTC');
  assert.equal(result.completed, 3); assert.equal(result.paused, undefined);
  assert.equal(result.calendars.filter(row => row.status === 'empty').length, 2);
  assert.equal(result.calendars.find(row => row.name === 'Ben').status, 'error');
});

test('upstream restrictions stop queued checks and enforce backoff across dates', async t => {
  const root = await temporary(t), store = new Store(root); await store.init();
  for (let i = 0; i < 8; i++) await store.add(`Extra ${i}`, `https://calendly.com/person-${i}/intro`);
  let count = 0;
  const service = new Availability(store, { check: async row => { count++; if (row.name === 'Alena') throw Object.assign(new Error('Calendly is limiting requests (HTTP 429).'), { stop: true }); return { times: [], duration: 15 }; } });
  const db = await store.database(), result = await service.get(db, '2026-10-28', 'UTC');
  assert.equal(result.paused, true); assert.equal(result.completed, 11); assert.equal(count, 4);
  assert.match(result.calendars[0].detail, /HTTP 429/);
  const later = await service.get(db, '2026-10-29', 'UTC', true);
  assert.equal(later.paused, true); assert.ok(later.retryAfter > 0); assert.equal(count, 4);
});

test('event metadata survives provider restarts and HTTP failures explain their status', async t => {
  const root = await temporary(t), store = new Store(root); await store.init();
  const previousFetch = global.fetch; let lookups = 0, ranges = 0;
  const calendar = { id: 'fixture', url: 'https://calendly.com/alena-theperfectfranchise/perfectfranchise_intro15min' };
  const signal = new AbortController().signal;
  try {
    global.fetch = async url => {
      if (String(url).includes('/lookup')) { lookups++; return Response.json({ uuid: '00000000-0000-0000-0000-000000000001', duration: 15 }); }
      ranges++; return Response.json({ invitee_publisher_error: false, days: [{ date: '2026-10-28', status: 'unavailable', spots: [] }] });
    };
    await new Calendly(store).check(calendar, '2026-10-28', 'UTC', signal);
    await new Calendly(store).check(calendar, '2026-10-28', 'UTC', signal);
    assert.equal(lookups, 1); assert.equal(ranges, 2);
    global.fetch = async () => new Response('', { status: 404 });
    await assert.rejects(() => new Calendly().check(calendar, '2026-10-28', 'UTC', signal), error => error.httpStatus === 404 && error.stop === false && /saved Calendly link/.test(error.message));
    global.fetch = async () => new Response('', { status: 503 });
    await assert.rejects(() => new Calendly().check(calendar, '2026-10-28', 'UTC', signal), /temporary server error \(HTTP 503\)/);
    global.fetch = async () => new Response('', { status: 429 });
    await assert.rejects(() => new Calendly().check(calendar, '2026-10-28', 'UTC', signal), error => error.stop === true && /HTTP 429/.test(error.message));
  } finally { global.fetch = previousFetch; }
});

test('read-only HTTP progress polling exposes finished rows without launching more checks', async t => {
  let release; const slow = new Promise(resolve => { release = resolve; }); let count = 0;
  const app = await fixture(t, { provider: { check: async row => { count++; if (row.name === 'Alena') await slow; return { times: [], duration: 15 }; } } });
  const query = new URLSearchParams({ date: localDate(new Date(), 'America/New_York'), timezone: 'America/New_York' });
  const before = await (await app.request('/api/availability?' + query + '&poll=1')).json();
  assert.equal(before.completed, 0); assert.equal(count, 0);
  const work = app.request('/api/availability?' + query);
  try {
    const partial = await waitForValue(async () => (await app.request('/api/availability?' + query + '&poll=1')).json(), value => value.completed === 2);
    assert.equal(partial.total, 3); assert.equal(count, 3);
  } finally { release(); }
  const result = await (await work).json(); assert.equal(result.completed, 3); assert.equal(result.waiting, false);
});
