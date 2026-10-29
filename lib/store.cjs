'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

const ORIGINALS = [
  ['Alena', 'alena-theperfectfranchise'], ['Ben', 'ben-theperfectfranchise'],
  ['Bill', 'bill-uoc']
];
function normalizeLink(input) {
  if (typeof input !== 'string' || input.length > 2048) throw new Error('Enter a Calendly event link.');
  let url;
  try { url = new URL(input.trim()); } catch { throw new Error('Enter a complete https://calendly.com/name/event link.'); }
  if (url.protocol !== 'https:' || !['calendly.com', 'www.calendly.com'].includes(url.hostname) ||
      url.username || url.password || url.port) throw new Error('Use an HTTPS Calendly event link.');
  let segments;
  try { segments = url.pathname.split('/').filter(Boolean).slice(0, 2).map(decodeURIComponent); }
  catch { throw new Error('This Calendly link is not valid.'); }
  if (segments.length !== 2 || segments.some(x => !/^[a-z0-9_-]{1,150}$/i.test(x))) {
    throw new Error('Use a specific event link, including both the name and event.');
  }
  const [profile, event] = segments.map(x => x.toLowerCase());
  return { profile, event, key: `${profile}/${event}`, url: `https://calendly.com/${profile}/${event}` };
}
class Store {
  constructor(root) { this.root = root; }
  file(name) { return path.join(this.root, name); }
  async init() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    await fs.chmod(this.root, 0o700);
    await this.lock('database', async () => {
      try { await fs.access(this.file('calendars.json')); }
      catch (e) {
        if (e.code !== 'ENOENT') throw e;
        await this.write('calendars.json', { revision: crypto.randomUUID(), calendars: ORIGINALS.map(([name, profile]) => ({
          id: crypto.randomUUID(), name, url: `https://calendly.com/${profile}/perfectfranchise_intro15min`
        })) });
      }
      try { await fs.writeFile(this.file('session.key'), crypto.randomBytes(48).toString('hex'), { flag: 'wx', mode: 0o600 }); }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
    });
    this.secret = await fs.readFile(this.file('session.key'), 'utf8');
    await this.database(); // Fail safely on damaged data; never silently reseed.
  }
  async read(name, fallback) {
    try { return JSON.parse(await fs.readFile(this.file(name), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
  }
  async write(name, value) {
    const temp = this.file(`.${name}.${crypto.randomUUID()}.tmp`);
    try {
      await fs.writeFile(temp, JSON.stringify(value) + '\n', { mode: 0o600 });
      await fs.rename(temp, this.file(name));
    } finally { await fs.unlink(temp).catch(() => {}); }
  }
  async lock(name, operation, waitMs = 4000) {
    const lock = this.file(`${name}.lock`), started = Date.now();
    while (true) {
      try { await fs.mkdir(lock); break; }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        // Batches are capped at 25 seconds; only abandoned locks age out.
        try { if (Date.now() - (await fs.stat(lock)).mtimeMs > 180000) await fs.rmdir(lock); }
        catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
        if (Date.now() - started >= waitMs) { const error = new Error('Another update is running. Try again shortly.'); error.status = 503; throw error; }
        await delay(50);
      }
    }
    try { return await operation(); } finally { await fs.rmdir(lock).catch(() => {}); }
  }
  async database() {
    const db = await this.read('calendars.json');
    if (!db || typeof db.revision !== 'string' || !Array.isArray(db.calendars) || db.calendars.length > 100) {
      throw new Error('The shared calendar file needs recovery from backup.');
    }
    const seen = new Set();
    for (const item of db.calendars) {
      if (typeof item.id !== 'string' || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 60) throw new Error('Invalid calendar data.');
      const key = normalizeLink(item.url).key;
      if (seen.has(key)) throw new Error('Duplicate calendar data.');
      seen.add(key);
    }
    return db;
  }
  async add(name, url) {
    const link = normalizeLink(url);
    if (typeof name !== 'string' || name.trim().length > 60) throw new Error('Use a display name of 60 characters or fewer.');
    name = name.trim() || link.profile.split('-')[0].replace(/^./, c => c.toUpperCase());
    return this.lock('database', async () => {
      const db = await this.database();
      const duplicate = db.calendars.find(item => normalizeLink(item.url).key === link.key);
      if (duplicate) { const error = new Error(`This calendar is already listed as ${duplicate.name}.`); error.status = 409; throw error; }
      if (db.calendars.length >= 100) throw new Error('This dashboard supports up to 100 calendars.');
      const item = { id: crypto.randomUUID(), name, url: link.url };
      db.calendars.push(item); db.revision = crypto.randomUUID();
      await this.write('calendars.json', db);
      return item;
    });
  }
  async remove(id) {
    return this.lock('database', async () => {
      const db = await this.database();
      if (!db.calendars.some(item => item.id === id)) { const error = new Error('This calendar was already removed.'); error.status = 404; throw error; }
      db.calendars = db.calendars.filter(item => item.id !== id); db.revision = crypto.randomUUID();
      await this.write('calendars.json', db);
    });
  }
}
module.exports = { Store, normalizeLink };
