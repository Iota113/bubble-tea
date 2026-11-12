# 🧋 Study Break: Free Bubble Tea Night

A simple web app for the study-break night before finals at the NUS COM1 foyer.

It does two things for the organisers (the wing):

1. **Before the event:** collects RSVPs so you can estimate the food order.
2. **On event day:** helpers tap a button to indicate one bubble tea is collected, which updates a "cups left" counter that is visible to everyone, including the public. The counter refreshes every 5 seconds, so it's not exactly live.

There is no Telegram bot implemented because apparently that requires the user to do an initialisation process before the bot can send messages to the user, making it less seamless for the user.


## For Helpers
Helpers get a dedicated page "/door" that is accessible only through a PIN. This page allows helpers to press the "+1 cup" button, which increments the counter. There's a cup limit (150 by default), and once it's hit the button just shows SOLD OUT. The PIN is stored on Supabase as a hash so normal users can't access it, and it's not written anywhere in this repo, so just ask me for it. There is also no button to access the "/door" page from the app's homepage as we can just send the link to helpers and normal users have no reason to access the "/door" page.

There is also an "undo" button that is just a glorified decrement button, with the logic that it won't decrement the counter below 0. It's not per-person though, so any helper's undo removes the latest cup.

The "/door" page also has an RSVPs tab to search people up and mark them as arrived, and a stats tab with RSVP/arrival/walk-in counts and a CSV download of all RSVPs.

## How the data is stored
Everything is in Supabase (Postgres), in 3 tables: `settings` (one row with the cup count, cup limit, RSVP deadline and event details), `secrets` (the PIN hash) and `rsvps`. The browser can't read or write the tables directly, it can only call a few database functions in `supabase/schema.sql`, and the helper ones all check the PIN first.

## Why Supabase
Assuming there are multiple helpers, having a centralised database that all their devices can read from is necessary. Race conditions are also handled since the +1 is a single atomic Postgres update that won't go past the cup limit, even if multiple helpers tap at the same time (`scripts/verify.mjs` tests 200 taps at once against a limit of 150). Personally I've also used Supabase for web apps in the past involving upwards of 100 users at an event venue so I'm fairly confident in its ability to handle this.

Pretty much everything admin-related is done in the Supabase SQL editor: changing the helper PIN (`select set_door_pin('new-pin');`), closing RSVPs (`update settings set rsvp_closes_at = now();`), changing the cup limit, or wiping data. The page itself is quite simple.

## What would break
- If the venue wifi/data drops, taps don't get saved, but the page shows a red NOT SAVED banner so helpers know to tap again.
- If the PIN leaks, anyone can mess with the count and download everyone's names and tele handles. There's also no limit on wrong PIN attempts, so the PIN should be long.
- Supabase free projects pause after about a week of no activity, so open the site a day or two before the event.

## Running it locally
Same old npm install, npm run dev. You need to create a Supabase project, run `supabase/schema.sql` in its SQL editor, and paste the project url and anon/publishable key into the .env file as `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (see `.env.example`). The .env file is safely tucked in .gitignore.
