'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { Store, normalizeLink } = require('./store.cjs');
const { Calendly, validateQuery } = require('./calendly.cjs');
const { Availability } = require('./availability.cjs');
const scrypt = promisify(crypto.scrypt);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = (status, message) => Object.assign(new Error(message), { status });

async function createApplication(options = {}) {
  const store = options.store || new Store(options.dataDir || process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
  await store.init();
  const password = options.password ?? process.env.ADMIN_PASSWORD ?? '';
  const enabled = password.length >= 16 && password.length <= 512;
  const secure = options.secureCookies ?? process.env.NODE_ENV === 'production';
  const origin = options.publicOrigin ?? process.env.PUBLIC_ORIGIN ?? '';
  const authHash = enabled ? await scrypt(password, store.secret, 32) : null;
  const epoch = enabled ? digest(authHash) : '';
  const availability = new Availability(store, options.provider || new Calendly(store));
  const files = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']], ['/admin', ['index.html', 'text/html; charset=utf-8']],
    ['/admin/', ['index.html', 'text/html; charset=utf-8']], ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
    ['/client.js', ['client.js', 'text/javascript; charset=utf-8']]
  ]);
  function cookie(value, clear = false) {
    return `tpv_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : 28800}${secure ? '; Secure' : ''}`;
  }
  async function session(req) {
    if (!enabled) return null;
    const token = /(?:^|;\s*)tpv_session=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    if (!token) return null;
    const sessions = await store.read('sessions.json', {}), key = digest(token), value = sessions[key];
    return value && value.expires > Date.now() && value.epoch === epoch ? { ...value, key } : null;
  }
  function verifyOrigin(req) {
    let received;
    try { received = new URL(req.headers.origin); } catch { throw fail(403, 'Reload this page before trying again.'); }
    if (origin ? received.origin !== new URL(origin).origin : received.host !== req.headers.host || !['http:', 'https:'].includes(received.protocol)) {
      throw fail(403, 'This request did not come from your dashboard.');
    }
  }
  async function admin(req, mutation = false) {
    const value = await session(req);
    if (!value) throw fail(401, 'Sign in to manage calendars.');
    if (mutation) {
      verifyOrigin(req);
      if (req.headers['x-csrf-token'] !== value.csrf) throw fail(403, 'Your session changed. Reload and sign in again.');
    }
    return value;
  }
  async function body(req) {
    if (!(req.headers['content-type'] || '').startsWith('application/json')) throw fail(415, 'Send a JSON request.');
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 8192) throw fail(413, 'The request is too large.'); chunks.push(chunk); }
    try { const result = JSON.parse(Buffer.concat(chunks)); if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error(); return result; }
    catch { throw fail(400, 'The request could not be read.'); }
  }
  function json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://local.invalid');
      if (['GET', 'HEAD'].includes(req.method) && files.has(url.pathname)) {
        const [name, type] = files.get(url.pathname);
        const content = await fs.readFile(path.join(__dirname, '..', 'public', name));
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' }); res.end(req.method === 'HEAD' ? undefined : content); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/session') {
        const current = await session(req); json(res, 200, { admin: !!current, configured: enabled, csrf: current?.csrf || null }); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/login') {
        verifyOrigin(req);
        if (!enabled) throw fail(503, 'Add ADMIN_PASSWORD (at least 16 characters) in cPanel, then restart the app.');
        const input = await body(req);
        if (typeof input.password !== 'string' || input.password.length > 512) throw fail(400, 'Enter your admin password.');
        // A shared limit also covers Passenger workers; no untrusted proxy IP headers.
        await store.lock('login', async () => {
          const attempts = (await store.read('login-attempts.json', [])).filter(time => time > Date.now() - 600000);
          if (attempts.length >= 20) throw fail(429, 'Too many sign-in attempts. Wait 10 minutes before trying again.');
          attempts.push(Date.now()); await store.write('login-attempts.json', attempts);
        });
        const candidate = await scrypt(input.password, store.secret, 32);
        if (!crypto.timingSafeEqual(candidate, authHash)) throw fail(401, 'The password is incorrect.');
        const token = crypto.randomBytes(32).toString('base64url'), csrf = crypto.randomBytes(24).toString('base64url');
        await store.lock('sessions', async () => {
          let sessions = await store.read('sessions.json', {});
          sessions = Object.fromEntries(Object.entries(sessions).filter(([, value]) => value.expires > Date.now() && value.epoch === epoch).slice(-9));
          sessions[digest(token)] = { csrf, epoch, expires: Date.now() + 28800000 };
          await store.write('sessions.json', sessions);
        });
        res.setHeader('Set-Cookie', cookie(token)); json(res, 200, { admin: true, csrf }); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/logout') {
        const current = await admin(req, true);
        await store.lock('sessions', async () => { const sessions = await store.read('sessions.json', {}); delete sessions[current.key]; await store.write('sessions.json', sessions); });
        res.setHeader('Set-Cookie', cookie('', true)); json(res, 200, { ok: true }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/calendars') {
        const db = await store.database(); json(res, 200, { calendars: db.calendars.map(({ id, name }) => ({ id, name })) }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/availability') {
        const date = url.searchParams.get('date'), timezone = url.searchParams.get('timezone');
        try { validateQuery(date, timezone); } catch (e) { throw fail(400, e.message); }
        const db = await store.database();
        const value = url.searchParams.get('poll') === '1' ? await availability.peek(db, date, timezone) : await availability.get(db, date, timezone, url.searchParams.get('refresh') === '1');
        json(res, 200, value); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/admin/check-link') {
        await admin(req);
        let link; try { link = normalizeLink(url.searchParams.get('url')); } catch (e) { throw fail(400, e.message); }
        const db = await store.database(), duplicate = db.calendars.find(item => normalizeLink(item.url).key === link.key);
        json(res, 200, { duplicate: duplicate?.name || null, canonical: link.url }); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/calendars') {
        await admin(req, true); const input = await body(req);
        let result;
        try { result = await store.add(input.name || '', input.url); }
        catch (e) { if (!e.code && !e.status) e.status = 400; throw e; }
        json(res, 201, { calendar: { id: result.id, name: result.name } }); return;
      }
      if (req.method === 'DELETE' && /^\/api\/admin\/calendars\/[a-f0-9-]{36}$/.test(url.pathname)) {
        await admin(req, true); await store.remove(url.pathname.split('/').at(-1)); json(res, 200, { ok: true }); return;
      }
      throw fail(404, 'Not found.');
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      const status = error.status || 500;
      if (status >= 500) console.error('Request failed:', error.code || 'application_error');
      json(res, status, { error: status === 500 ? 'The server could not complete this request. Try again shortly.' : error.message });
    }
  });
  server.requestTimeout = 75000;
  server.headersTimeout = 15000;
  return { server, store, availability };
}

module.exports = { createApplication };
