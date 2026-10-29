# The Perfect View

A shared availability dashboard for public Calendly booking links. Version **1.1.1** includes progressive availability loading and the iPhone browser compatibility fix.

## Included

- Complete Node.js server and browser application, with no npm dependencies.
- Dark/Light Mode, date selection, six display timezones, search, filters, and Refresh.
- Admin sign-in to add or delete calendars; public viewers see availability only.
- Duplicate-link checking and a Yes/No delete confirmation.
- Progressive results in batches of four, shared caching, and clear failure messages.
- Mobile layout and request cancellation that works without `AbortSignal.any()` or `AbortSignal.timeout()` in the browser.
- Automated tests, cPanel instructions, and deployment ZIPs.

Times are display-only. The application does not create bookings or send owner messages.

## Deploy on cPanel

Use Node.js **22 or newer**, Production mode, and `app.js` as the startup file.

- [Complete cPanel ZIP](downloads/perfect-view-cpanel.zip)
- [Cumulative availability and phone update](downloads/perfect-view-performance-update.zip)
- [Phone-only update for an existing 1.1.0 installation](downloads/perfect-view-phone-update.zip)
- [Full installation instructions](INSTALL-CPANEL.txt)
- [Cumulative update instructions](UPDATE-PERFORMANCE.txt)
- [Phone update instructions](UPDATE-PHONE.txt)

For the existing hosting account, extract the appropriate ZIP into `/home5/eitrorgi/perfect-view`. Keep `app.js` directly inside that application root. Server updates require restarting the Node.js application; the phone-only update changes public files and does not require a restart.

Set `ADMIN_PASSWORD` to your own passphrase of at least 16 characters and set `PUBLIC_ORIGIN` to the site's HTTPS origin in cPanel. Passwords belong in hosting configuration, never in this repository.

## Run locally

```sh
node app.js
```

The server defaults to `http://127.0.0.1:3000`. Administration is disabled until `ADMIN_PASSWORD` is configured. Use a separate `DATA_DIR` when testing to keep production data separate.

Run the automated tests with:

```sh
node --test test/*.test.cjs
```

See [validation details](VALIDATION.txt) for what was checked and the limits of local testing.

## Saved calendars and backups

The **31 public consultant links supplied for this project**, excluding Brandon, are in [CONSULTANT-LINKS.txt](CONSULTANT-LINKS.txt). This is a reference list and is not imported automatically.

The live list with its display names and IDs is stored on cPanel in `data/calendars.json`. This repository contains the application source, not a copy of that live database. Download and keep a separate private backup of `data/calendars.json` when backing up or moving the live site.

Passwords, environment files, sessions, availability caches, and runtime data are excluded from Git. Existing saved calendars are preserved when installing code updates. A fresh installation starts with Alena, Ben, and Bill; add other consultants through the admin page.

## Availability source

The server reads the undocumented interfaces used by Calendly's public booking pages. These can change or restrict access and may require maintenance. Availability is a snapshot and can change after checking. Public reads may be logged by Calendly.

See [technical notes](README.txt) for configuration, storage, and authentication details. Earlier theme-update guides are retained as historical documentation; use the current instructions linked above for deployment.
