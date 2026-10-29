'use strict';
const crypto = require('node:crypto');
const CACHE_FILE = 'availability-v2.json';
const BACKOFF_FILE = 'availability-backoff.json';
const BATCH_SIZE = 4;
const RUN_LIMIT = 120000;
const isKnown = row => ['available', 'empty'].includes(row.status);
const isFresh = (job, age) => job?.complete && Date.now() - Date.parse(job.checkedAt) < age && job.calendars.every(row => Date.now() - Date.parse(row.checkedAt || row.attemptedAt || job.checkedAt) < age);
class Availability {
  constructor(store, provider) { this.store = store; this.provider = provider; this.pending = new Map(); }
  key(db, date, timezone) { return crypto.createHash('sha256').update(`${db.revision}|${date}|${timezone}`).digest('hex'); }
  empty(db, date, timezone) {
    return { date, timezone, complete: false, calendars: db.calendars.map(({ id, name }) => ({ id, name, status: 'waiting', pending: true })) };
  }
  view(job, extra = {}) {
    const completed = job.calendars.filter(row => !row.pending && row.status !== 'waiting').length;
    return { ...job, waiting: !job.complete, completed, total: job.calendars.length, retryAfter: job.complete ? 0 : 0.25, ...extra };
  }
  async peek(db, date, timezone) {
    const all = await this.store.read(CACHE_FILE, {});
    return this.view(all[this.key(db, date, timezone)] || this.empty(db, date, timezone));
  }
  async get(db, date, timezone, force = false) {
    const key = this.key(db, date, timezone);
    if (this.pending.has(key)) return this.pending.get(key);
    const action = this.collect(key, db, date, timezone, force).finally(() => this.pending.delete(key));
    this.pending.set(key, action); return action;
  }
  async collect(key, db, date, timezone, force) {
    const freshness = force ? 30000 : 60000;
    const allBefore = await this.store.read(CACHE_FILE, {}), before = allBefore[key];
    if (isFresh(before, freshness)) {
      return this.view(before, { cached: true, retryAfter: Math.max(0, Math.ceil((30000 - (Date.now() - Date.parse(before.checkedAt))) / 1000)) });
    }
    try {
      return await this.store.lock('availability-batch', async () => {
        let all = await this.store.read(CACHE_FILE, {}), job = all[key];
        if (isFresh(job, freshness)) return this.view(job, { cached: true });
        const backoff = await this.store.read(BACKOFF_FILE, { until: 0 });
        if (backoff.until > Date.now()) {
          const paused = job || this.empty(db, date, timezone);
          return this.view({ ...paused, complete: true, calendars: paused.calendars.map(row => row.pending ? {
            id: row.id, name: row.name, status: 'error', pending: false, detail: 'Checks are temporarily paused. Try refreshing later.'
          } : row) }, { paused: true, stale: true, retryAfter: Math.ceil((backoff.until - Date.now()) / 1000) });
        }
        if (!job || job.complete) {
          // Reuse per-calendar results across list changes; adding one link should
          // not force another network request for every existing consultant.
          const previous = new Map();
          for (const saved of Object.values(all)) {
            if (saved.date !== date || saved.timezone !== timezone) continue;
            for (const row of saved.calendars) {
              if (!isKnown(row) || !row.checkedAt) continue;
              if (!previous.has(row.id) || row.checkedAt > previous.get(row.id).checkedAt) previous.set(row.id, row);
            }
          }
          job = { date, timezone, jobId: crypto.randomUUID(), startedAt: new Date().toISOString(), complete: false, calendars: db.calendars.map(({ id, name }) => {
            const row = previous.get(id), fresh = row && Date.now() - Date.parse(row.checkedAt) < freshness;
            return row ? { ...row, id, name, pending: !fresh } : { id, name, status: 'waiting', pending: true };
          }) };
        }
        const persist = async () => {
          job.updatedAt = new Date().toISOString();
          all[key] = job;
          all = Object.fromEntries(Object.entries(all).sort((a, b) => (b[1].updatedAt || '').localeCompare(a[1].updatedAt || '')).slice(0, 30));
          await this.store.write(CACHE_FILE, all);
        };
        const finishPending = detail => {
          job.calendars = job.calendars.map(row => row.pending ? { id: row.id, name: row.name, status: 'error', pending: false, detail } : row);
        };
        if (Date.now() - Date.parse(job.startedAt) > RUN_LIMIT) {
          finishPending('This check took too long. Refresh to try again.');
        }
        await persist();
        const selected = job.calendars.map((row, position) => ({ row, position })).filter(item => item.row.pending).slice(0, BATCH_SIZE);
        const remaining = Math.max(1, RUN_LIMIT - (Date.now() - Date.parse(job.startedAt)));
        const controller = new AbortController();
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(Math.min(25000, remaining))]);
        let stop = false, savedProgress = Promise.resolve();
        const outcomes = await Promise.allSettled(selected.map(async ({ row, position }) => {
          const calendar = db.calendars.find(item => item.id === row.id);
          let result;
          try {
            const value = await this.provider.check(calendar, date, timezone, signal);
            result = { id: row.id, name: row.name, checkedAt: new Date().toISOString(), status: value.times.length ? 'available' : 'empty', pending: false, ...value };
          } catch (error) {
            if (error.stop) { stop = true; controller.abort(); }
            result = { id: row.id, name: row.name, attemptedAt: new Date().toISOString(), status: 'error', pending: false,
              detail: error.stop ? error.message : stop ? 'Checks are temporarily paused. Try refreshing later.' : signal.aborted ? 'This calendar took too long to respond. Try refreshing later.' : error instanceof SyntaxError ? 'Calendly returned an unreadable response.' : (error.message || 'Could not check availability.') };
          }
          job.calendars[position] = result;
          // Serialize atomic snapshots so a slower disk write cannot erase a
          // newer result. Poll requests read these without waiting for the batch.
          savedProgress = savedProgress.then(persist);
          await savedProgress;
        }));
        const failedWrite = outcomes.find(outcome => outcome.status === 'rejected');
        if (failedWrite) throw failedWrite.reason;
        await savedProgress;
        if (stop) {
          finishPending('Checks are temporarily paused by Calendly. Try refreshing later.');
          job.paused = true;
          await this.store.write(BACKOFF_FILE, { until: Date.now() + 300000 });
        }
        if (Date.now() - Date.parse(job.startedAt) >= RUN_LIMIT) finishPending('This check took too long. Refresh to try again.');
        job.complete = job.calendars.every(row => !row.pending);
        if (job.complete) job.checkedAt = new Date().toISOString();
        await persist();
        return this.view(job, { cached: false, retryAfter: stop ? 300 : job.complete ? 30 : 0.25 });
      }, 100);
    } catch (error) {
      if (error.status !== 503) throw error;
      const progress = await this.peek(db, date, timezone);
      return { ...progress, waiting: true, retryAfter: 1, cached: true };
    }
  }
}
module.exports = { Availability };
