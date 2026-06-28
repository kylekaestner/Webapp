# CrewSync — Developer Context for Claude

## What this app is

CrewSync is a private PWA for a group of 5 corporate/regional pilots (Kyle, Adam, Sam, Logan, Drew) to coordinate schedules. Key views: Calendar, List, Route Map, Crew Planning (Crossings + Off Days). Backend: Node/Express + SQLite. Frontend: single-file `public/app.html` (~9 k lines, all views and logic inline).

Prod server: `http://167.71.107.245:3000/`

---

## File map

| File | Role |
|---|---|
| `public/app.html` | Entire frontend — HTML, CSS (Tailwind CDN), all JS |
| `server.js` | Express API + all schedule parsers (ICS, CSV, VCS, Schedaero) |
| `db.js` | SQLite init + schema migrations |
| `dispatch.db` | SQLite database |
| `demo-data.js` | Fake data for `/demo` route (read-only preview) |
| `public/join.html` | New pilot onboarding form |

---

## Database schema

### `pilots`
`id, pilot_key, name, base, home_airport, role, parser_type, airline_code, token, last_active`

- `base` = airline domicile (LGA, STL, PHX, SUS) — where they report for work
- `home_airport` = where they live (TUL, STL, PHX, SUS) — may differ for commuters
- `token` = 12-char URL-safe login token

### `segments`
`id, pilot_id, type, departure_time, arrival_time, departure_airport, arrival_airport, tail, trip, flight_number, is_dh, is_manual, block_minutes`

**Segment types:**
- `'flight'` — airline or corporate legs (also used for personal/commute — see `trip` field)
- `'ground'` — van/bus transfer between airports (has both airports)
- `'reserve'` — on-call reserve shift; `departure_airport` = base; `arrival_time` = end of window
- `'hard'` — Kyle's hardcoded off days from ICS (departure_time only, no airports)

**Critical:** personal and commute flights are `type='flight'` with `trip='PERSONAL'` or `trip='COMMUTE'` and `is_manual=1`. They are **not** a separate type. This means they land in the `flights` array in `buildGroundPeriods`.

**Times:** stored as local airport time, no timezone: `2026-05-26T13:30:00`
- In the **browser**: `new Date('2026-05-26T13:30:00')` → local browser time ✓
- In **Node.js**: `new Date('2026-05-26T13:30:00')` → UTC (5h offset from CDT) — affects debugging scripts

---

## Key constants in `app.html`

```js
PILOT_KEYS / VALID_PILOTS   // same array ref; starts ['kyle','adam','sam','logan','drew']
                             // logged-in pilot pushed at runtime if not already present

PILOT_HOME   // { kyle:'SUS', adam:'TUL', sam:'STL', logan:'PHX', drew:'STL' }
             // initialized from hardcoded values; updated from DB after cache loads
             // (data.home_airport || PILOT_HOME[key]) is the safe pattern

pilotsCache  // { [pilotKey]: apiResponse } — populated lazily; persists for session
             // NOT cleared on Refresh button — only on page reload or upload

METRO_GROUPS // airport → metro key (LGA/EWR/JFK/TEB → 'nyc', SUS/STL → 'stl', etc.)
LAYOVER_MS   // 5 * 3600000 — threshold for a "real" layover vs transiting
```

---

## Identity system

```js
myPilot   // pilot_key of the logged-in pilot, or null
myViewer  // key of view-only user, or null
// Admin: myPilot === null && myViewer === null
```

`_visKey()` → localStorage key for crew visibility; returns `'crewVisible_admin'` for admin (not null).  
`getCrewVisible()` → array of visible pilot keys.  
`_buildCrewVisibilityUI()` → builds "Your Crew" toggles; runs for pilot, viewer, AND admin.

---

## Key functions (grep these names)

| Function | Line ~| Role |
|---|---|---|
| `initIdentity()` | 2122 | Auth check on load; sets myPilot/myViewer |
| `_applyIdentityUI()` | 2267 | Shows/hides UI sections based on who's logged in |
| `_buildCrewVisibilityUI()` | 2340 | Crew toggle switches in profile sheet |
| `render()` | 5937 | Main calendar/list render dispatcher |
| `renderMap()` | 4350 | Single pilot monthly route map |
| `renderAllPilotsMap()` | 4208 | All-crew monthly map |
| `renderDayMap()` | 5291 | All-crew single-day map |
| `inferAwayLayovers()` | 2880 | Generates synthetic 'away' events for overnight non-home stays |
| `switchView()` | 3062 | Switches between calendar/list/map/overlap views |
| `switchOverlapTab()` | 3315 | Crossings ↔ Off Days tab switch |
| `computeOverlap()` | 3432 | Crossings pipeline (fetch → buildGroundPeriods → classify → render) |
| `buildGroundPeriods()` | 3446 | Inside computeOverlap; emits ground windows per pilot |
| `computeOffDays()` | 3330 | Off Days pipeline |
| `renderCommonOffSection()` | 3152 | Renders off day rows + filter chips |

---

## Crossings pipeline (`computeOverlap`)

**Step 1 — `buildGroundPeriods(segments, homeBase, homeCity)`**

Emits `{ airport, start, end, ... }` windows. Key parameters:
- `homeBase` = `data.base` (airline domicile) — arrival here is skipped (`if (home && arr === home) return`)
- `homeCity` = `data.home_airport || PILOT_HOME[key]` (where pilot lives) — has special branch

**Pre-departure period logic (`recentArr` / `useRecentArr`):**
- Finds the most recent arrival at the departure airport
- For home base: only valid if within 24h
- For other airports: only valid if pilot hasn't flown from any other airport since — a departure from elsewhere means they went home and came back; use fresh 2h window instead
- This prevents month-long pre-departure periods when a pilot returns to ORD for a new trip

**Arrival period logic (`nextFromArr`):**
- Uses `allDeps` (all segment types, including personal/commute) so logged commutes terminate ground periods immediately
- If `nextFromArr` is >2 days away, checks `wentHome`: if pilot flew from any other airport during the gap, cap ground period at arrival+8h
- Else: default to arrival+8h

**Step 2 — cross pilot pairs**

`airportsNear(a, b)`: checks metro groups first, then haversine ≤50mi.

Skip condition: both pilots at their own homes → skip (line ~3677).

**Step 3 — `classifyOverlap()`**

| Type | Label | Tier | Condition |
|---|---|---|---|
| `SAME_FLIGHT` | Same Flight | 1 | Same flight number on arrival |
| `HOME_VISIT` | Home Turf | 1 | Visitor at other pilot's home metro AND visitor has ≥5h layover |
| `METRO` | City Meetup | 1 | Same metro, both have ≥5h |
| `METRO` | Same Metro | 3 | Same metro, one just transiting |
| `NEARBY` | Nearby | 3 | Haversine-only match |
| `PASSING_THROUGH` | Passing Through | 1 | Same airport, one is connecting |
| `LAYOVER` | Overnight | 1 | Same airport, both have time, spans night or ≥5h |
| `MEETUP` | Meetup | 1 | Same airport, direct overlap |

Tier 1-2 → primary cards; tier 3 → compact "Also Nearby" rows.

`adjustedPeriod()` shifts times for UTC-storing pilots (Schedaero/Kyle) to match airport local time before overlap comparisons.

---

## Built-in logic reference

This section documents non-obvious behaviors already implemented. Check here before assuming something doesn't exist.

### Time handling — two systems coexist

**Kyle** uses UTC times (Schedaero source, strings end in `Z`). All other pilots use local airport time (no timezone suffix).

`pilotUsesUtc(k)` — detects which system a pilot uses by inspecting the first flight's departure_time string.

`flightUTCTime(isoStr, airportCode)` — converts any time string to a real UTC Date, using the airport's IANA timezone for local strings. Use this for comparisons across pilots. Never compare raw `new Date(localString)` across pilots — they'll be off by hours.

`flightLocalDate(isoStr, airportCode)` — extracts the local calendar date (YYYY-MM-DD) at the airport, accounting for UTC→local conversion for Kyle's flights.

`adjustedPeriod(k, p)` — in crossings: shifts a ground period's start/end by the difference between browser TZ and airport TZ, so UTC comparisons between pilots stay consistent.

### "Here Now" / pilot location pins (`renderDayMap`)

For each pilot, the day map resolves their current location in this priority order:

1. **Live ADS-B** — if there's an active ADS-B trail, show live position
2. **Active flight** — if a flight's dep→arr window contains now, show in-air
3. **Reserve period** — if in an active reserve window, show at reserve base
4. **Away layover** — if an `inferAwayLayovers` 'away' event is active, show at layover airport
5. **Completed flights** — last arrived airport from completed flights
   - **Mid-trip overnight**: at non-home airport with a future departure from there within 12h → show at that airport (not home)
   - **At airline base but not home (commuter)**: in a 3h window after landing → "Heading home" still at base airport
   - Otherwise → show at `home_airport`
6. **No history** — if no flights yet, look for a work flight departing within 24h → show at its departure airport

**Commuter detection** (`isCommuter`): `atBase && !atHome` — pilot who lives somewhere other than their base (e.g. Adam: base=LGA, home=TUL). When they land at LGA, they're shown "Heading home" for up to 3 hours before being moved to TUL.

### `inferAwayLayovers()` — synthetic away events

Runs during `loadPilot()`. Walks all `type='flight'` segments (excluding `trip='PERSONAL'`). Between consecutive flights, if the arrival airport is:
- Not the pilot's airline base
- Not the pilot's home airport
- And spans a midnight boundary (arrival day ≠ next departure day)

…then inserts synthetic `{ type: 'away', arrivalAirport }` events for each day of the layover (arrival day through departure day inclusive). These events drive calendar "away" coloring but are NOT stored in the DB.

### Off Days detection (`computeOffDays` / `renderCommonOffSection`)

A pilot is "off" on a date if they have **no** `flight`, `reserve`, or `ground` segments on that calendar date. Exception: `type='flight'` with `trip='PERSONAL'` is excluded from the "working" set (personal flights don't count as work days). Kyle's `type='hard'` segments are treated as confirmed off days from his ICS.

Reserve windows mark every day in the window as "working" (using local airport date so UTC Kyle doesn't accidentally mark wrong days).

A date is "common off" when all selected pilots are simultaneously off.

### Auto-sync schedule (server.js)

ICS pilots (Drew, Logan, Sam, Adam who has ICS) and Kyle's Schedaero sync automatically at **06:00, 14:00, 22:00 UTC** daily. Implemented as a chained `setTimeout` (not cron). Schedaero keepalive pings every 20 minutes to keep the session alive between syncs.

### `buildGroundPeriods` — home city branch (`homeC`)

When a pilot arrives at their **home city** (`homeCity`/`homeC`, distinct from their airline base):
- Looks for the next departure FROM the home city (`nextFromArr`)
- Looks for the next departure from their airline **base** (`nextFromBase`) — because a commuter flies to base before their next trip, and that base departure ends the "home" window
- `groundEnd` = whichever of those is earlier, capped at arrival+8h if neither exists
- This correctly handles: Adam lands TUL → home. His next event is a LGA departure (base), not a TUL departure. `nextFromBase` finds the LGA leg that starts his next trip.

### Personal/commute flight behavior

- In `inferAwayLayovers`: **excluded** (`trip !== 'PERSONAL'`) — personal flights don't generate away events
- In `buildGroundPeriods` `flights` array: **included** (type='flight') — they participate in the loop as normal departures/arrivals
- In `buildGroundPeriods` `allDeps`: **included** — used to terminate ground periods at layover airports
- In `computeOffDays` flying-day detection: **excluded** (`trip === 'PERSONAL'`) — personal travel doesn't make a day "working"
- In `render()` calendar: personal/commute flights are rendered as their own color-coded type in the calendar grid

### `pilotsCache` invalidation

`pilotsCache[key]` is set once per page load (or after upload/sync). The "Refresh" button on Crossings calls `computeOverlap()` but does **not** clear the cache — it re-runs `buildGroundPeriods` on cached data. A stale cache can make crossings appear wrong even after a schedule fix. To force-refresh: reload the page.

---

## `#view-overlap` layout (important for iOS scroll)

Must be flex column with filter bar OUTSIDE the scroll container:
```
#view-overlap (display:flex; flex-direction:column; overflow:hidden)
  ├── #overlap-header        (shrink-0)  ← sticky header + tabs
  ├── #offday-filter-bar     (shrink-0)  ← pilot chips, Off Days only
  └── .flex-1.overflow-y-auto            ← scrollable content
```
Moving the filter bar inside the scroll container breaks iOS horizontal scroll (snaps back).

---

## API endpoints (server.js)

```
GET  /api/pilots                          all pilots
GET  /api/pilots/:key                     pilot + all segments (snake_case keys)
POST /api/pilots/:key/upload              upload schedule file
DELETE /api/pilots/:key/segments          clear all non-manual segments
POST /api/pilots/:key/add-segment         add manual segment
PUT  /api/pilots/:key/segments/:id        edit segment
DELETE /api/pilots/:key/segments/:id      delete segment
PUT  /api/pilots/:key                     update pilot profile (base, home_airport, etc.)
POST /api/pilots/:key/sync-ics            trigger ICS sync
POST /api/pilots/kyle/sync-schedaero      full Schedaero sync (Kyle only)
POST /api/pilots/kyle/quick-sync-schedaero  quick sync (Kyle only)
GET  /api/pilots/:key/ics-url             get stored ICS URL
POST /api/early-landing                   report early landing
GET  /api/live-position                   ADS-B position for active corporate flights
GET  /api/health                          health check
GET  /admin/users                         admin user management page
```

---

## Pilot roster (prod)

| Key | Name | Base | Home |
|---|---|---|---|
| kyle | Kyle Kaestner | KSUS | SUS (corporate, Part 91/135) |
| adam | Adam Burke | LGA | TUL (SkyWest regional) |
| sam | Sam Byrne | LGA | STL (SkyWest regional) |
| logan | Logan Hine | SFO | PHX (SkyWest regional) |
| drew | Drew Sinelli | STL | STL (SkyWest regional) |

Additional pilots can join via `/join`. When a non-core pilot logs in, their key is pushed into `PILOT_KEYS`. Their `home_airport` and `base` come from the DB.

---

## Common debugging patterns

**Check a pilot's segments on prod:**
```bash
curl http://167.71.107.245:3000/api/pilots/adam | node -e "
const c=[]; process.stdin.on('data',d=>c.push(d));
process.stdin.on('end',()=>{
  const d=JSON.parse(Buffer.concat(c));
  d.segments.filter(s=>s.departure_time>='2026-05-01').forEach(s=>
    console.log(s.departure_time?.slice(0,16), s.type, s.departure_airport,'->',s.arrival_airport, s.trip||'')
  );
});
"
```

**Simulate buildGroundPeriods in Node (times treated as UTC in Node — offsets cancel in comparisons but absolute values differ from browser):**
Copy the function from app.html, feed it prod segments, look for periods >48h.

**Crossings 1153h-style bugs — common causes:**
1. Old `recentArr` used as groundStart for a new trip (pilot returned to same airport weeks later) — fixed by the `useRecentArr` other-airport check
2. `nextFromArr` finding next trip from layover airport weeks later when pilot went home without logging commute — fixed by `wentHome` detection
3. Missing personal/commute in `allDeps` (verify `allDeps` filter includes all types)

**Map debugging — always identify which render function:**
- `renderMap()` — single pilot month
- `renderDayMap()` — all pilots on one day
- `renderAllPilotsMap()` — all pilots month

UTC/local date skew is common: segments stored in local time, `new Date()` in browser uses local time, but comparisons to `new Date()` (now) need care around midnight.
