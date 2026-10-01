# CrewSync — Developer Context for Claude

## What this app is

CrewSync is a private PWA for a group of 5 corporate/regional pilots (Kyle, Adam, Sam, Logan, Drew) to coordinate schedules. Key views: Calendar, List, Route Map, Crew Planning (Crossings + Off Days). Backend: Node/Express + SQLite. Frontend: single-file `public/app.html` (~11 k lines, all views and logic inline).

Kyle also runs a Tampermonkey userscript (`public/frat-autofill.user.js`) that autofills PRISM SMS flight risk assessments from his CrewSync schedule — see its own section below.

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
| `public/frat-autofill.user.js` | Tampermonkey userscript — autofills Kyle's PRISM SMS flight risk assessments |

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
| `render()` | ~6485 | Main calendar/list render dispatcher |
| `renderMap()` | 4857 | Single pilot monthly route map |
| `renderAllPilotsMap()` | 4715 | All-crew monthly map |
| `renderDayMap()` | ~5828 | All-crew single-day map |
| `distanceProportionalArc()` | 4826 | Bezier-bowed great-circle arc for a single route (no de-overlap; `renderMap()` has no cross-route overlap handling at all — see note below) |
| `offsetArc()` | 5238 | Bezier arc with perpendicular offset — spreads multiple flights sharing an identical city pair (used by `renderDayMap()` only) |
| `inferAwayLayovers()` | 2880 | Generates synthetic 'away' events for overnight non-home stays |
| `switchView()` | 3200 | Switches between calendar/list/map/overlap views |
| `switchOverlapTab()` | 3315 | Crossings ↔ Off Days tab switch |
| `computeOverlap()` | 3928 | Crossings pipeline (fetch → buildGroundPeriods → classify → render) |
| `buildGroundPeriods()` | ~3942 | Inside computeOverlap; emits ground windows per pilot |
| `computeOffDays()` | 3517 | Off Days pipeline |
| `renderCommonOffSection()` | ~3152 | Renders off day rows + filter chips |
| `showDayDetail()` | 7194 | Opens day detail bottom sheet for a date key |
| `handleUpload()` | 7160 | File upload handler → `uploadPilotSchedule()` |
| `submitAddFlight()` | 7722 | Saves manual flight from add-flight modal |
| `flightAwareLink()` | ~5288 | Wraps a flight ident in a FlightAware tracking link, gated by `flightAwareEligible()` (departed or within 48h) |
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
- `homeBase` = `data.base` (airline domicile) — arrival here is skipped for commuters (base ≠ home city). For non-commuters (base = home city, e.g. Drew/Kyle), arrival falls through to the homeCity branch so an at-home ground period is generated (`if (home && arr === home && homeC !== home) return`)
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

**Known limitation — reserve segments not included in `buildGroundPeriods`:**

`buildGroundPeriods` only processes `type='flight'` and `type='ground'` segments. Reserve blocks are ignored. This means: if pilot A is on reserve at SFO and pilot B has a layover at SFO, no crossing is generated. In practice this hasn't caused missed crossings (verified Aug–Sep 2026) because no other pilot overnights at a reserve base simultaneously. If it becomes an issue, the fix is to synthesize a ground period from each reserve block's `departure_time → arrival_time`.

**Step 2 — cross pilot pairs**

`airportsNear(a, b)`: checks metro groups first, then haversine ≤50mi.

Skip condition: both pilots at their own homes → skip (line ~4173).

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

**Perf gotcha — `computeOverlap()`/`computeOffDays()` need a real paint yield before the heavy work.** Both functions set a loading spinner then `await Promise.all(...)` to fetch any uncached pilot data. When every pilot is already cached (the common case), that `await` resolves via microtasks with no real fetch — no macrotask boundary, so the browser never gets a chance to paint the spinner before the (fairly heavy) `buildGroundPeriods`/cross-pairing/render work runs synchronously right after. This made opening the Overlap view feel like it hung before the view even appeared. Both functions now do `await new Promise(r => setTimeout(r, 0))` right after setting the spinner HTML, forcing a real paint before the pipeline starts. Don't remove this — it doesn't change *when* the calculation runs, only guarantees the spinner is visible first.

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

### RosterBuster ICS parser (`parseRosterBusterICS`, server.js) — emoji-prefix convention

Drew's feed (`ics_rosterbuster`) uses a consistent emoji prefix per event type in `SUMMARY`: `✈️` = flight, `➡️ (DH)` = deadhead, `🛰` = reserve (e.g. `🛰 Long Call Reserve - LCR`). The parser matches on these prefixes and does `if (!match) continue` for anything else — **any future event type using a new prefix will be silently dropped**, not erred on, so if a pilot's schedule ever looks like it's missing days, check the raw ICS feed (`GET /api/pilots/:key/ics-url` → fetch that URL directly) for `SUMMARY` lines that don't match one of the three known prefixes before assuming the data itself is wrong.

Found this exact way: reserve (`🛰`) support didn't exist until 2026-09-21 — Drew had 5 upcoming "Long Call Reserve" blocks that were completely invisible in CrewSync (not on the calendar, not in Off Days, not in Crossings) because they never made it past the flight-only match. Unlike the eCrew parser's `RESR`/`RAP` handling (which needs to parse the actual on-call window out of `DESCRIPTION`, since `DTSTART` there is duty/report time), RosterBuster's `DTSTART`/`DTEND` directly *are* the on-call window — verified against the raw feed before writing the fix, not assumed.

**The trip-numbering pass after parsing only makes sense for flights.** It assigns synthetic sequential trip numbers (not real airline pairing IDs) by walking all events in departure-time order and bumping the counter on a new day's STL departure. Any non-flight event type added to this parser must be excluded from that loop (`trip` stays `null`) — otherwise it consumes a trip-number increment and shifts every subsequent flight's trip number. Reserve is already excluded; keep that pattern if training/vacation/etc. ever get added here too.

### Delta "MiCrew" ICS parser (`parseDeltaMiCrewICS`, server.js) — `parser_type: 'ics_delta_micrew'`

Added 2026-09-30, built against one real Delta pilot's published iCloud calendar (confirmed genuine via `X-APPLE-CREATOR-IDENTITY:com.delta.micrew.prod`), before he had a CrewSync account. **Structurally different from every other ICS source in this app: each `VEVENT` is an entire multi-day trip/pairing, not one flight leg.** `SUMMARY` is just a compact one-liner (e.g. `5086 LAX, MCO (1020-1539)`); the actual leg-by-leg itinerary lives as free text inside `DESCRIPTION`:
```
Rpt- 1020 01JUL
DL673       ATL-LAX     11:15-12:53   3NE
LAYOVER   16:37/LAX
...
Rpt- 0600 02JUL
DL482       LAX-JAX     07:01-15:25   3NE
DL482       JAX-MCO     16:26-17:18   3NE
```
The parser walks each `DESCRIPTION` line-by-line, tracking a current calendar date that advances on each `Rpt-` line (report day) and rolls forward mid-leg if a leg's arrival clock time is numerically earlier than its departure (crossed midnight). Times in the description are already local to each leg's own airport, matching CrewSync's local-time storage convention directly — no timezone conversion needed for the *stored* departure/arrival strings, unlike the eCrew/RosterBuster parsers.

**`blockMinutes` still needs real timezone math even though storage doesn't.** The frontend's `calcBlockMins()` only computes a correct duration from stored local-time strings when both ends share a timezone (or the segment is manual, which gets its own airport-aware path) — for a normal synced segment it just does `new Date(arrivalTime) - new Date(departureTime)` on the two local strings directly, which is silently wrong by the UTC offset difference whenever a leg crosses timezones (most of this network). **Found live**: this originally shipped with every leg's `blockMinutes: null`, relying on that fallback, and produced wrong block times on real schedules (e.g. ATL→LAX) before being caught and fixed. The parser now computes real `blockMinutes` itself via `_aptTimezone[dep]`/`_aptTimezone[arr]` (the airport DB's IANA timezone, already loaded for other parsers) and `localTZToUTC()`, so a correct value is always stored and the frontend's naive fallback is never actually exercised. **Any new local-time-based parser must do the same** — don't leave `blockMinutes: null` for real flight legs and assume the frontend will compute it correctly; it won't, for any leg that changes timezone.

**That fix alone wasn't enough — `syncPilotICS()` was silently discarding `blockMinutes` on every write, insert or update.** Both its `INSERT INTO segments` and `UPDATE segments` calls hardcoded the `block_minutes` bind parameter to the literal `null` instead of `ev.blockMinutes`, for every pilot on direct ICS sync (not just these three parsers — this bug predates them). A parser could compute a perfectly correct value and it would still end up `null` in the database, because the write path threw it away before it ever reached SQLite. **Found live**: a pilot (Mark, Delta) re-synced after the parser fix shipped and still saw wrong block times — `GET /api/pilots/:key` showed `block_minutes: null` on exactly the affected segments, which is what exposed this. The upload-handler's own `INSERT` (a separate code path, `POST /:key/upload`) already did this correctly (`event.blockMinutes || null`) — only `syncPilotICS()` had the hardcoded-null bug. Fixed by changing both bind arrays to `ev.blockMinutes||null`. Verified against the real HTTP endpoint (not just the parser function) with a throwaway local test pilot: first sync (insert path) and a second sync of the same pilot (update path, matched by the `type|departureTime|departureAirport` key) both now persist the correct value. **Lesson: a parser returning the right data isn't the same as that data reaching the database — check the actual persisted row, not just the parser's return value, before calling a fix complete.**

**Leg-line prefix letters (optional, before the carrier code) — found by missing-data reports, not documentation, since none exists for this format:**
- `D ` / `DD ` — deadhead on a Delta-numbered flight (e.g. `D DL1437`).
- `O ` — deadhead riding another operator's metal, confirmed via real examples across two different pilots' feeds (`O OO3921`/`O OO4132`/`O OO4156`/`O OO3941`, all SkyWest/Delta Connection legs repositioning). Treated as DH with confidence: a Delta mainline pilot can never crew a regional partner's aircraft, so any `O`-prefixed leg on this feed is necessarily a deadhead regardless of which regional carrier's code follows.
- `I ` — found on **every leg of an entire real multi-day pairing** (not an isolated repositioning leg), which doesn't fit the deadhead pattern at all. Parsed as a normal working flight (`dh: false`) rather than guessed as deadhead — likely an instructor/IOE-support marker, but unconfirmed. If a future report says an `I`-prefixed trip is actually a deadhead, revisit this.
- `G 0000` is a different shape entirely, not a prefix in front of a real carrier code — `0000` is a placeholder flight number standing in for "no flight." It means ground transport between two airports in the same pairing (e.g. `G 0000  HPN-JFK  14:20-16:20`, a car/van leg bridging a deadhead-into-HPN with the next real departure from JFK) and is matched by its own `GROUND_RE` before `LEG_RE` ever sees the line, producing a `type: 'ground'` segment.
- The three real letter-prefixes require mandatory whitespace after the letter in the regex (`(?:(DD|D|O|I)\s+)?`) so e.g. `O` can't accidentally consume the leading letter of an unprefixed `OO3921` operating-carrier code — the exact kind of regex trap that already bit this parser once (see the `DL`/`D` case below).
- The trailing equipment/tail field is **optional**, not required — a handful of real legs (an international `DL156 JFK-ACC` with no equipment column at all) have nothing after the time range, and requiring `\s+(\S+)` there silently dropped those legs entirely. `tail` falls back to `''` when absent.

**Any future unrecognized prefix or line shape on a leg line will silently drop that leg (and anything that depends on it, like the following overnight layover) rather than erroring.** This is how the `O`-prefix, `I`-prefix, missing-equipment, and `G 0000` ground-leg gaps were all originally found: a pilot's schedule was missing specific days, and the fix each time was fetching the raw feed directly (`GET /api/pilots/:key/ics-url` → fetch that URL) and diffing every leg-shaped `DESCRIPTION` line against what the regex actually matches, not just eyeballing the parsed output. Do this same check across a pilot's *entire* feed history (not just the reported missing date) before considering a prefix-related fix complete — most of the gaps above were only found by doing exactly that scan after fixing an earlier one, not from the original bug report.

**Non-flying days use short, undocumented codes** (`SUMMARY` like `XX`, `PVAC`, `IOE`, `20TR`) whose actual meaning is the *last line* of `DESCRIPTION` (e.g. `RESERVE DAY OFF`, `PRIMARY VACATION DAY`, `INITIAL OPERATING EXPERIENCE`, `320 TRAINING DAY`). Non-reserve, non-flying days are classified by keyword match on that text, not the code — the codes aren't documented anywhere accessible and vary a lot (payroll adjustments, personal drops, sim periods, parental leave, death in family, etc.). Only `VACATION`- and `TRAINING`/`SIMULATOR`/`OPERATING EXPERIENCE`-keyword matches produce a segment (`vacation`/`training` respectively); **everything else is skipped entirely except reserve (below), including `RESERVE DAY OFF` and `RESERVE GOLDEN OFF DAY`** — both are days OFF from reserve, not on-call days, so storing them as `reserve` segments would have been wrong. Also skipped (and confirmed intentionally, not yet-another gap): `SICK`, `REST`/`Pilot ... Rest`/`DESIGNATED REST`/`SUCCEEDING AUTO REST`, `SCC` (Short Call Credit), `OK TO RETURN TO FLYING`, `P/DR` (Personal Drop on a Reserve Day), `ADJ` (Pay Adjustment), `FULL` (Pilot Finished for the Month) — none of these represent working time, so leaving them unsegmented and letting the day default to "off" (no segment present) is correct, matching how `RESERVE DAY OFF` already worked.

**Reserve (on-call) detection, added 2026-09-30 against a second real feed that actually had reserve history** (the first pilot's feed this parser was originally built from had none, going back to 2023 — see git history for that original deferral). Reserve is identified by `SUMMARY` being exactly `LC` (Pilot Long Call) or `SC` (Short Call) — **not** by keyword-matching `DESCRIPTION` like the other non-flying markers, since `LC`/`SC` is a clean, stable code. Unlike the non-flying full-day markers, these events' `DTSTART`/`DTEND` carry a real sub-day window that directly **is** the on-call period — confirmed by cross-referencing the raw feed: every `LC` block is immediately followed, starting the very next minute, by a `Pilot ... Rest` marker once the window lapses, which only makes sense if the preceding window really was "available to be called." No airport is given on these events (no `LOCATION` field exists anywhere in this ICS format); the upload/sync handler's existing fallback (fill `departureAirport`/`arrivalAirport` from `pilot.base` when a `reserve` event has none — the same fallback the VCS parser's bare `RE` blocks already rely on) handles it without any parser-side change needed.

Wired identically to the RosterBuster parser: `parser_type = 'ics_delta_micrew'` dispatches in both the upload handler and `syncPilotICS()`; selectable via the admin panel's airline dropdown (`AIRLINE_OPTIONS` in app.html, `icao: 'DAL'`) which shows the generic ICS URL field. One Delta-specific wrinkle: iCloud publishes these as `webcal://` links — `syncPilotICS()` normalizes that to `https://` before fetching, since Node's `fetch` doesn't understand the `webcal` scheme.

### American Airlines "MobileCCI" ICS parser (`parseAmericanICS`, server.js) — `parser_type: 'ics_american'`

Added 2026-10-01, built against one real pilot's export (`PRODID:-//American Airlines//MobileCCI//EN`). **Much simpler shape than Delta/RosterBuster/eCrew: one `VEVENT` per flight LEG, not a whole pairing.**
```
UID:FLT-1791211500@mobilecci
DTSTART:20261005T104500
DTEND:20261005T130500
SUMMARY:FLT 478
DESCRIPTION:SEQ#: 10195\nFlight#: 478\nStations: PHL→PHX\nLocal Time: ...\nUTC Time: ...
```
`DTSTART`/`DTEND` have no `Z` or `TZID` but are confirmed **already local** (departure-airport-local for `DTSTART`, arrival-airport-local for `DTEND`), verified by checking they match `DESCRIPTION`'s "Local Time" field exactly rather than its "UTC Time" field for the same leg — no timezone conversion needed, matching CrewSync's storage convention directly like the Delta parser.

A second `VEVENT` type, `UID:Layover-*` (`SUMMARY: Layover in XXX`), is purely informational and is skipped — CrewSync already computes layovers itself via `buildGroundPeriods`/`inferAwayLayovers`, so storing these too would be redundant. The parser identifies real legs by `UID` starting with `FLT-`; anything else (currently just `Layover-*`) is skipped.

Fields taken from `DESCRIPTION`: `SEQ#` → `trip` (pairing number), `Flight#` → flight number (prefixed `AA` since the feed itself never includes a carrier letter code), `Stations: DEP→ARR` → departure/arrival airports (unicode `→`, matched loosely in case the separator ever varies).

`blockMinutes` is computed via `_aptTimezone`/`localTZToUTC` (same as Delta's parser — see its "still needs real timezone math" note above), not left `null`. `DTSTART`/`DTEND` are already `YYYYMMDDTHHMMSS` with no reformatting needed before passing to `localTZToUTC`.

**Not seen in the one feed this was built against, so NOT handled — don't guess, get a real example first (same reasoning as the Delta parser's original reserve deferral):** deadhead legs (no example had one, and it's unclear what would mark it — not even an `I`/`D`/`O`-style prefix exists in this format since each VEVENT is already a single leg with no shared prefix line), reserve/on-call days, vacation/training/sick/any other non-flying marker, and equipment/tail number (never present in `DESCRIPTION` here). If a pilot using this parser reports a missing day or an obviously-wrong deadhead flag, the fix is the same pattern used throughout this file: fetch the raw feed directly and read what's actually there rather than assuming it matches another airline's convention.

Wired identically to the Delta parser: `parser_type = 'ics_american'` dispatches in both the upload handler and `syncPilotICS()`; selectable via the admin panel's airline dropdown (`icao: 'AAL'`) and the join flow's company selector, both showing a "MobileCCI ICS URL" field.

### Southwest Airlines "CrewHub BYO" ICS parser (`parseSouthwestICS`, server.js) — `parser_type: 'ics_southwest'`

Added 2026-10-01, built against one real pilot's export (`X-APPLE-CREATOR-IDENTITY:com.swalife.crewhub`, DESCRIPTION footer "Synced from CrewHub BYO"). **Structurally like the Delta MiCrew parser — each `VEVENT` is a whole multi-day trip, not one leg** — but with two differences:
1. `LOCATION` gives the trip number directly (`Trip: DA9X`) — no need to pull it from `SUMMARY` like Delta.
2. **Every leg's departure/arrival time carries its own timezone abbreviation** (`CDT`/`EDT`/`MDT`/...), unlike Delta's bare `HH:MM-HH:MM` with no zone marker:
```
Mon Oct 19
Report 06:20 CDT
3617 DAL 07:20 CDT   DCA 11:10 EDT
1513 DCA 11:50 EDT   MSY 13:40 CDT
Duty 7:50 Block 5:40 Credit 6.70
Layover 15hr 25m
...
Totals: Duty 21:45 Block 15:30 Credit 20.30
```
Southwest's trips routinely cross multiple zones in a single leg (`CDT`→`EDT` on one hop above), so Delta's naive "did the clock go backwards" rollover check isn't reliable here — a short hop landing numerically "earlier" by wall-clock isn't necessarily an overnight. Instead this parser converts each endpoint to real UTC via a fixed abbreviation→offset table (the abbreviation itself already encodes DST, so no IANA timezone lookup is needed) and compares **in UTC** to decide whether a leg's arrival falls on the next calendar day, then re-localizes to the arrival airport's own date for the next leg's baseline. The stored times are still the given local `HH:MM` values directly — UTC is only an intermediate used to get the *date* right, never written to the segment.

`DTSTART;VALUE=DATE`/`DTEND;VALUE=DATE` give the trip's overall start/end calendar date directly (just `YYYYMMDD`, no time) — used as the real anchor for the first day header, which is more solid than Delta's situation (no year-guessing needed), though month-rollover tracking across a long trip is kept for safety, same pattern as Delta.

**Two skip cases found and handled, both from one real trip in the sample feed:**
- `RPRT TPA 06:30 EDT   TPA 06:30 EDT` — a same-airport, non-flight "report" marker. Skipped because the leading token (`RPRT`) isn't purely numeric — real Southwest flight numbers are bare digits with no carrier letters, so a numeric-only check on the leading token cleanly filters this out without needing a same-airport special case.
- `4202 MCO  EDT   MCO  EDT` immediately followed by a second `4202 MCO 19:36 EDT   DAL 21:17 CDT` — the first row has **blank times** (likely an equipment-swap artifact) and is skipped automatically since the leg regex requires real `HH:MM` digits at both ends; only the second, real row produces a segment.

**Deadhead detection was NOT built.** The per-duty-day summary line sometimes carries a trailing letter (`D`/`P`/`M`/`A`, e.g. `Credit 7.68  D`), and `D` plausibly means deadhead, but it's attached to the **whole day's duty period**, which can span several legs — marking every leg that day as DH would likely be wrong as often as right. Don't guess here; wait for a real example that disambiguates which specific leg within a "D" day is the deadhead.

**`GDO` ("Guaranteed Day Off") is its own single-day `VEVENT`** (`LOCATION:GDO`, not `Trip:...`), with no flight legs — skipped entirely, same treatment as Delta's `RESERVE DAY OFF`: the day defaults to off via the absence of any segment, nothing needs to be stored.

`blockMinutes` is `Math.round((arrUTC - depUTC) / 60000)`, reusing the real UTC instants already computed above for date-rollover (see Delta's "still needs real timezone math" note) — no extra airport-timezone lookup needed here since the per-leg `TZ_OFFSET` abbreviation already gives real UTC directly.

Wired identically to the Delta/American parsers: `parser_type = 'ics_southwest'` dispatches in both the upload handler and `syncPilotICS()`; selectable via the admin panel's airline dropdown (`icao: 'SWA'`) and the join flow's company selector, both showing a "CrewHub ICS URL" field.

### Parser warnings — flagging unrecognized schedule items (American + Southwest only, so far)

Both of these parsers were built against exactly one real feed each, which inevitably means they don't cover every event type or line shape that airline's export can produce (deadheads, reserve, a new timezone abbreviation, a malformed leg line, etc.). Rather than let an unrecognized item vanish silently and wait for someone to notice a day is missing, `parseAmericanICS`/`parseSouthwestICS` return `{ events, warnings }` instead of a bare array — `warnings` is a list of plain-English strings describing anything skipped because it didn't match a known shape (an unrecognized `UID`/`LOCATION` type, an unrecognized timezone abbreviation, a line that looks like it's trying to be a flight leg but doesn't parse). Every other parser in this file still returns a bare array — this is deliberately scoped to just these two, not a system-wide refactor.

**Where warnings go:**
- `pilots.parser_warnings` (TEXT column, db.js) stores the most recent parse's warnings as a JSON array — **overwritten every parse, never accumulated**, both from the upload handler and `syncPilotICS()` (so an unattended auto-sync still records findings even with no one watching).
- The upload (`POST /:pilotKey/upload`) and sync (`POST /:pilotKey/sync-ics`, and `syncPilotICS()`'s return value generally) responses also include `warnings` directly, for immediate feedback right after a manual action.
- **Admin-only, by design — regular pilots and viewers never see this.** `app.html`'s admin Users list (`renderAdminUserList`) shows an amber "⚠ N unrecognized items" badge on any pilot whose `parser_warnings` is non-empty, tappable (`showParserWarnings()`) to see the full list via `alert()`. The upload/sync success toasts in `handleUpload()`, `handleMobileUpload()`, and `syncGenericICS()` also surface a warning count immediately — gated behind `myPilot === null && !myViewer` (true admin only, not just "no pilot identity" since a viewer also has `myPilot === null`) since a pilot uploading their own schedule has no need to know their deadhead/reserve detection is incomplete; that's an admin/developer concern until a parser fix ships.

**Known, already-understood warning** (not a new gap, don't re-investigate it as one): Southwest's sample feed always flags `Trip "DP36": line looked like a flight leg but didn't match the expected format: "4202 MCO  EDT   MCO  EDT"` — this is the documented blank-time equipment-swap artifact (see the Southwest section above), immediately followed by a second real `4202` row that parses fine. Expected noise for that specific trip, not a sign of broken parsing.

If this pattern proves useful, extending it to the other parsers (Delta, RosterBuster, eCrew) that currently also silently skip unrecognized lines would be a reasonable next step — not done yet, scope this out explicitly before doing it rather than assuming it's wanted everywhere.

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

**Perf gotcha — never accumulate `innerHTML +=` in the day loop.** Both the grid and list loops used to build their container's HTML with `gridContainer.innerHTML += html` (and same for `listContainer`) inside the per-day loop. Each `+=` re-serializes and re-parses the *entire* accumulated HTML from scratch, making the loop O(n²) over ~30–42 days — this was the cause of a reported lag when swiping between months on mobile, since every swipe triggers a full `render()`. Fixed by accumulating into a local `gridHtml`/`listHtml` string and assigning to `innerHTML` exactly once after the loop. If you ever touch these loops, keep it that way — reintroducing per-iteration `innerHTML +=` will silently reintroduce the lag.

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

### FlightAware links on flight numbers

Every visible flight number/callsign (calendar grid, list view, day-detail sheet, and both map popup types) is wrapped by `flightAwareLink(ident, displayHtml, eligible)`, linking to `flightaware.com/live/flight/{ident}` in a new tab. Uses the same `deriveCallsign()`-derived ident that already drives ADS-B tracking (fixed a prior bug where the day-detail sheet showed the raw stored flight number like `G74536` instead of the normalized `GJS4536` — it was preferring `f.flightNumber` over the already-correct `_dayFlLabel`).

**Gated by `flightAwareEligible(depMs)`** (48h window): a link is only offered for flights already departed or departing within 48h. FlightAware's dateless URL resolves to whichever instance of that ident is nearest to *now* — for airline pilots who reuse the same flight number daily, a farther-out link could resolve to the wrong day; for Kyle's corporate legs, Part 91/135 flight plans typically aren't filed until close to departure, so FlightAware has nothing to show earlier anyway. Eligibility is recomputed fresh on every render, not cached.

### Route overlap on `renderMap()` — tried and reverted, don't redo this approach blind

`renderMap()` (single-pilot "My Routes" map) groups a pilot's flights into one arc per unique `dep|arr` pair with **no overlap handling between different pairs** — unlike the all-crew day view (`renderDayMap()`), which spreads multiple pilots on an identical city pair via `offsetArc()`. Two unrelated legs sharing no airport (e.g. `KUGN→KACK` and `KFOK→KSUS`) can cross or run close for a stretch and look like one line. This is a real, known, currently-unfixed cosmetic issue.

**A fix was built and shipped (2026-09-21/22) and then reverted (2026-09-23) after it made the map actively worse** — a `computeRouteDeclutterOffsets()` pass sampled each route's interior, flagged any two non-touching routes within 110mi of each other as conflicting, and unioned conflicts into clusters via BFS connected-components, feeding each cluster member into `offsetArc()` with an index/groupSize pair. It worked correctly against the small hand-built test cases used to validate it (2-3 routes, a real trip's worth of legs) but broke badly against Kyle's actual "My Routes" data: **the BFS treats conflict as transitive** — if A conflicts with B and B conflicts with C, all three get lumped into one cluster and spread across offset indices, even though A and C may not be close to each other at all. Around a busy hub with many routes, this chains into large clusters where some routes (sometimes short ones) get pushed to extreme offset indices relative to their own length, producing wild, unreadable loops (visibly swinging arcs sweeping up into Canada that had no business being there). It was never tested against a real multi-destination hub before shipping, only small synthetic clusters.

**If this gets revisited:** don't reuse the transitive-clustering approach as-is. Options worth considering instead: only ever offset *pairwise* (never chain through a shared conflict into an unrelated third route), cap the maximum offset magnitude in absolute terms regardless of cluster size/index, or scope any offset to be proportional to how much interior overlap actually exists rather than a fixed step size per cluster slot. Test against Kyle's real live route data (a busy month, not a hand-picked 3-leg trip) before shipping again — that's exactly what this revert would have caught.

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
- `loadIntelCounts()` fetches `_intelFetchUrl()` (`/api/intel`, with `?token=` appended when `myToken` is set) → `_intelAll`. Called on `switchView('intel')`.
- `saveIntelTip()` POSTs to `/api/intel` or PUTs to `/api/intel/:id` for edits.
- `deleteIntelTip(id)` sends `DELETE /api/intel/:id` after `showConfirm()`.
- `voteIntel(id, vote)` POSTs to `/api/intel/:id/vote` — see "Voting" below.

**Category colors:** hotel=#60a5fa (blue), food=#fbbf24 (amber), activity=#4ade80 (green), tip=#c4b5fd (purple). Mixed pins are #ef4444 (red).

**Intel map persistence:** When toggling back to map view, `_savedCenter` and `_savedZoom` preserve the previous pan/zoom position.

**Clutter filters — two independent toggles, both default ON (`_intelVisible()`):** Added after auditing the full intel dataset (434 entries, 426 from one pilot — Drew) for low-value, easily-googled content. Neither filter deletes anything — both just hide from display. `_intelVisible()` is the single function every render path reads through instead of `_intelAll` directly — `renderIntelAirports()`, `renderIntelMap()`, `renderIntelDetail()`, `_rebuildIntelCounts()` (which also feeds the Crossings-card intel badge, `_intelCnt` in app.html), and the header's totals. Edit/delete lookups (`openEditIntel`, `deleteIntelTip`) still search the raw `_intelAll`, unaffected by either toggle. Each persists its own `localStorage` key (`'0'` is the only way to turn a filter off; any other/missing value means ON), with its own pill button in the airports/map header showing a live hidden-count.

1. **`_intelHideGeneric` / `toggleIntelHideGeneric()`** — hides any entry whose `title` or `body` matches `INTEL_GENERIC_RE`: national/state park, national monument, national historic(al) site/park, national seashore, national military park, or memorial (plurals like "National Parks" are handled by a trailing `s?`, not a second pattern — extend this one regex if more NPS-style designations need covering, don't add a parallel one). Catches ~82 entries.
2. **`_intelHideEmptyActivity` / `toggleIntelHideEmptyActivity()`** — hides any `category === 'activity'` entry with a blank `body`: just a bare landmark name ("Louvre Museum," "Hollywood Sign," "NASCAR Hall of Fame") with zero added insight. This is the bigger signal — **70% of all activity entries (193 of 275) have no body at all** — and isn't reliably catchable by keyword matching since it covers every kind of landmark, not just park/monument-style wording. Deliberately a separate toggle from #1 rather than folded in, since it's a broader, content-blind rule (would also hide a genuinely terse-but-useful activity tip) and someone might want one on without the other.

With both ON (the default), roughly half of all intel entries (212 of 434 at last audit) are hidden by default, leaving the other half actually visible without extra taps.

**Voting (`intel_votes` table, db.js; `/api/intel/:id/vote`, server.js; `voteIntel()`, app.html):** Added 2026-10-01 as a crowd-sourced complement to the keyword/blank-body filters above — the crew curates quality directly instead of relying only on heuristics. One row per `(intel_id, pilot_key)` in `intel_votes` (`UNIQUE` constraint — upserted via `ON CONFLICT ... DO UPDATE`, so changing your vote replaces it rather than stacking a second row; a cleared vote (`vote: 0`) deletes the row instead of storing a zero). `GET /api/intel` LEFT JOINs a `SUM(vote)` subquery to attach `score` to every entry, and — only when a `token` query param is given — a second query merges in that pilot's own `my_vote` per entry so the UI knows which arrow (if any) to highlight, without a separate round trip. Any pilot or viewer with a valid token can vote, including on their own entries — consistent with the existing posture that `POST /api/intel` itself doesn't restrict viewers from contributing.

- **Sort order changed**: `renderIntelDetail()` used to group entries by category (`catOrder`); it now sorts by `score` descending (ties broken by newest first) regardless of category — the category pills still let someone filter down to one category if they want that view instead.
- **Vote widget**: a compact ▲ score ▼ control in each card's header, next to the category badge (`canVote = !isDemo && !!myToken` gates it — demo and no-token views see a plain `+N`/`-N` score instead of interactive buttons). `voteIntel()` applies an optimistic local update to `_intelAll` and re-renders immediately, then reconciles with the server's authoritative `score`/`my_vote` on response, or reverts and toasts an error on failure.
- **Redaction, not deletion**: any entry at or below `INTEL_REDACT_THRESHOLD` (`-3`) collapses in the detail view to a one-line "Downvoted by the crew (N) — tap to view anyway" placeholder instead of showing the full card. Tapping it adds the id to `_intelExpandedRedacted` (a plain in-memory `Set`, **not persisted** — resets on reload, same as closing a collapsed Reddit comment only for that session) and re-renders with the full card. This only affects the detail view's rendering, not `_intelVisible()` — a heavily-downvoted entry still counts toward airport totals, map pin counts, and the Crossings-card badge; it's just collapsed where individual entries are actually read.

---

## Admin panel (`openAdminPanel()`, ~line 7508)

Accessible from Profile Sheet → "★ Manage Users" (admin only). Two tabs:

**Users tab:** Lists all pilots/viewers from `/api/pilots`. Per user: initials avatar, name, key, base, home_airport, role, parser type, token, last-active. Edit/delete buttons. "+ Add User" opens `#edit-user-modal`.

**Dashboard tab:** App stats — total segments, pilots, segments per pilot, last sync times.

**Edit/Add User modal (`#edit-user-modal`):**
- View-only toggle (👁 mode): hides pilot-specific fields (base, home_airport, airline, role), marks user as `role='viewer'`.
- Airline selector determines `parser_type`: GoJet→`ics_rosterbuster`, SkyWest→`vcs_skywest`, Republic→`csv`, Sun Country→`ics_scx`, Atlas Air→`ics_ecrew`, Delta Air Lines (MiCrew)→`ics_delta_micrew`, American Airlines (MobileCCI)→`ics_american`, Southwest Airlines (CrewHub)→`ics_southwest`, Other→`other`. (GoJet used to be split into a separate "GoJet Services" (`csv`) and "RosterBuster (subscription)" option — consolidated into the single RosterBuster-ICS option above; this line previously still listed the pre-consolidation `csv` value.)
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
- Header is `items-end` (bottom-aligned content) with `height: calc(56px + max(68px, env(safe-area-inset-top)))` and matching `padding-top`. Fully opaque `bg-black` — no `backdrop-blur-md` (removed; it was compounding with iOS's own translucent-status-bar vibrancy right at the seam, showing up as extra blur near the top edge).
- **The `68px` floor is empirical, not derived from any spec.** On an iOS 27 device with a Dynamic Island, `env(safe-area-inset-top)` reported `59px` — technically correct for the static status bar — but content at exactly that boundary (the "+  Add Flight" button, bottom-aligned and well inside the nominal safe area) still showed half-clipped by whatever iOS renders up there (likely a Live Activity/Dynamic Island capsule, which is dynamic content the static safe-area-inset doesn't account for). `80px` fully cleared it; `68px` was chosen as a livable middle ground after the extra headroom at `80px` looked unnecessarily large. If this recurs on a future iOS version, the fix is this one `max()` floor value, not the padding mechanism itself.
- **`#current-month-display-mobile` must never wrap.** It's `whitespace-nowrap overflow-hidden text-ellipsis` at `text-sm` with `min-w-0` on its flex parent (`#mobile-header-month-info`). Without this, a long month name ("September 2026") that doesn't fit next to the avatar + nav-icon cluster wraps onto two lines; because the header bottom-aligns its content, the wrapped block's extra height pushes its *top* line above the safe-area boundary, landing it under the status bar — this looked like a rendering blur/glitch but was actually just wrapped text pushed out of bounds. Diagnosed via a temporary on-screen readout (`getBoundingClientRect()` + a hidden probe element for the resolved `env(safe-area-inset-top)` value) — that technique is worth reusing for any future "something looks visually wrong on a specific iOS version" report, since guessing at CSS values blind wasted several iterations first.

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

## FRAT Autofill userscript (`public/frat-autofill.user.js`)

Tampermonkey userscript (Kyle only) that autofills PRISM SMS (`prismsms.argus.aero`) flight risk assessment reports from his CrewSync schedule: Date, Origin, Dest, Trip ID, PIC, SIC, Aircraft, TSA, and ~24 risk questions computed from schedule + `aviationweather.gov` + FAA NOTAM data. Served from `/frat-autofill.user.js` with `@updateURL`/`@downloadURL` pointing at prod, so Tampermonkey can auto-update it (though a manual "Check for updates" is faster than waiting on its poll interval).

**`@match` covers the whole `prismsms.argus.aero` origin, not just the report URL.** This was a hard-won fix: PRISM is an Angular SPA, and clicking "Create Risk Assessment" from the landing/list page routes to a new report via `history.pushState` — no real page load. Tampermonkey only auto-injects on an actual navigation, so if the script were scoped to just the report URL, it would never be *running* on the landing page to see that pushState happen, and would only ever catch up on a hard refresh. The script now loads app-wide, sits idle via `isFratReportRoute()`/`isFratLandingRoute()` route checks, and patches `history.pushState`/`replaceState` + listens for `popstate` to react the moment the SPA routes somewhere relevant.

**Full automated pipeline (landing page → filled, saved report):**
1. On `/tools/frat-landing`, shows the same leg-select panel as the report page (`mode: 'landing'`).
2. Picking a leg sets `_pendingFlight`, then `triggerCreateReport()` clicks "Create Risk Assessment" and the template option ("SpiritJets Flight Risk Analysis...") in the dropdown it opens.
3. That creates a report at a fresh, randomly-ID'd URL and routes there via pushState. The SPA-navigation watcher picks up the route change and re-runs `main('report')`, which finds `_pendingFlight` and fills the form immediately instead of showing the leg picker again.
4. After filling, `saveReport()` clicks "Save as Pending" then "Yes" on the confirmation dialog, which routes back to the landing page — closing the loop for the next report.
5. If any automated click fails to find its target, the pending flight is preserved and a status message asks for a manual click — since the flight is still remembered, finishing manually still triggers the auto-fill once the report opens.

**Hard-won lesson on clicking PRISM's UI elements — verify the actual DOM before guessing event types.** The template-dropdown click failed for several iterations, each time diagnosed as a different wrong theory (event type needing a full pointer/mouse sequence, dropdown container scope, search-box filtering side effects) before a live DOM dump (`document.querySelectorAll('body *')` filtered to visible elements matching the target text, printed via `outerHTML`) revealed the real bug: the "smallest textContent" heuristic used to pick the click target was tying against purely-decorative empty wrapper divs (same textContent length as the actual `<button>`, since the wrappers contribute zero extra text) and picking an inert ancestor instead of the real `mat-menu-item` button. **The lesson generalizes: when a click on a found DOM element doesn't do what a real click would, get the actual `outerHTML` of the target before changing the event-dispatch mechanism — the element being wrong is at least as likely as the event type being wrong.** `triggerCreateReport()` now prefers the known static `#btn-frat-add` id over any generic text search.

**Debugging tools already built into the panel:** the "dbg" button in the leg-select panel calls `debugDump()`, which logs all `mat-select` elements, `findAnySelect()` resolution results for known field labels, all visible inputs, and a risk-question-row finder test — check console output there before assuming a selector is broken.

---

## Demo mode (`/demo` route)

`demo-data.js` generates fake pilots (`alex`, `morgan`, `casey`, `jordan`) for the read-only `/demo` preview. `GET /api/demo/pilots/:key` calls `buildDemoSegments()` fresh on every request (not cached at module load), so the server never serves stale demo data no matter how long it's been running.

**Three-month window, not one.** `buildDemoSegments()` generates data for the previous, current, and next month (relative to the server's own clock) and concatenates them per pilot — it does not generate just "the current month." A single-month window was tried first and found insufficient: the server computes "now" using its own clock (UTC on the prod droplet), which can disagree with a visitor's local calendar near a month boundary — e.g. the server has already rolled into the next month (past midnight UTC) while a US-timezone visitor's local evening is still the previous day. Their browser would default to viewing "their" current month while the demo data was anchored to the server's, leaving the view blank. The three-month window makes this mismatch irrelevant since both interpretations of "today" always fall inside the generated range. `anchorForMonthOffset(n)` returns the 15th of the month `n` months from now; `buildForAnchor(ANCHOR, idStart)` builds one month's segments for all four pilots (the `idStart` param keeps segment ids unique across the three calls — 1000/2000/3000).

**Identity display:** `/demo` has no login token, so `myPilot`/`myViewer` are both falsy — the same state as a real admin session. `_applyIdentityUI()` checks `isDemo` before falling back to the admin label, showing "Demo" instead of "Admin" in the sidebar/profile identity display. If adding new identity-driven UI text elsewhere, check `isDemo` the same way rather than assuming `!myPilot && !myViewer` always means admin.

---

## Offline / connectivity

`#offline-banner` (red bar at top) appears when browser goes offline (`window.addEventListener('offline')`). Slides down from top. Disappears on `'online'` event.

The service worker does not cache API responses — it's push-only. There is no offline data mode; all schedule data requires network.

---

## `flightLocalDate` / `flightUTCTime` — when to use each

`flightLocalDate(isoStr, airportCode)` → `'YYYY-MM-DD'` string at the airport's local timezone. Use when checking which calendar day an event falls on.

`flightUTCTime(isoStr, airportCode)` → `Date` object in true UTC. Use when comparing times across pilots or checking if a flight is currently active (`depMs <= now <= arrMs`).

Never use `new Date(localString) < now` directly for crossings or "currently airborne" checks — local browser time may differ from airport timezone by hours.
