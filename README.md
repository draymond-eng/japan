# Japan 2027 🗾

The group travel app for our April 2027 trip - six friends, ten nights in Japan.

Leave the US Wed Apr 14 → land Haneda Thu Apr 15 → home Sun Apr 25. Ten nights:
**Tokyo (4) → Hakone (1) → Kyoto (5)**, with Kamakura, Nara, and Osaka day trips.

A mobile-first, installable web app (add it to your home screen). Built as an
**open-for-discussion baseline** the group can react to and vote on.

## What's inside
- **Home** - live countdown, Chicago/Tokyo clocks, the crew, trip estimate
- **Itinerary** - the day-by-day plan with a meetup point for each day
- **Map** - every stop pinned (falls back to a tappable places list offline)
- **Crew** - 6 travelers / 3 couples + the booking order
- **Stays** - the three ryokans, prices, and room assignments
- **Flights**, **Budget** (expense splitter + settle-up), **Packing** checklist
- **Decisions** - group votes on the open questions
- **Ideas** board, and a **Japan Guide** + phrasebook

## Edit the trip
Everything lives in [`js/data.js`](js/data.js) - the single source of truth.
Change the itinerary, stays, decisions, etc. there and the app re-renders.

## Run locally
Any static server works, e.g.:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## Live site
Served via GitHub Pages at `https://draymond-eng.github.io/japan/`
(enable in **Settings → Pages → Deploy from a branch → `main` / root**).

## Notes
Votes, packing, and budget save **per-device** (localStorage). A shared
backend so all six phones sync is the planned next step.
