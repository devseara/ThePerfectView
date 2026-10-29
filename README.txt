THE PERFECT VIEW

A shared, view-only availability dashboard for public Calendly event links.
Built for the existing cPanel/CloudLinux Node.js 22 application with app.js as
the Passenger startup file. See INSTALL-CPANEL.txt for the exact upload steps.

FEATURES
- Starter list for a new installation: Alena, Ben, Bill; up to 100 saved event links.
- One persistent shared list, independent of browser storage.
- Today/Tomorrow/date selection, search, available-only filter, six timezones.
- Phone layout with larger touch targets; refresh works without the newer
  AbortSignal.any/timeout browser APIs.
- Display-only time labels; no Calendly navigation or booking operations.
- Refresh with a checked timestamp, persistent shared cache, coordinated workers.
- Admin sign-in, duplicate checks, add, delete confirmation, logout.
- Light/Dark switch with sun/moon icons, a saved visitor preference, and dark default.
- A floating + visible only on the signed-in admin page; hidden in shared view.
- Public viewers receive names and availability, not source booking URLs.
- No external fonts, CDN scripts, browser automation, npm dependencies, or database
  service. Server storage uses private JSON files with locks and atomic writes.

CONFIGURATION
NODE_ENV=production (provided by cPanel Production mode)
ADMIN_PASSWORD=your own passphrase of 16-512 characters (required for admin only)
PUBLIC_ORIGIN=https://view.eitr-origin.online (recommended; exact origin)
DATA_DIR=optional absolute directory; defaults to this app's data folder
PORT=provided by the runtime when required; defaults to 3000

ADMIN
Passwords are compared with scrypt-derived keys. Sessions are random, expire in
eight hours, and are revoked on logout. Cookies are HttpOnly, SameSite=Strict,
and Secure in Production mode. POST/DELETE admin requests check session, origin,
and CSRF token. Sign-in attempts are limited across workers. Changing the password
invalidates existing sessions. There is no default admin password in the archive.

DATA
Never expose the application/data directory through a separate static web root.
The application only serves an explicit list of three public files; internal
code, tests, configuration, and data files are not available through its routes.
The shipped data/.htaccess adds a denial for Apache if applicable, but the intended
application root is outside public_html. The app creates private data permissions.
An invalid shared-list file produces an error instead of silently replacing it.

AVAILABILITY
The application makes only unauthenticated HTTPS GET requests to calendly.com.
Submitted URLs are normalized into validated event/profile slugs; arbitrary
hosts, credentials, custom ports, and arbitrary server request URLs are rejected.
The provider reads the public event lookup and calendar/range data interfaces.
These endpoints are undocumented and are not the supported authenticated API.
Unknown data, calendar errors, and failed requests remain error states.
Confirmed unavailable days and valid empty single-day responses are shown as
no times. The latter matches the public booking page for omitted closed dates.
HTTP errors include their status code; timeouts do not stop other calendars.

Up to four public checks run at once. Each HTTP batch handles at most four
calendars, with 12-second upstream request deadlines and a 25-second batch limit.
The frontend requests successive batches and reads partial progress every second.
Every completed calendar is saved in a shared atomic snapshot immediately.
A run is limited to two minutes; the client stops after about 150 seconds.
Access restrictions/network outages stop queued requests and pause new batches
for five minutes. A single calendar timeout does not stop the other checks.
Public data is not accessed through authenticated accounts.

The persistent cache stores at most 30 recent date/timezone/list combinations.
Normal loads reuse results under 60 seconds old; Refresh respects a 30-second
minimum. Successful recent rows survive list revisions, avoiding needless
rechecks when adding one calendar. Event UUID/duration lookups persist for one
hour across Passenger restarts; actual availability is refreshed separately.
Multiple Passenger workers share storage and a global batch lock. Abandoned
locks expire after three minutes. Poll-only requests never contact Calendly.

The dashboard is not a reservation. A displayed time may be booked after checking.
No booking forms, invitations, emails, webhooks, or owner messages are submitted.
Public requests may still appear in Calendly logs/analytics.

DEVELOPMENT AND CHECKS
Node.js 22+, no dependencies to install.
Start: node app.js
Tests: node --test test/*.test.cjs
For local testing, use a separate DATA_DIR and non-production mode.
Keep test passwords and runtime data out of any deployment ZIP.

The deployment archive is manually uploaded through the user's cPanel account.
Local tests and preview do not by themselves verify the deployed cPanel app.
