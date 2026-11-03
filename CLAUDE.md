# CrewSync — Developer Context for Claude

This file is the short core, loaded every session. Detail lives in topic docs, read when the work touches them.

## Read before you change anything

| Doc | Read it for |
|---|---|
| [docs/netjets.md](docs/netjets.md) | Anything NetJets: legs, tours, rotations, CC schedules, the Tail Lookup |
| [docs/live-tracking.md](docs/live-tracking.md) | Live map, ADS-B, SWIM feeds, routes, "is this flight active/parked", callsign reuse, airport data, droplet resources |
| [docs/schedule-logic.md](docs/schedule-logic.md) | Crossings, Off Days, here-now pins, time handling, parsers, uploads, Add Flight, Schedaero, debugging a pilot's data |
| [docs/frontend.md](docs/frontend.md) | Views, layout, gestures, modals, theme, notifications, Crew Intel, PWA, demo mode, function locations |
| [docs/backend-admin.md](docs/backend-admin.md) | API endpoints, auth, friends, admin panel, crew roster page, pilot config, FRAT userscript |
| `CLAUDE_HISTORY.md` | How and why something got built, or a past bug's full story |

- Read the relevant doc **before** changing that area, and more than one if the work crosses areas. A sentence like "see X below" in a doc may point at a section in another doc: search `docs/` for the heading.
- These docs and this file describe **current behavior** only. After a fix, update the relevant doc in the same commit, and put the story in `CLAUDE_HISTORY.md`.
- `server.js` and `public/app.html` are large. Use Grep for function names, don't read them sequentially.

## Standing rules

- The uploaded schedule is the source of truth for when a flight is supposed to fly. It's never overwritten with live times. Only the display may use live evidence.
- A callsign doesn't identify a leg. One NetJets callsign flies every leg of a day, and airlines reuse flight numbers. Anything about a leg (live, parked, route, airborne) must be per leg. Check this first on any tracking bug.
- Making schedule legs and displaying routes are separate jobs. A filed route attaches to a leg that already exists, and no match means no route.
- Never build an `Intl.DateTimeFormat` in a loop, and never rescan a pilot's whole history per flight. Segments span their full history.

## What this app is

CrewSync is a private PWA for a group of pilots (Kyle, Adam, Sam, Logan, Drew, plus later joiners) to coordinate schedules. Key views: Calendar, List, Route Map, Crew Planning (Crossings + Off Days). Backend: Node/Express + SQLite. Frontend: single-file `public/app.html` (~11k lines, all views and logic inline).

Kyle also runs a Tampermonkey userscript (`public/frat-autofill.user.js`) that autofills PRISM SMS flight risk assessments from his CrewSync schedule — see its own section below.

Prod server: `http://167.71.107.245:3000/` (managed via `pm2`, process name `dispatch`). **Deploy is git-based, not scp**: commit locally, `git push origin server`, then on the droplet `cd /var/www/Webapp && git pull origin server`, then `pm2 restart dispatch` after any `server.js`/`db.js` change (`public/app.html` changes don't need a restart, just a browser refresh). The droplet's `/var/www/Webapp` is itself a git clone of this same repo — `scp`-ing files directly onto it bypasses git and causes real drift between the droplet's git history and its running files. Always commit+push *before* deploying, never after — prod should never run code that isn't also on `origin/server`.

Current version: `1.0.10-beta` (`package.json`/`package-lock.json`). Bump it for the next meaningfully-sized batch of fixes, not every commit — see `CLAUDE_HISTORY.md` for the version-bump log if you need to know what shipped when.

## File map

| File | Role |
|---|---|
| `public/app.html` | Entire frontend — HTML, CSS (Tailwind CDN), all JS |
| `server.js` | Express API + all schedule parsers (ICS, CSV, VCS, Schedaero) |
| `db.js` | SQLite init + schema migrations |
| `dispatch.db` | SQLite database |
| `demo-data.js` | Fake data for `/demo` route (read-only preview) |
| `public/join.html` | New pilot onboarding form |
| `public/frat-autofill.user.js` | Tampermonkey userscript — autofills Kyle's PRISM SMS flight risk assessments |
| `swim.js` / `stdds.js` / `tfms.js` / `tfdm.js` | FAA SWIM feed consumers (SFDPS en-route, STDDS surface/terminal, TFMS flow/route/airport-config, TFDM per-flight runway/phase/delay) — see "FAA SWIM integration" below |
| `vnas.js` | VATSIM vNAS facility/frequency lookup (real ATC sector → frequency, for the live map's FREQ toggle) — unrelated data source from the FAA SWIM feeds above, see "Real ATC frequency" under "FAA SWIM integration" |
| `scripts/update-nasr-airports.js` | **Run each FAA 28-day NASR cycle** (next: 2026-11-26): downloads the current cycle's airports (`data/nasr/airports.json`, every US airport's FAA/ICAO IDs, coordinates, timezone) and fixes/navaids/SIDs/STARs/airways (via `build-navdata.js`), with checks that restore the previous files on anything suspicious. Then `node scripts/build-airports.js`, commit, deploy with restart. No tokens/Claude needed. `--dry-run`, `--airports-only`, `--force` |
| `navdata.js` / `scripts/build-navdata.js` | FAA NASR data resolution (fixes/navaids/SID/STAR/airways) for the live-map route display, and the script that builds `data/nasr/*.json` from raw NASR CSVs |

## Database schema

### `pilots`
`id, pilot_key, name, base, home_airport, role, parser_type, airline_code, token, last_active, color, hidden_crew, friends_seeded, parser_warnings`

- `base` = airline domicile (LGA, STL, PHX, SUS) — where they report for work
- `home_airport` = where they live (TUL, STL, PHX, SUS) — may differ for commuters
- `token` = 12-char URL-safe login token
- `color` = brand hex color; DB-driven for every pilot now (see "Pilot roster is fully DB-driven")
- `hidden_crew` = JSON array of explicitly-hidden pilot keys (crew-visibility storage; see "Friends system")

### `segments`
`id, pilot_id, type, departure_time, arrival_time, departure_airport, arrival_airport, tail, trip, flight_number, is_dh, is_manual, block_minutes, auto_leg_key, auto_leg_edited, auto_leg_complete`

**Segment types:**
- `'flight'` — airline or corporate legs (also used for personal/commute — see `trip` field)
- `'ground'` — van/bus transfer between airports (has both airports)
- `'reserve'` — on-call reserve shift; `departure_airport` = base; `arrival_time` = end of window
- `'hard'` — Kyle's hardcoded off days from ICS (departure_time only, no airports)
- `'vacation'` / `'training'` — from parsers that detect these (e.g. Delta MiCrew)

**Critical:** personal and commute flights are `type='flight'` with `trip='PERSONAL'` or `trip='COMMUTE'` and `is_manual=1`. They are **not** a separate type. This means they land in the `flights` array in `buildGroundPeriods`.

`auto_leg_key`/`auto_leg_edited`/`auto_leg_complete` are NetJets-manual-tracking-specific — see that section below.

**Times:** stored as local airport time, no timezone: `2026-05-26T13:30:00`
- In the **browser**: `new Date('2026-05-26T13:30:00')` → local browser time ✓
- In **Node.js**: `new Date('2026-05-26T13:30:00')` → UTC (5h offset from CDT) — affects debugging scripts
- Exception: Kyle's Schedaero segments and NetJets auto-created legs are stored in real UTC (`...Z` suffix) — `pilotUsesUtc(k)` auto-detects this per pilot.

### Other tables (added over time, see `db.js` for authoritative schema)
`friend_requests`, `intel_votes`, `flight_log`, `pilot_base_history`, `pilot_duty_rotation`, `pilot_duty_rotation_seam`, `pilot_tour_tail`, `pilot_cc_schedule_day`, `pilot_tour_reminder_sent`, `notifications` — each described in context in the relevant section below.

## File map continued — large module notes

- `swim.js`/`stdds.js`/`tfms.js`/`tfdm.js`/`vnas.js`/`navdata.js` are all read fresh when debugging live-tracking issues; none of their internals are duplicated here — check the module directly.
- `server.js` and `public/app.html` are large; use Grep for function names rather than reading sequentially.

## Key constants in `app.html`

```js
PILOT_KEYS / VALID_PILOTS   // same array ref; starts EMPTY for a real session, populated
                             // entirely by _syncPilotRoster() from /api/pilots-directory
                             // (demo mode still starts with its 4 fake fixture pilots)

PILOT_HOME   // { [key]: homeAirport } — populated from DB by _syncPilotRoster()
             // (data.home_airport || PILOT_HOME[key]) is the safe pattern

pilotsCache  // { [pilotKey]: apiResponse } — populated lazily; persists for session
             // NOT cleared on Refresh button — only on page reload or upload

METRO_GROUPS // airport → metro key (LGA/EWR/JFK/TEB → 'nyc', SUS/STL → 'stl', etc.)
LAYOVER_MS   // 5 * 3600000 — threshold for a "real" layover vs transiting
PILOT_HOME_AIRPORTS // kyle: ['SUS','STL'] — Kyle's dual home-metro exception; everyone
                     // else has exactly one. Deliberately kept hardcoded (schema has no
                     // second-home-airport column), not the override anti-pattern.
```

## Identity system

```js
myPilot   // pilot_key of the logged-in pilot, or null
myViewer  // key of view-only user, or null
// Admin: myPilot === null && myViewer === null
```

`getCrewVisible()` → array of visible pilot keys: `visiblePilotKeys()` (self + friends, or everyone for admin/viewer) minus whatever's in `_hiddenCrew`. Default is **visible** — see "Friends system" below.
`_buildCrewVisibilityUI()` → builds "Your Crew" toggles; runs for admin/viewer/demo only now (real pilots get the same toggle inline in the Friends panel — see below).

## Pilot roster (prod)

| Key | Name | Base | Home |
|---|---|---|---|
| kyle | Kyle Kaestner | KSUS | SUS (corporate, Part 91/135, SpiritJets/Schedaero) |
| adam | Adam Burke | LGA | TUL (SkyWest regional) |
| sam | Sam Byrne | LGA | STL (SkyWest regional) |
| logan | Logan Hine | SFO | PHX (SkyWest regional) |
| drew | Drew Sinelli | STL | STL (SkyWest regional) |
| mack | Mack Kraus | DFW | DFW (NetJets, manual tracking — see below) |

Additional pilots can join via `/join`. Every pilot's `home_airport`, `base`, `parser_type`, `airline_code`, `role`, and `color` come from the DB (`pilots` table) and are loaded into `PILOT_KEYS`/etc by `_syncPilotRoster()` uniformly — see "Pilot roster is fully DB-driven" below.

## `flightLocalDate` / `flightUTCTime` — when to use each

`flightLocalDate(isoStr, airportCode)` → `'YYYY-MM-DD'` at the airport's local timezone. Use when checking which calendar day an event falls on.

`flightUTCTime(isoStr, airportCode)` → `Date` in true UTC. Use when comparing times across pilots or checking if a flight is currently active (`depMs <= now <= arrMs`).

Never use `new Date(localString) < now` directly for crossings or "currently airborne" checks — local browser time may differ from airport timezone by hours.
