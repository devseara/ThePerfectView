'use strict';
const { normalizeLink } = require('./store.cjs');
const ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Asia/Manila', 'UTC'];
function localDate(now, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  return ['year', 'month', 'day'].map(key => parts.find(p => p.type === key).value).join('-');
}
function validateQuery(date, timezone) {
  if (!ZONES.includes(timezone)) throw new Error('Choose a supported time zone.');
  const value = new Date(`${date}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(+value) || value.toISOString().slice(0, 10) !== date) throw new Error('Choose a valid date.');
  const today = localDate(new Date(), timezone);
  const max = new Date(`${today}T12:00:00Z`); max.setUTCDate(max.getUTCDate() + 365);
  if (date < today || date > max.toISOString().slice(0, 10)) throw new Error('Choose a date from today through the next 365 days.');
}
async function readJson(path, params, signal) {
  const url = new URL(path, 'https://calendly.com'); url.search = new URLSearchParams(params);
  let response;
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(12000)]);
  try {
    response = await fetch(url, { redirect: 'error', headers: { Accept: 'application/json' }, signal: requestSignal });
  } catch {
    const e = new Error(requestSignal.aborted ? 'This calendar took too long to respond. Try refreshing later.' : 'Calendly could not be reached. Try refreshing later.');
    e.stop = !requestSignal.aborted; throw e;
  }
  if (!response.ok) {
    await response.body?.cancel();
    const code = `HTTP ${response.status}`;
    const message = response.status === 429 ? `Calendly is limiting requests (${code}). Checks are paused for five minutes.`
      : [401, 403].includes(response.status) ? `Calendly restricted this check (${code}). Try again later.`
      : [404, 410].includes(response.status) ? `This event was not found (${code}). Check the saved Calendly link.`
      : response.status >= 500 ? `Calendly returned a temporary server error (${code}). Try Refresh later.`
      : `Calendly could not return this event’s availability (${code}). Try Refresh or check the saved link.`;
    const e = new Error(message); e.httpStatus = response.status;
    e.stop = [401, 403, 429].includes(response.status); throw e;
  }
  if (!(response.headers.get('content-type') || '').includes('application/json')) {
    await response.body?.cancel(); const e = new Error('Calendly returned an unexpected page. Try again later.'); e.stop = true; throw e;
  }
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length; if (size > 512 * 1024) throw new Error('Calendly returned an unexpected response.'); chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function parseAvailability(data, date, timezone) {
  if (!data || data.invitee_publisher_error !== false || !Array.isArray(data.days)) throw new Error('Calendly could not confirm this day’s availability.');
  // Calendly omits some closed dates entirely. Its public page displays no
  // times for this successful single-day response. Require the normal envelope
  // so malformed or failed responses cannot be mistaken for a closed day.
  if (data.days.length === 0 && /^\d{4}-\d{2}-\d{2}$/.test(data.today) && typeof data.availability_timezone === 'string') {
    try { new Intl.DateTimeFormat('en-US', { timeZone: data.availability_timezone }); }
    catch { throw new Error('Calendly could not confirm this day’s availability.'); }
    return [];
  }
  const matches = data.days.filter(day => day && day.date === date);
  if (matches.length !== 1 || !Array.isArray(matches[0].spots)) throw new Error('Calendly did not return the requested date.');
  const day = matches[0];
  if (day.status === 'unavailable' && day.spots.length === 0) return [];
  if (day.status !== 'available') throw new Error('Calendly did not confirm whether times are available.');
  const slots = day.spots.filter(spot => spot && spot.status === 'available');
  if (!slots.length) throw new Error('Calendly’s availability response was incomplete.');
  return [...new Set(slots.map(spot => {
    if (typeof spot.start_time !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(spot.start_time)) throw new Error('Calendly returned an unexpected time format.');
    const start = new Date(spot.start_time);
    if (Number.isNaN(+start) || localDate(start, timezone) !== date) throw new Error('Calendly returned a time outside the requested day.');
    return start.toISOString();
  }))].sort();
}
class Calendly {
  constructor(store) { this.store = store; this.events = new Map(); this.loaded = null; }
  async loadEvents() {
    if (!this.loaded) this.loaded = (async () => {
      if (!this.store) return;
      const saved = await this.store.read('event-cache.json', {});
      for (const [key, event] of Object.entries(saved)) {
        if (event.expires > Date.now() && typeof event.uuid === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(event.uuid)) this.events.set(key, event);
      }
    })();
    await this.loaded;
  }
  async saveEvents() {
    if (!this.store) return;
    await this.store.lock('event-cache', async () => {
      const saved = await this.store.read('event-cache.json', {});
      for (const [key, event] of this.events) if (!saved[key] || saved[key].expires < event.expires) saved[key] = event;
      const recent = Object.entries(saved).filter(([, event]) => event.expires > Date.now()).sort((a, b) => b[1].expires - a[1].expires).slice(0, 200);
      await this.store.write('event-cache.json', Object.fromEntries(recent));
    });
  }
  async check(calendar, date, timezone, signal) {
    await this.loadEvents();
    const link = normalizeLink(calendar.url);
    let event = this.events.get(link.key);
    if (!event || event.expires < Date.now()) {
      const data = await readJson('/api/booking/event_types/lookup', { profile_slug: link.profile, event_type_slug: link.event }, signal);
      if (!data || typeof data.uuid !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(data.uuid) || data.unavailability_reason) throw new Error('This Calendly event is unavailable or has changed.');
      event = { uuid: data.uuid, duration: Number.isFinite(data.duration) ? data.duration : null, expires: Date.now() + 3600000 };
      if (this.events.size > 200) this.events.clear();
      this.events.set(link.key, event);
      await this.saveEvents();
    }
    const data = await readJson(`/api/booking/event_types/${event.uuid}/calendar/range`, { timezone, range_start: date, range_end: date }, signal);
    return { times: parseAvailability(data, date, timezone), duration: event.duration };
  }
}
module.exports = { Calendly, ZONES, localDate, validateQuery, parseAvailability };
