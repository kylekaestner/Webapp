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
| `showDayDetail()` | 6557 | Opens day detail bottom sheet for a date key |
| `handleUpload()` | 6523 | File upload handler → `uploadPilotSchedule()` |
| `submitAddFlight()` | 7024 | Saves manual flight from add-flight modal |
| `startLiveTracking()` | 4946 | ADS-B poll loop for one callsign; 8s interval |
| `startCalListLivePolling()` | 4848 | Polls ADS-B for `[data-live-callsign]` elements in cal/list |
| `setupMobileGestures()` | 1636 | Registers swipe + pull-to-refresh handlers |
| `renderIntel()` | 8452 | Crew Intel dispatcher → airports / map / detail sub-renders |
| `renderIntelMap()` | 8524 | Leaflet thumbtack-pin map for intel entries |
| `renderIntelAirports()` | 8633 | Airport card list for Crew Intel |
| `renderIntelDetail()` | 8686 | Per-airport intel tip cards |
| `saveIntelTip()` | 8828 | POST/PUT intel entry to `/api/intel` |
| `openAdminPanel()` | 7508 | Admin users panel + dashboard tab |
| `saveUser()` | 7872 | Admin add/edit user → POST/PUT `/api/pilots` |
| `initServiceWorker()` | 7960 | Registers `/sw.js`; listens for `OPEN_OVERLAP` message |
| `initPushNotifications()` | 7970 | Decides whether to subscribe or show prompt |
| `subscribeToPush()` | 7994 | Gets VAPID key, creates push subscription, POSTs to server |
| `updateCrossingAlert()` | 8132 | Updates badge count + crossing modal from computed overlaps |
| `loadNotifications()` | 8022 | Fetches `/api/notifications` and updates bell badge |

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

**`completedFlights` guard — departure must have passed:** Both `renderMap` and `renderDayMap` require that `departureTimeUTC <= now` in addition to `arrivalTimeUTC <= now` before counting a flight as completed. Without this, a manually-added transpacific flight whose `arrivalTime` was stored one day too early (a known `inferArrDate` limitation for >12h timezone crossings) would appear "completed" before the flight even departs, placing the HERE-NOW pin at the wrong arrival airport.

**Debug endpoint:** `GET /api/pilots/:key/here-now` returns `{ location, label, step_fired, step_detail, flights }` — shows which HERE-NOW logic branch fired and which flight drove the decision. Useful when the pin appears at the wrong airport. Note: uses approximate UTC conversion (raw `isoStr + 'Z'`) for local-time pilots; close enough for debugging but not pixel-perfect.

### `inferAwayLayovers()` — synthetic away events

Runs during `loadPilot()`. Walks all `type='flight'` segments (excluding `trip='PERSONAL'`). Between consecutive flights, if the arrival airport is:
- Not the pilot's airline base
- Not the pilot's home airport
- And spans a midnight boundary (arrival day ≠ next departure day)

…then inserts synthetic `{ type: 'away', arrivalAirport }` events for each day of the layover (arrival day through departure day inclusive). These events drive calendar "away" coloring but are NOT stored in the DB.

### Off Days detection (`computeOffDays` / `renderCommonOffSection` / `renderOffDayCalendar`)

A pilot is "off" on a date if they have **no** `flight`, `reserve`, or `ground` segments on that calendar date. Exception: `type='flight'` with `trip='PERSONAL'` is excluded from the "working" set (personal flights don't count as work days). Kyle's `type='hard'` and `type='vacation'` segments are both treated as confirmed off days.

Reserve windows mark every day in the window as "working" (using local airport date so UTC Kyle doesn't accidentally mark wrong days).

A date is "common off" when all selected pilots are simultaneously off.

**Off Days tab UI:** two views toggled by the calendar icon in the filter bar:
- **List view** (default) — `renderCommonOffSection()` — chronological rows grouped by date
- **Calendar view** — `renderOffDayCalendar()` — month grid with colored name pills per off pilot in each cell. Amber cell = all selected off; green cell = majority off. Tapping a cell shows pilot status. On mobile the detail slides up as a bottom sheet; on desktop it renders inline below the calendar. Month navigation (`prevOffMonth` / `nextOffMonth`) is independent of the main calendar month. `_offDayView`, `_offDayYear`, `_offDayMonth`, `_offDaySelected`, `_offDayFilter` are the state variables.

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

## Touch gesture system

Two swipe handlers are registered in `setupGestures()` (~line 1640):

**Calendar / List month swipe** — listens on the main content element. Horizontal swipe (|dx| > 60, more horizontal than vertical by 1.8×) → changes month. Only fires on calendar/list views.

**Overlap tab swipe** — listens on `#view-overlap`. Same thresholds. Swipe left → Off Days tab; swipe right → Crossings tab. **Critical:** ignores touches that originate inside `#offday-filter-bar` (`e.target.closest('#offday-filter-bar')`) — otherwise scrolling the pilot chips left triggers a tab switch.

```js
overlapEl.addEventListener('touchstart', e => {
    if (e.target.closest('#offday-filter-bar')) { oxStart = null; return; }
    oxStart = e.touches[0].clientX; oyStart = e.touches[0].clientY;
}, { passive: true });
overlapEl.addEventListener('touchend', e => {
    if (oxStart === null) return;
    const dx = e.changedTouches[0].clientX - oxStart;
    // ...
}, { passive: true });
```

---

## Splash screen (`#splash-screen`)

Defined in `app.html` around line 360. Full-screen overlay shown while the app initialises; fades out once identity is resolved.

- Logo: `<img class="splash-plane" src="/icon.svg">` — the CrewSync plane icon (72×72, rounded, floating animation). Was previously a `✈️` emoji — don't revert.
- Title: "CrewSync" in blue bold italic
- Subtitle: "Crew Scheduling"
- Three pulsing blue dots as loading indicator
- CSS classes: `.splash-plane`, `.splash-title`, `.splash-sub`, `.splash-dots`, `.splash-dot`
- Dismissed by adding `splash-hide` (fade) then `splash-gone` (display:none)

---

## Branding assets

| File | Usage |
|---|---|
| `public/icon.svg` | App icon — dark navy bg, white plane pointing NE. Used in: splash screen, crew roster header, browser favicon |
| `public/icon-192.png` | PWA manifest icon (192×192) |
| `public/icon-512.png` | PWA manifest icon (512×512) |
| `public/apple-touch-icon.png` | iOS home screen icon |

When adding the logo anywhere, use `<img src="/icon.svg">` with `border-radius` to match the rounded-square style. Don't use emoji or generic plane glyphs.

---

## Crew roster page (`/crew-roster`)

Server-side HTML rendered in `server.js` around line 2068. Protected by `rosterAuth` middleware (password from env). Only accessible to admin.

**Per-pilot card shows:**
- Initials avatar (viewers get 👁 emoji, blue bg)
- Name, pilot_key, base, home_airport
- Last active timestamp + colored dot indicator

**Last-active color scale:**

| Recency | Color | Label example |
|---|---|---|
| < 1 hour | `#22c55e` green | `3m ago` |
| 1–24 hours | `#84cc16` lime | `5h ago` |
| 1–3 days | `#eab308` yellow | `2d ago · Jun 26` |
| 3–7 days | `#f97316` orange | `5d ago · Jun 23` |
| > 1 week | `#ef4444` red | `Jun 15` |
| Never | `#52525b` gray | `Never` |

`last_active` is updated in the DB whenever a pilot loads the app (set via `PUT /api/pilots/:key` or directly in the auth flow). The `fmtActive()` and `activeColor()` helpers live inside the route handler in server.js.

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

---

## Calendar grid rendering (`render()` → grid branch)

`render()` (~line 5937) rebuilds whichever view is active. It does **not** fetch — call `loadPilot()` to refresh from server first.

**Grid mode logic per calendar cell:**

1. Walks every day in the month. For each day (`dateKey = YYYY-MM-DD`):
   - Filters `segments[]` for events whose **local** departure or arrival date matches (uses `flightLocalDate()`, not raw JS date).
   - Classifies the day: Hard Off > Vacation > Flying > Reserve > Away (from inferAwayLayovers) > personal-away > Off.
2. **Border/background** set by classification:
   - `border-red-600 bg-red-700/80` — Hard Off
   - `border-blue-500/30 bg-blue-500/10` — Flying
   - `border-amber-400/30` — Reserve (On Call)
   - `border-yellow-500/40 bg-yellow-900/20` — Away layover
3. Within each cell, flight items sorted chronologically. Each flight item stores data attributes (`data-dep-time`, `data-arr-time`, `data-tail`, `data-trip`, `data-flight`, `data-live-callsign`).
4. **Active flights** (depMs ≤ now ≤ arrMs): get `active-leg` class (green border pulse) and `data-live-callsign` attribute that `startCalListLivePolling()` picks up.
5. After grid renders: `attachTooltips()` wires hover tooltips. `startCalListLivePolling()` starts ADS-B polling for any cells with `data-live-callsign`.

**Mobile grid:** CSS overrides at line ~76 make cells compact (52–96px tall). Flight pills are shown text-only with route; status pills hidden.

---

## List view rendering (`render()` → list branch)

`render()` list branch iterates every day in the month. For each day with events:
- One "day header" block with date label and status badge.
- Flight rows (`.flight-row`) sorted by departure time. Each row shows: route pair, local dep/arr times with timezone abbreviation, block time, tail/flight#, layover duration between consecutive legs.
- **Ground legs** (type='ground') appear as subdued smaller rows labeled `VAN ORD→MDW`.
- **Reserve slots** appear as amber "ON CALL" rows with time window.
- Past days get `.list-past` (grayscale + dimmed). Today highlighted.
- **Layover label** logic: gap between consecutive flights → `layoverLabel(gapMins, atHome, sameDay)`. Shows overnight duration if >30 min and not at home. Suppresses label if >30h at home (pilot commuted home).

---

## Day detail sheet (`showDayDetail(dateKey)`)

Opens `#day-detail-sheet` (bottom sheet on mobile, centered modal on desktop) when a calendar cell is tapped.

Content built from same `segments[]` slice as the grid. Renders:
1. Header: status label (HARD OFF / IN THE AIR / FLYING / ON CALL / DAY OFF) + full date.
2. All flights for the day sorted by departure time.
3. Each flight card: route, dep/arr times (with city/state names from airport lookup), block time, tail#, trip#, DH badge, layover line to next leg.
4. Reserve cards: type label (RESR/RESA/RESP), time window.
5. Ground leg cards: subdued, smaller.
6. Manual flights get Edit/Delete buttons (only if `canEdit()` is true — logged-in user's own flights or admin).
7. Any live flight shows a `▶ LIVE` badge and calls `deriveCallsign()` for ADS-B tracking.

`canEdit()` returns true if `myPilot === currentPilot` or admin (`myPilot === null`).

---

## Pull-to-refresh (`setupMobileGestures()`)

Registered on `#view-grid` and `#view-list` via touchstart/touchmove/touchend.

**Logic:**
- `touchstart`: record startX/startY; `ptrActive = el.scrollTop === 0` (only fires at top of scroll).
- `touchmove`: if dragging down while at scroll top → scale opacity and rotate the `#ptr-indicator` spinner. At 70px pull → `ptrTriggered = true`, indicator spins continuously.
- `touchend`: if `ptrTriggered` → call `loadPilot(currentPilot)` + show "Schedule refreshed" toast. Else if horizontal swipe → `changeMonth()`.

`#ptr-indicator` is a fixed 36px circle, initially translated off-screen (-52px). Its Y position tracks the pull distance.

---

## ADS-B live tracking

Two parallel systems:

### `startLiveTracking()` (map view only, ~line 4946)
Polls `/api/live-position?callsign=XX` every **8 seconds** for an active flight arc on the map.

- Called from `renderMap()` and `renderDayMap()` for any flight whose window spans now.
- Draws a real-time GPS trail (solid colored polyline) and a remaining-arc (dashed geodesic arc from current position to destination).
- Plane icon (SVG from ADS-B Exchange shape library, ~line 5238) starts hidden; becomes visible only after ADS-B confirms it airborne (`hasBeenAirborne = true`).
- `deoverlapLiveLabels()` runs every 300ms to prevent callsign tooltip collisions.
- If server returns `{ parked: true }` → flight complete, re-renders map.
- If `hadTrail && !found` for 3+ misses → plane already landed, removes arc and re-renders.
- Uses `_livePollers[callsign]` (object) to prevent duplicate pollers. `_landedEarly` Set tracks early landings.
- **World copy support**: markers placed at `lon`, `lon+360`, `lon-360` so panning globally shows the plane on every map copy.

### `startCalListLivePolling()` (~line 4848)
Polls every **15 seconds** for active-leg cells/rows in the calendar and list views.

- Finds all elements with `[data-live-callsign]` attribute (added during render for `isActiveLeg` cells).
- Per callsign: polls `/api/live-position`, updates `#live-{callsign}` element with altitude + speed text.
- Shows: `✈ FL340 · 428 kts` (airborne) or `Taxiing · 15 kts` (ground).
- Stopped by `stopCalListPollers()` before each re-render.

### Server-side ADS-B proxy (`/api/live-position`)
Server proxies to `api.adsb.lol` and `airplanes.live`. Caches trail points per callsign from server start so trail is pre-seeded before polling. Returns `{ found, lat, lon, altFt, speedKts, onGround, heading, trail[], parked, hadTrail }`.

`deriveCallsign()` in the frontend maps tail/flight number combinations to the correct ADS-B callsign (e.g. corporate tails like N431JD, or airline flight numbers like SKW1234).

---

## Upload flow

`handleUpload(input)` (~line 6523):
1. Reads selected file and upload-for pilot from `#upload-pilot-select` dropdown.
2. Calls `uploadPilotSchedule(pilotKey, file)` → `POST /api/pilots/:key/upload` with `multipart/form-data`.
3. On success: shows toast with segment count, reloads that pilot if currently viewed, then `computeOverlap()` to update crossings.
4. After overlap computed: calls `updateCrossingAlert(overlaps)` (badge) and `broadcastCrossingNotifications(overlaps)` (push) if `PUSH_ENABLED`.

**Mobile upload**: `#mobile-upload-sheet` bottom sheet has separate `#mobile-upload-pilot-select` and `#mobile-file-input`; handled by `handleMobileUpload()` which mirrors `handleUpload`.

**Upload reminder**: `showUploadReminder()` (~line 7454) fires after `loadPilot()` if the pilot has no flights for the current month (and hasn't seen the reminder for that month/pilot key). Shows `#upload-reminder` banner with "Upload Now" button.

---

## Add flight modal (`submitAddFlight()`, ~line 7024)

Opened by "+" button (desktop header or mobile). Supports 4 flight types:
- **Work** — `trip` = pairing #, no special flag
- **DH** — `is_dh = true`  
- **Commute** — `trip = 'COMMUTE'`, `is_manual = 1`
- **Personal** — `trip = 'PERSONAL'`, `is_manual = 1`

**Fields:** Pilot selector (hidden if not admin), date, DEP/ARR airports (auto-uppercased), dep/arr times, block time (auto-calculated from times if not manually edited), flight #, tail #.

**Block time auto-calc** (`autoComputeBlockTime()`): when dep/arr airports + times are all filled and user hasn't manually edited block time → looks up airport timezones, converts to UTC, computes diff. Shows "(auto-calculated)" label; if user edits manually it changes to "(manual)".

`submitAddFlight()` POSTs to `/api/pilots/:key/add-segment`, then calls `loadPilot(currentPilot)` to refresh. In edit mode (editing an existing manual segment), it calls `PUT /api/pilots/:key/segments/:id` instead.

**Edit ground transport**: separate `#edit-ground-modal` (simpler, no type picker). Opened from day detail sheet for `type=ground` segments.

---

## Notifications system

### Push notifications
- Service worker `/sw.js` registered by `initServiceWorker()` at app start.
- `initPushNotifications()` runs after identity resolves. If permission already granted → `subscribeToPush()`. If not asked yet → shows `#notif-prompt-sidebar` (desktop sidebar banner) prompting user to enable.
- `subscribeToPush()`: fetches VAPID public key from `/api/push/vapid-key`, creates Web Push subscription, POSTs `{ token, subscription }` to `/api/push/subscribe`.
- Server sends push when crossings are computed after an upload/sync via `broadcastCrossingNotifications()`.
- SW message `{ type: 'OPEN_OVERLAP' }` → `switchView('overlap')` (tapping a push notification opens the crossings tab).
- `PUSH_ENABLED` const controls whether push features are active. `myToken` (URL token) is sent with subscriptions so server knows which pilot.

### In-app crossing alerts (badge + modal)
`updateCrossingAlert(overlaps)` (~line 8132):
- Filters overlaps to only those involving `myPilot`, within next **48h** (`XALERT_BADGE_WINDOW`).
- Cross-references against `localStorage['cs_xacked']` (acked crossing keys) to show unread badge count only.
- Updates `#crossing-badge-mobile` and `#crossing-badge-desktop` (orange badge on Overlap nav icon).
- Crossings within **24h** (`XALERT_MODAL_WINDOW`) AND not yet shown this session → shows `#crossing-alert-modal` once per session (`sessionStorage['cs_modal_shown']`).
- `ackMyCrossings()` called when user opens crossings view — marks all as seen, clears badge.

### Notification panel (`#notif-panel`)
Bell icon (desktop header + mobile) opens slide-down panel. `loadNotifications()` fetches `/api/notifications?token=…` on load. Panel shows title, body, relative timestamp, unread dot. Clicking any notification → `switchView('overlap')` + marks all read via `PATCH /api/notifications/read`.

App badge (`navigator.setAppBadge()`) set to unread count where supported (iOS 16.4+).

---

## Crew Intel view (`#view-intel`)

**State variables:**
- `_intelAll` — flat array of all intel entries (from `/api/intel`)
- `_intelView` — `'airports'` | `'map'` | `'detail'`
- `_intelDetailAirport` — IATA code when in detail view
- `_intelFilter.category` — `'all'` | `'hotel'` | `'food'` | `'activity'` | `'tip'`
- `_intelSearch` — search string for airports list
- `_intelMap` — Leaflet instance for map view (separate from main `map`)

**Views:**
1. **Airports list** (`renderIntelAirports()`): One card per airport with intel, sorted alphabetically by city name. Color-accented left border (dominant category color). Click → detail view.
2. **Intel map** (`renderIntelMap()`): Leaflet map with SVG thumbtack pins. Pin color: single-category = that category's color, mixed = red. Pin count badge shows total tips at that airport. Clicking a pin opens popup with category breakdown + "VIEW N TIPS →" button.
3. **Detail view** (`renderIntelDetail()`): Shows all tips for one airport, filterable by category pill. Each card shows: category badge, title, body (collapsible if >180 chars), author (pilot first name + color dot), date. Own entries show Edit/Delete buttons.

**Data flow:**
- `loadIntelCounts()` fetches `/api/intel` → `_intelAll`. Called on `switchView('intel')`.
- `saveIntelTip()` POSTs to `/api/intel` or PUTs to `/api/intel/:id` for edits.
- `deleteIntelTip(id)` sends `DELETE /api/intel/:id` after `showConfirm()`.

**Category colors:** hotel=#60a5fa (blue), food=#fbbf24 (amber), activity=#4ade80 (green), tip=#c4b5fd (purple). Mixed pins are #ef4444 (red).

**Intel map persistence:** When toggling back to map view, `_savedCenter` and `_savedZoom` preserve the previous pan/zoom position.

---

## Admin panel (`openAdminPanel()`, ~line 7508)

Accessible from Profile Sheet → "★ Manage Users" (admin only). Two tabs:

**Users tab:** Lists all pilots/viewers from `/api/pilots`. Per user: initials avatar, name, key, base, home_airport, role, parser type, token, last-active. Edit/delete buttons. "+ Add User" opens `#edit-user-modal`.

**Dashboard tab:** App stats — total segments, pilots, segments per pilot, last sync times.

**Edit/Add User modal (`#edit-user-modal`):**
- View-only toggle (👁 mode): hides pilot-specific fields (base, home_airport, airline, role), marks user as `role='viewer'`.
- Airline selector determines `parser_type`: GoJet→`csv`, SkyWest→`vcs_skywest`, Republic→`csv`, SunCountry→`ics_scx`, RosterBuster→`ics_rosterbuster`, Other→`other`.
- When RosterBuster selected, shows ICS URL field.
- `saveUser()` → POST `/api/pilots` (new) or PUT `/api/pilots/:key` (edit). Auto-generates pilot_key from first name (lowercase, deduped).
- After save: alerts user of generated `?u=TOKEN` personal link to share.

---

## PWA / service worker

**Service worker `/sw.js`:**
- Registered on every app load. Handles background push notifications.
- On push receive: parses payload, shows system notification with title + body.
- On notification click: sends `{ type: 'OPEN_OVERLAP' }` to client → app switches to Crossings tab.

**PWA install prompt (`#pwa-prompt`):**
- Shows on mobile when app is not yet installed (not in `standalone` display mode).
- iOS: shows manually crafted "Add to Home Screen" instruction (no native install API on iOS).
- Android: listens for `beforeinstallprompt` event → `pwaInstall()` triggers native prompt.
- Dismissed state saved to `localStorage['pwa_dismissed']`. Not shown again for 7 days.

**Auto-refresh on resume:**
```js
// In <head>, runs immediately before any scripts
if (document.visibilityState === 'hidden') hiddenAt = Date.now();
else if (hiddenAt && Date.now() - hiddenAt > 5 * 60 * 1000) window.location.reload();
```
This refreshes the app after 5 minutes of backgrounding (e.g., reopening from iOS home screen), ensuring schedules are current.

**Manifest:** `manifest.json` served with `?u=TOKEN` from the `<link rel="manifest">` tag injected in `<head>` so each pilot's installed PWA has their token baked into the manifest's `start_url`.

---

## UI components and modals reference

| Element | Opens via | Purpose |
|---|---|---|
| `#day-detail-sheet` | `showDayDetail(dateKey)` | Day events bottom sheet; bottom on mobile, centered on desktop |
| `#add-flight-modal` | `openAddFlight()` | Add/edit manual flight (all types) |
| `#edit-ground-modal` | Edit button on ground leg card | Edit ground transfer airports/times |
| `#schedaero-modal` | "Sync Schedaero" button | Kyle's Schedaero sync: URL, API token, cookie, month range |
| `#drew-ics-modal` | "Sync Schedule (Drew)" button | Drew's RosterBuster ICS URL input |
| `#ics-sync-modal` | "Sync Schedule" button (generic ICS pilots) | ICS URL for any ICS-type pilot |
| `#mobile-upload-sheet` | Mobile nav Upload button | Mobile bottom sheet for upload/sync |
| `#profile-sheet` | Avatar button (mobile) or sidebar identity row | Identity, personal link, crew visibility, notifications toggle |
| `#admin-panel` | Profile → "Manage Users" (admin) | User list + dashboard tabs |
| `#edit-user-modal` | "+" or Edit in admin panel | Add/edit pilot or viewer |
| `#overlap-detail-modal` | Tap "Also Nearby" crossing row | Expanded crossing detail |
| `#crossing-alert-modal` | Auto, once per session if crossing within 24h | Crossing alert popup |
| `#intel-modal` | "+ Add" in Crew Intel | Add/edit intel tip |
| `#notif-panel` | Bell icon | Notification history panel |
| `#confirm-modal` | `showConfirm(title, body)` | Generic destructive action confirmation |
| `#overlap-help-modal` | "?" button in Crossings view | Crossings type explanation |
| `#intel-help-modal` | "?" in Crew Intel | Crew Intel explanation |
| `#grid-help-modal` | "?" in Calendar view | Calendar color coding help |
| `#list-help-modal` | "?" in List view | List view explanation |
| `#map-help-modal` | "?" in Map view | Map modes explanation |

**Bottom sheet swipe-to-dismiss:** `setupSheetSwipe(panelEl, dismissFn)` registers touchstart/touchmove/touchend on any bottom sheet panel. Dragging down >80px triggers dismiss with a 220ms slide-out animation.

---

## Layout structure

```
body (flex row, 100dvh)
  #sidebar (hidden md:flex, 256px)        ← desktop nav + pilot list + upload section
  div.flex-1 (main content column)
    header (desktop or mobile)
    #empty-schedule-banner                 ← shown when pilot has no data
    #mobile-pilot-bar                      ← horizontal scroll pill nav (mobile only)
    #mobile-next-trip                      ← next flight strip (signed-in pilots)
    main.flex-1
      #view-grid    .view-section          ← calendar
      #view-list    .view-section          ← list
      #view-map     .view-section          ← map + mobile mode bar
      #view-overlap .view-section          ← crossings + off days
      #view-intel   .view-section          ← crew intel
    nav.mobile-nav                         ← fixed bottom: Grid, List, Map, Overlap, Intel, Upload
```

Only one `.view-section` has `.view-active` (display:block/flex) at a time. `switchView()` swaps the class. View fade-in is a 0.14s CSS animation on `.view-active`.

**Desktop sidebar:** Collapsible via hamburger `toggleSidebar()`. `#sidebar.sidebar-hidden` sets width:0, overflow:hidden, opacity:0 with CSS transition.

---

## Color constants (pilot colors)

Used in Crew Intel (`PILOT_COLORS`), map legend, sidebar avatar circles, mobile pill active state, and flight card accents:
```js
PILOT_COLORS = {
  kyle: '#3b82f6',   // blue-500
  adam: '#2dd4bf',   // teal-400
  sam:  '#f97316',   // orange-500
  logan:'#818cf8',   // indigo-400
  drew: '#fb7185',   // rose-400
}
```
Additional non-core pilots (brett, hunter, nick, jack) have colors defined inline; further pilots get `_dynamicColorPool` rotating palette.

**Source of truth**: always read from `PILOT_COLORS` constant in app.html (~line 2109). Hardcoded HTML uses these values as rgba; e.g. `#3b82f6` → `rgba(59,130,246,0.15)` for avatar circle background.

---

## UI theme (server branch — aviation boarding pass style)

### Flight cards (day detail sheet + list view)
- **`.bp-card`** — boarding pass container: `overflow:hidden`, `border-radius:16px`
- **`.bp-apt-code`** — 38px monospace airport code (30px on mobile)
- **`.bp-top-bar`** — 3px accent gradient bar at card top
- **`.bp-tear-line`** / **`.bp-stub`** — dashed separator + stub section with flight meta + barcode decoration
- **`accentColor` hierarchy** (day detail & list): `isActiveLeg → #22c55e` > `isPersonal → #a78bfa` > `isCommute → #f59e0b` > `PILOT_COLORS[currentPilot]`

### Sidebar pilot buttons (`#sidebar-pilot-list`)
- **`.pilot-avatar-btn`** — full-width button with colored initials circle (`w-7 h-7 rounded-full`) + pilot name
- Circle background/border/text use `PILOT_COLORS[pilot]` rgba values (hardcoded in HTML, must match JS constant)
- Active state set by `loadPilot()`: `btn.style.background = pc + '1a'`, `btn.style.borderColor = pc + '55'`

### Mobile top header (`header.md:hidden`)
- Contains: identity avatar (`#identity-avatar`), month info (`#mobile-header-month-info`), prev/next month buttons (`#mobile-prev-btn`, `#mobile-next-btn`), notifications bell (`#notif-bell-btn-mobile`), help button, add flight button (`#btn-add-flight-mobile`)
- **Calendar-specific controls** (`#mobile-header-month-info`, `#mobile-prev-btn`, `#mobile-next-btn`, `#btn-add-flight-mobile`) are hidden via `style.display='none'` on `overlap` and `intel` views — only the avatar, bell, and help `?` remain visible
- This toggle happens in `switchView()` — `calView = view === 'grid' || view === 'list' || view === 'map'`

### Mobile nav bar (`.mobile-nav`)
- Each button is `56px` tall with `.mbtn-icon-wrap` (38×28px, `border-radius:10px`) wrapping the SVG
- Active: `.mbtn-active .mbtn-icon-wrap` gets `background: rgba(59,130,246,0.13)` + icon/label color `#3b82f6`
- Top indicator line (`.mbtn::before`): 2px, `#3b82f6`, animates width from 0→28px on active

### Mobile pilot pills (`#mobile-pilot-bar`)
- Active pill uses `PILOT_COLORS[pilot]` (border + color + background) via `loadPilot()` JS
- Inactive: `border-zinc-700 text-zinc-400`

---

## Schedaero sync (Kyle)

**Full sync** (`openSchedaeroSync()` → `syncSchedaero()` → `POST /api/pilots/kyle/sync-schedaero`):
- Requires: GetMonth URL, API token (x-avinode-apitoken header), full session cookie.
- Syncs configurable month range (back 0–6, ahead 1–6 months).
- Credentials saved server-side in `settings` table after successful sync.

**Quick sync** (`quickSyncSchedaero()` → `POST /api/pilots/kyle/quick-sync-schedaero`):
- Uses saved credentials (URL + token + cookie from settings table).
- If session expired (302 redirect or auth error) → opens `#schedaero-modal` in cookie-only mode (URL/token fields hidden, "session expired" banner shown, "Edit URL & API token" toggle available).
- Quick sync button shown on mobile upload sheet.
- Auto-sync runs quick sync at 06:00, 14:00, 22:00 UTC daily (server-side `setTimeout` chain, not cron).

---

## Offline / connectivity

`#offline-banner` (red bar at top) appears when browser goes offline (`window.addEventListener('offline')`). Slides down from top. Disappears on `'online'` event.

The service worker does not cache API responses — it's push-only. There is no offline data mode; all schedule data requires network.

---

## `flightLocalDate` / `flightUTCTime` — when to use each

`flightLocalDate(isoStr, airportCode)` → `'YYYY-MM-DD'` string at the airport's local timezone. Use when checking which calendar day an event falls on.

`flightUTCTime(isoStr, airportCode)` → `Date` object in true UTC. Use when comparing times across pilots or checking if a flight is currently active (`depMs <= now <= arrMs`).

Never use `new Date(localString) < now` directly for crossings or "currently airborne" checks — local browser time may differ from airport timezone by hours.
