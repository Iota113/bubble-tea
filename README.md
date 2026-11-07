# 🧋 Study Break: Free Bubble Tea Night

A small web app for the study-break night before finals at the NUS COM1 foyer (7–9pm, 150 free cups of bubble tea plus snacks).

It does two things for the organisers (the wing):

1. **Before the event:** collects RSVPs so you can estimate the food order.
2. **On the night:** helpers at the door keep a live count of cups given. Everyone sees how many cups are left.

Attendees never sign up to collect. Helpers do the counting at the door.

## Pages

| Page | Who | What |
|---|---|---|
| `/` | Everyone | Event info and a live "X / 150 cups left" counter (refreshes every 5s, shows "Running low" under 20 and a clear SOLD OUT). RSVP form with a name (required) and Telegram handle (optional). The form says RSVP is for food estimates, is not a reserved cup, and cups are first come, first served. It closes automatically at the deadline. |
| `/door` | Helpers | Asks for the shared PIN once and remembers it on the phone. Shows a huge count, a thumb-sized **+1 cup given** button and a small, separate **Undo**. The button disables at the cap. A red banner appears when offline or when a tap didn't save. **RSVPs** tab: search and tick "arrived". **Stats** tab: cups given, RSVPs total/arrived, walk-ins, and a CSV download. |

There are only two routes. `vercel.json` (and `public/_redirects` for Netlify) rewrites every path to `index.html`, so `/door` works on refresh.

## Setup

### 1. Supabase
1. Create a free project at [supabase.com](https://supabase.com).
2. Open **SQL Editor**, paste all of [`supabase/schema.sql`](supabase/schema.sql), and run it.
3. **Fill in the placeholders.** The organisers haven't confirmed these yet. Run in the SQL editor:
   ```sql
   -- door PIN (only its hash is stored). Use something longer than 4 digits.
   select public.set_door_pin('your-door-pin');

   update public.settings set
     event_time     = 'Tue 2 Dec · 7–9pm',          -- event date
     rsvp_closes_at = '2026-12-01 18:00:00+08',     -- RSVP deadline, SGT (+08)
     cup_limit      = 150;                          -- cup limit
   ```
   The starting PIN is `CHANGE-ME`, so the door page won't open with a guessable PIN by accident.

### 2. Environment variables
Copy `.env.example` to `.env` and fill both values from **Project Settings → API**:
```
VITE_SUPABASE_URL=https://xxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...   # the "anon public" key, never the service_role key
```
The anon key is meant to be public. It can only call the functions listed below.

### 3. Run locally
```bash
npm install
```
```bash
npm run dev
```

### 4. Deploy (Vercel)
Import the repo in Vercel. The framework preset is Vite. Add the two `VITE_` env vars and deploy. `vercel.json` already has the SPA rewrite. On Netlify, set the build command to `npm run build` and publish `dist`. `_redirects` is included.

Send helpers the link `https://<your-site>/door` and give them the PIN in person.

## How the data works

- Tables: `settings` (one row: cup limit, count, deadline, event text), `secrets` (one row: PIN hash), `rsvps`.
- RLS is on for every table with **no policies**, and table privileges are revoked from `anon`. The browser can't read or write any table directly.
- The browser can only call these `SECURITY DEFINER` functions:
  - `get_public_status()`
  - `submit_rsvp(name, handle)`: rejects after the deadline, trims, and caps name at 80 chars and handle at 40.
  - `give_cup(pin)`: one atomic `update … set cups_given = cups_given + 1 where cups_given < cup_limit`. Returns `ok` or `sold_out`.
  - `undo_cup(pin)`: decrements, never below 0.
  - `door_stats(pin)`, `search_rsvps(pin, q)`, `mark_arrived(pin, id, arrived)`, `export_rsvps(pin)`.
- A wrong PIN raises `bad_pin` and changes nothing.

## Verification

`scripts/verify.mjs` tests the real API with the anon key, the same way the browser does. It uses the Postgres connection string only to set up and restore state.

```bash
SUPABASE_URL=... SUPABASE_ANON_KEY=... DATABASE_URL="postgresql://postgres:...@...supabase.com:5432/postgres" npm run verify
```

It checks:
- 200 concurrent `give_cup` calls give exactly 150 `ok`, each with a unique count from 1 to 150, and the final count is exactly 150.
- A wrong, empty or null PIN is rejected by every door function, and nothing changes.
- The anon key can't select, insert or update `settings`, `secrets` or `rsvps`, and can't call the internal PIN functions.
- Undo stops at 0. Name/handle trimming and truncation work. Search treats `%` and `_` literally. Arrived ticks don't change the cup count, and walk-ins are calculated correctly.
- An RSVP after the deadline is rejected and not stored.

⚠️ **Don't run it during the event.** It temporarily swaps the PIN, deadline and count, then restores them and deletes its test RSVPs.

**What was run for this build:** a local Postgres 17 set up with Supabase's roles and default grants (`scripts/local/supabase-roles.sql`), plus a small PostgREST stand-in (`scripts/local/fake-postgrest.mjs`) that runs every request as `anon`. All checks passed against it. Both pages were also tested at 375px wide (no horizontal scroll). That covered the normal, running-low, sold-out and RSVPs-closed states, a wrong PIN, rapid triple taps (only +1 counted), the API being down mid-tap (red "NOT SAVED" banner, count left unchanged), and the arrived toggle, stats and CSV. Run `npm run verify` once against the real Supabase project before the event.

Local test setup, optional:
```bash
DATABASE_URL=postgres://postgres@localhost:54329/bt node scripts/local/fake-postgrest.mjs
```
```bash
npm run dev:local
```

## Why Supabase

- **Shared state across several door phones.** Every helper's phone shows and changes the same count.
- **Atomic increments.** The cap is enforced inside one `UPDATE … WHERE cups_given < cup_limit` statement. Concurrent taps from several phones queue on the row lock and each one re-checks the condition, so the count can't go past 150.
- **Server-side PIN check.** The PIN never lives in the frontend code, and the browser can't reach the tables.
- **Free tier.** It's plenty for one evening.

## What would break / limits

- **COM1 Wi-Fi or Supabase goes down.** The door page shows a loud red banner and never shows a count the server didn't confirm. Fallback: keep a **paper tally** at the door, then add it afterwards with `update settings set cups_given = cups_given + N`. Phones on mobile data are a good backup to Wi-Fi.
- **Free projects pause after about a week with no activity.** Open the dashboard (and the site) the day before the event and check the project is active.
- **One shared PIN.** Anyone with it can change the count and check people in. If it leaks, rotate it with `select set_door_pin('new')`. Helpers' phones will then be asked for the new PIN. There's no rate limit on PIN guesses, so use something longer than 4 digits.
- **RSVPs aren't deduplicated or verified.** People can RSVP twice or under fake names, and a retry after a network blip can create a duplicate. Treat the number as a rough estimate, which is all it's for.
- **Polling.** The public count can lag up to about 5 seconds. Door phones also poll every 5s and refresh when the page regains focus. Each phone's own taps show up immediately.
- Undo has no confirm step, to keep the door fast. It's small and placed away from +1 to prevent accidental taps.

## What was cut, and why

- **Telegram bot.** Explicitly out of scope. The Telegram handle is only collected so the wing can reach people if needed.
- **Accounts / login.** Too much setup for a one-night event. One shared door PIN is enough.
- **Self check-in.** Collecting a cup doesn't need sign-up. Helpers at the door count cups, which is faster and harder to game than attendees tapping on their own phones.

## Restyling

All colours, the font and the corner radius are CSS variables at the top of [`src/styles.css`](src/styles.css). There's one accent colour (`--accent`).
