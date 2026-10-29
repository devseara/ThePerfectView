'use strict';
// Use the original AbortController API so older iPhone browsers can cancel
// requests and enforce deadlines without AbortSignal.any/timeout support.
async function tpfRequestWithTimeout(operation, parentSignal, milliseconds) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  let timer, timedOut = false;
  parentSignal.addEventListener('abort', cancel, { once: true });
  try {
    if (parentSignal.aborted) {
      cancel();
      throw Object.assign(new Error('Request cancelled.'), { name: 'AbortError' });
    }
    timer = setTimeout(() => { timedOut = true; cancel(); }, milliseconds);
    return await operation(controller.signal);
  } catch (error) {
    if (timedOut) throw Object.assign(new Error('The request took too long.'), { name: 'TimeoutError' });
    throw error;
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener('abort', cancel);
  }
}
(() => {
  const THEME_KEY = 'tpv-theme';
  function applyTheme(value) {
    const theme = value === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.content = theme;
  }
  let savedTheme = 'dark';
  try { savedTheme = localStorage.getItem(THEME_KEY) || 'dark'; } catch {}
  applyTheme(savedTheme);
  function initialize() {
  const $ = id => document.getElementById(id);
  const adminPage = /^\/admin\/?$/.test(location.pathname);
  let addAfterLogin = adminPage && new URLSearchParams(location.search).get('add') === '1';
  if (addAfterLogin) history.replaceState(null, '', '/admin');
  const state = { admin: false, csrf: null, calendars: [], results: new Map(), loading: false, request: 0, controller: null, timer: null };
  const icons = {
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
    refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-2l2 3M4 16l2 3a7 7 0 0 0 12-2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    moon: '<path fill="currentColor" stroke="none" d="M20.5 14.1A8.8 8.8 0 0 1 9.9 3.5a9.2 9.2 0 1 0 10.6 10.6Z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 11h18m-11 5 2 2 4-4"/>',
    trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>'
  };
  function icon(name) {
    const node = document.createElement('span');
    node.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
    return node;
  }
  document.querySelectorAll('[data-icon]').forEach(node => node.replaceChildren(icon(node.dataset.icon)));
  function renderThemeControl() {
    const dark = document.documentElement.dataset.theme === 'dark';
    $('theme-toggle').setAttribute('aria-checked', String(dark));
    $('theme-toggle').title = dark ? 'Dark Mode · Switch to Light Mode' : 'Light Mode · Switch to Dark Mode';
    $('theme-icon').replaceChildren(icon(dark ? 'moon' : 'sun'));
  }
  $('theme-toggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch {}
    renderThemeControl();
  });
  window.addEventListener('storage', event => {
    if (event.key === THEME_KEY || event.key === null) {
      applyTheme(event.key === null ? 'dark' : event.newValue);
      renderThemeControl();
    }
  });
  renderThemeControl();

  function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
  function dateInZone(now, timezone) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    return ['year', 'month', 'day'].map(key => parts.find(p => p.type === key).value).join('-');
  }
  function plusDays(date, count) { const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + count); return value.toISOString().slice(0, 10); }
  function today() { return dateInZone(new Date(), $('tpf-zone').value); }
  function timeLabel(value) { return new Intl.DateTimeFormat('en-US', { timeZone: $('tpf-zone').value, hour: 'numeric', minute: '2-digit' }).format(new Date(value)); }
  function checkedLabel(value) { return new Intl.DateTimeFormat('en-US', { timeZone: $('tpf-zone').value, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(new Date(value)); }
  function dateControls() {
    $('tpf-date').min = today(); $('tpf-date').max = plusDays(today(), 365);
    $('today').setAttribute('aria-pressed', String($('tpf-date').value === today()));
    $('tomorrow').setAttribute('aria-pressed', String($('tpf-date').value === plusDays(today(), 1)));
    $('tpf-day-heading').textContent = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(`${$('tpf-date').value}T12:00:00Z`));
    $('tpf-time-note').textContent = `All times in ${$('tpf-zone').selectedOptions[0].textContent}`;
  }
  async function api(url, options = {}) {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(state.csrf ? { 'X-CSRF-Token': state.csrf } : {}), ...options.headers } });
    let data;
    try { data = await response.json(); } catch { throw new Error('The server did not respond correctly. Please try again.'); }
    if (!response.ok) {
      if (response.status === 401 && state.admin) { state.admin = false; updateAdmin(); }
      throw new Error(data.error || 'The request failed. Please try again.');
    }
    return data;
  }
  function updateAdmin() {
    const manage = adminPage && state.admin;
    $('tpf-add').hidden = !manage; $('logout').hidden = !manage;
    $('manage-link').hidden = manage; $('view-link').hidden = !manage;
    $('mode-label').textContent = manage ? 'Admin view' : 'Shared view';
    render();
  }
  function render() {
    const query = $('tpf-search').value.trim().toLowerCase(), only = $('tpf-available-only').checked;
    const people = state.calendars.filter(person => person.name.toLowerCase().includes(query) && (!only || state.results.get(person.id)?.status === 'available'));
    const fragment = document.createDocumentFragment();
    for (const person of people) {
      const result = state.results.get(person.id), status = result?.status || 'waiting';
      const row = element('article', `tpf-person${result?.pending ? ' is-loading' : ''}`);
      const head = element('div', 'tpf-person-head'), details = element('div');
      head.append(element('div', 'tpf-avatar', person.name.slice(0, 1).toUpperCase()));
      details.append(element('h3', '', person.name));
      const label = status === 'available' ? `${result.times.length} available` : status === 'empty' ? 'No times available' : status === 'error' ? 'Couldn’t check' : 'Waiting for availability';
      const rowLabel = result?.pending && status !== 'waiting' ? `${label} · Updating…` : label;
      details.append(element('div', `tpf-row-status${status === 'error' ? ' is-error' : status === 'available' ? '' : ' is-empty'}`, rowLabel));
      if (result?.checkedAt) {
        details.title = `Checked ${checkedLabel(result.checkedAt)}`;
        details.append(element('span', 'tpf-sr-only', `Checked ${checkedLabel(result.checkedAt)}`));
      }
      head.append(details); row.append(head);
      const times = element('div', 'tpf-times');
      if (status === 'available') {
        for (const time of result.times) { const slot = element('span', 'tpf-slot', timeLabel(time)); slot.title = new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeStyle: 'long', timeZone: $('tpf-zone').value }).format(new Date(time)); times.append(slot); }
      } else { times.append(element('span', 'tpf-empty', status === 'empty' ? 'No available times for this date.' : status === 'error' ? result.detail : 'Checking availability…')); }
      row.append(times);
      if (adminPage && state.admin) {
        const actions = element('div', 'tpf-row-actions'), trash = element('button', 'tpf-trash');
        trash.type = 'button'; trash.setAttribute('aria-label', `Delete ${person.name}`); trash.append(icon('trash'));
        trash.addEventListener('click', () => confirmDelete(person)); actions.append(trash); row.append(actions);
      }
      fragment.append(row);
    }
    if (!people.length) fragment.append(element('div', 'tpf-no-results', state.calendars.length ? 'No calendars match these filters.' : state.loading ? 'Loading calendars…' : 'No calendars have been added yet.'));
    $('tpf-people').replaceChildren(fragment);
    $('tpf-count').textContent = `${people.length} of ${state.calendars.length} calendars`;
    $('tpf-calendar-count').textContent = `${state.calendars.length} calendar${state.calendars.length === 1 ? '' : 's'}${adminPage && state.admin ? ' · Add another with +' : ''}`;
  }
  async function loadList() { const data = await api('/api/calendars'); state.calendars = data.calendars; render(); }
  function applyAvailability(data) {
    state.calendars = data.calendars.map(({ id, name }) => ({ id, name }));
    state.results = new Map(data.calendars.map(item => [item.id, item]));
    const completed = data.completed ?? data.calendars.filter(row => row.status !== 'waiting').length;
    $('check-progress').hidden = !data.waiting;
    $('check-progress-label').textContent = `${completed} of ${data.total ?? data.calendars.length} calendars checked`;
    $('check-progress-meter').max = Math.max(1, data.total ?? data.calendars.length);
    $('check-progress-meter').value = completed;
    if (data.paused) {
      $('tpf-refresh-status').textContent = 'Checks are temporarily paused. Please try Refresh later; pauses can last five minutes.';
    } else if (data.waiting) {
      $('tpf-refresh-status').textContent = `Checking availability · ${completed} of ${data.total} checked. Results appear as they finish.`;
    } else {
      const note = data.cached ? ' Using a recent shared check.' : '';
      $('tpf-refresh-status').textContent = data.checkedAt ? `Updated ${checkedLabel(data.checkedAt)}.${note}` : 'Availability check completed.';
    }
    $('tpf-error').textContent = data.calendars.some(row => row.status === 'error') ? 'Some calendars could not be checked. See the reason in each row; other results are still available.' : '';
    render();
  }
  async function loadAvailability(force = false, clear = false) {
    state.controller?.abort();
    const id = ++state.request, controller = new AbortController(); state.controller = controller;
    state.loading = true; if (clear) state.results.clear();
    $('tpf-refresh').disabled = true; $('refresh-label').textContent = 'Refreshing';
    $('check-progress').hidden = false; $('check-progress-label').textContent = 'Starting availability check…';
    $('check-progress-meter').value = 0; $('check-progress-meter').max = Math.max(1, state.calendars.length);
    $('tpf-error').textContent = ''; $('tpf-refresh-status').textContent = 'Checking availability…'; render();
    const params = new URLSearchParams({ date: $('tpf-date').value, timezone: $('tpf-zone').value, refresh: force ? '1' : '0' });
    const pollParams = new URLSearchParams(params); pollParams.set('poll', '1');
    const started = Date.now();
    try {
      while (id === state.request && !controller.signal.aborted) {
        // Keep each HTTP request bounded to a small batch. A separate read-only
        // poll exposes fast rows even while a slower row in that batch is pending.
        let active = true, pollTimer;
        const poll = async () => {
          try {
            const progress = await tpfRequestWithTimeout(signal => api(`/api/availability?${pollParams}`, { signal }), controller.signal, 5000);
            if (active && id === state.request && !controller.signal.aborted) applyAvailability(progress);
          } catch {} // The batch response is authoritative for network failures.
          finally { if (active && id === state.request && !controller.signal.aborted) pollTimer = setTimeout(poll, 1000); }
        };
        pollTimer = setTimeout(poll, 700);
        let data;
        try {
          data = await tpfRequestWithTimeout(signal => api(`/api/availability?${params}`, { signal }), controller.signal, 40000);
        } finally { active = false; clearTimeout(pollTimer); }
        if (id !== state.request || controller.signal.aborted) return;
        applyAvailability(data);
        if (!data.waiting || data.paused) break;
        if (Date.now() - started > 150000) throw new Error('The check is taking too long. Completed rows remain visible; use Refresh to continue.');
        await new Promise(resolve => setTimeout(resolve, Math.min(2000, Math.max(200, (data.retryAfter || 0.25) * 1000))));
      }
    } catch (e) {
      if (controller.signal.aborted || id !== state.request) return;
      $('tpf-error').textContent = e.name === 'TimeoutError' ? 'The server took too long to respond. Use Refresh to continue checking.' : e.message;
      $('tpf-refresh-status').textContent = 'Check interrupted. Completed results remain visible; other calendars are unknown.';
      state.results = new Map(state.calendars.map(person => {
        const row = state.results.get(person.id);
        if (row && row.status !== 'waiting') return [person.id, { ...row, pending: false }];
        return [person.id, { ...person, status: 'error', pending: false, detail: 'This calendar was not checked. Use Refresh to continue.' }];
      }));
    } finally {
      if (id === state.request) {
        state.loading = false; $('check-progress').hidden = true;
        $('tpf-refresh').disabled = false; $('refresh-label').textContent = 'Refresh'; render();
      }
    }
  }
  function chooseDate(value) { $('tpf-date').value = value; dateControls(); loadAvailability(false, true); }
  $('today').addEventListener('click', () => chooseDate(today()));
  $('tomorrow').addEventListener('click', () => chooseDate(plusDays(today(), 1)));
  $('tpf-date').addEventListener('change', () => { if ($('tpf-date').reportValidity()) chooseDate($('tpf-date').value); });
  let previousZone = $('tpf-zone').value;
  $('tpf-zone').addEventListener('change', () => {
    const wasToday = $('tpf-date').value === dateInZone(new Date(), previousZone);
    previousZone = $('tpf-zone').value;
    try { localStorage.setItem('tpv-timezone', previousZone); } catch {}
    chooseDate(wasToday || $('tpf-date').value < today() ? today() : $('tpf-date').value);
  });
  $('tpf-search').addEventListener('input', render); $('tpf-available-only').addEventListener('change', render);
  $('tpf-refresh').addEventListener('click', () => loadAvailability(true));
  $('manage-link').addEventListener('click', event => { if (adminPage) { event.preventDefault(); $('login-dialog').showModal(); } });
  $('login-cancel').addEventListener('click', () => $('login-dialog').close());
  $('login-form').addEventListener('submit', async event => {
    event.preventDefault(); $('login-submit').disabled = true; $('login-error').textContent = '';
    try {
      const data = await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('password').value }) });
      state.admin = true; state.csrf = data.csrf; $('password').value = '';
      const shouldAdd = addAfterLogin; addAfterLogin = false;
      $('login-dialog').close(); updateAdmin();
      if (shouldAdd) openAddDialog();
    }
    catch (e) { $('login-error').textContent = e.message; }
    finally { $('login-submit').disabled = false; }
  });
  $('login-dialog').addEventListener('close', () => { addAfterLogin = false; });
  $('logout').addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST' }); state.admin = false; state.csrf = null; updateAdmin(); }
    catch (e) { $('tpf-error').textContent = e.message; }
  });
  let checkTimer, checkVersion = 0, validLink = '';
  function openAddDialog() {
    $('tpf-add-form').reset(); validLink = ''; checkVersion++;
    $('tpf-add-error').textContent = ''; $('tpf-add-status').textContent = ''; $('tpf-add-submit').disabled = true; $('tpf-add-dialog').showModal();
  }
  $('tpf-add').addEventListener('click', () => {
    if (!adminPage) return;
    if (!state.admin) { addAfterLogin = true; $('login-dialog').showModal(); return; }
    openAddDialog();
  });
  $('tpf-add-cancel').addEventListener('click', () => $('tpf-add-dialog').close());
  $('tpf-new-url').addEventListener('input', () => {
    clearTimeout(checkTimer); validLink = ''; $('tpf-add-submit').disabled = true;
    const version = ++checkVersion, value = $('tpf-new-url').value.trim();
    $('tpf-add-error').textContent = ''; $('tpf-add-status').textContent = value ? 'Checking link…' : '';
    if (!value) return;
    checkTimer = setTimeout(async () => {
      try {
        const data = await api(`/api/admin/check-link?${new URLSearchParams({ url: value })}`);
        if (version !== checkVersion) return;
        $('tpf-add-status').textContent = '';
        if (data.duplicate) $('tpf-add-error').textContent = `This calendar is already listed as ${data.duplicate}.`;
        else { validLink = value; $('tpf-add-status').textContent = 'Ready to add this calendar.'; $('tpf-add-submit').disabled = false; }
      } catch (e) { if (version === checkVersion) { $('tpf-add-status').textContent = ''; $('tpf-add-error').textContent = e.message; } }
    }, 250);
  });
  $('tpf-add-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!validLink || validLink !== $('tpf-new-url').value.trim()) return;
    $('tpf-add-submit').disabled = true;
    try { await api('/api/admin/calendars', { method: 'POST', body: JSON.stringify({ url: validLink, name: $('tpf-new-name').value }) }); $('tpf-add-dialog').close(); await loadList(); await loadAvailability(false); }
    catch (e) { $('tpf-add-error').textContent = e.message; $('tpf-add-status').textContent = ''; }
    finally { $('tpf-add-submit').disabled = false; }
  });
  let deleteTarget;
  function confirmDelete(person) { deleteTarget = person; $('tpf-delete-detail').textContent = `${person.name} will be removed from the shared view for everyone.`; $('delete-error').textContent = ''; $('tpf-delete-dialog').showModal(); }
  $('tpf-delete-no').addEventListener('click', () => $('tpf-delete-dialog').close());
  $('tpf-delete-yes').addEventListener('click', async () => {
    if (!deleteTarget) return; $('tpf-delete-yes').disabled = true;
    try { await api(`/api/admin/calendars/${deleteTarget.id}`, { method: 'DELETE' }); $('tpf-delete-dialog').close(); await loadList(); await loadAvailability(false); }
    catch (e) { $('delete-error').textContent = e.message; }
    finally { $('tpf-delete-yes').disabled = false; }
  });
  async function start() {
    try { const saved = localStorage.getItem('tpv-timezone'); if ([...$('tpf-zone').options].some(option => option.value === saved)) $('tpf-zone').value = saved; } catch {}
    previousZone = $('tpf-zone').value; $('tpf-date').value = today(); dateControls();
    try {
      const [session] = await Promise.all([api('/api/session'), loadList()]);
      state.admin = session.admin; state.csrf = session.csrf; updateAdmin();
      if (adminPage && !state.admin) { if (!session.configured) $('login-error').textContent = 'Add ADMIN_PASSWORD (at least 16 characters) in cPanel, then restart the app.'; $('login-dialog').showModal(); }
      else if (addAfterLogin && state.admin) { addAfterLogin = false; openAddDialog(); }
    } catch (e) { $('tpf-error').textContent = e.message; }
    await loadAvailability();
  }
  start();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
