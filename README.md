# Ledger — Employee Attendance App

A multi-tenant attendance system built on **Cloudflare Workers** (serverless, runs on Cloudflare's edge network) with **D1** (SQLite) for persistent storage. Deploys to a live `*.workers.dev` URL (or your own domain) in a few commands.

## What's included
- Check-in / check-out with timestamps
- Employee directory (add / edit / delete, optional login creation)
- Daily / weekly / monthly attendance history
- Reports: attendance rate, tardiness rate, absence rate, per-employee breakdown
- Geolocation capture on check-in/out + office geofence verification, plus IP logging
- Admin vs. employee roles, cookie-based sessions
- Daily scheduled job that auto-marks no-shows as absent and raises late-arrival notifications
- Export to CSV, Excel (.xlsx), and PDF (print-to-PDF)
- Every company's employees, attendance, and settings are isolated from every other company (multi-tenant)

## One-time setup

You'll need a free Cloudflare account and Node.js installed.

```bash
npm install -g wrangler      # Cloudflare's CLI, if you don't have it
cd attendance-app
npm install
wrangler login                # opens a browser to authorize the CLI
```

## 1. Create the database

```bash
wrangler d1 create attendance-db
```

This prints a `database_id`. Copy it into `wrangler.toml`, replacing `REPLACE_WITH_YOUR_DATABASE_ID`.

## 2. Load the schema

```bash
npm run db:init          # creates tables locally for `wrangler dev`
npm run db:init:remote   # creates the same tables in the real, deployed database
```

## 3. Try it locally (optional)

```bash
npm run dev
```
Opens on `http://localhost:8787`. Local runs use a local simulated D1 database.

## 4. Deploy

```bash
npm run deploy
```

Wrangler prints your live URL, e.g. `https://attendance-app.<your-subdomain>.workers.dev`. That's it — it's live, backed by D1, and fully persistent.

## 5. First login

Open the URL, click **Create company**, and fill in your company name + your own admin email/password. That's your admin account. From the **Employees** tab you can add your team, and optionally tick "Create a login" to give any employee their own check-in account.

## Notes & things worth knowing
- **Geofencing**: set your office's latitude/longitude and an allowed radius under **Settings**. Check-ins outside that radius are still recorded (never blocked) but flagged "unverified" so an admin can review them.
- **Notifications**: a daily scheduled job (cron, defined in `wrangler.toml`) runs at 01:00 UTC and marks anyone who never checked in the prior day as absent, plus flags late arrivals as they happen. Adjust the cron time in `wrangler.toml` to suit your timezone/working hours.
- **Custom domain**: add a route in the Cloudflare dashboard (Workers & Pages → your worker → Settings → Triggers → Custom Domains) if you don't want a `workers.dev` URL.
- **Costs**: Cloudflare Workers' free tier covers 100,000 requests/day and D1's free tier is generous for small-to-mid teams — likely $0/month unless you scale up significantly.
- **Security**: sessions are stored as httpOnly, secure cookies; passwords are hashed with PBKDF2 (100k iterations) — never stored in plain text.

## File map
```
wrangler.toml       Cloudflare Worker + D1 + cron config
schema.sql           Database tables
src/index.js         API routes (Hono)
src/auth.js           Password hashing, sessions, geofence math
public/index.html     Frontend shell
public/app.js         Frontend logic
public/styles.css     Design system
```
