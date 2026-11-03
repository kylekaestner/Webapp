# CrewSync: Schedule logic

Current behavior only. Past bugs and why things were built this way: `CLAUDE_HISTORY.md`.

## Crossings pipeline (`computeOverlap`)

**Step 1 — `buildGroundPeriods(segments, homeBase, homeCity)`**

Emits `{ airport, start, end, ... }` windows. Key parameters:
- `homeBase` = `data.base` (airline domicile) — arrival here is skipped for commuters (base ≠ home city), who get the separate commute-home branch below instead. Non-commuters fall through to the homeCity branch (`if (home && arr === home && homeC !== home) return`).
- `homeCity` = `data.home_airport || PILOT_HOME[key]` — has special branch.

**Pre-departure period logic (`recentArr` / `useRecentArr`):** finds the most recent arrival at the departure airport; for home base only valid within 24h; for other airports only valid if the pilot hasn't flown from elsewhere since (a departure from elsewhere means they went home and came back — use a fresh 2h window instead). Prevents month-long pre-departure periods when a pilot returns to the same airport weeks later.

**Commuter arriving at base (`commuteStart`/`commuteEnd`):** a commuter (base ≠ home city) is assumed home starting 3 hours after landing at base, until their next departure from either home or base, capped at 7 days if neither is logged. Two base arrivals close together merge into one period instead of two overlapping ones.

**Arrival period logic (`nextFromArr`, non-commuter / non-home-city arrival):**
- Uses `allDeps` (all segment types, including `trip==='PERSONAL'`) so logged commutes/personal flights terminate ground periods immediately.
- If `nextFromArr` is >2 days away, checks `wentHome`: if the pilot flew from any other airport during the gap, caps the ground period at arrival+8h. Otherwise it runs uncapped to `nextFromArr`.
- No later flight logged at all → pilot assumed to stay at that last arrival airport until one is (7-day sanity bound only).
- The home-city arrival branch uses this same no-cap logic (checking both `nextFromArr` and `nextFromBase`, whichever is sooner), not the 8h cap — that only applies in the generic non-home-city branch's `wentHome` case.

**Reserve windows ARE included** — each `type='reserve'` segment is injected directly as its own ground period at the reserve airport.

**Step 2 — cross pilot pairs.** `airportsNear(a, b)`: metro groups first, then haversine ≤50mi. Both pilots at their own homes → skip (line ~4173).

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

Tier 1-2 → primary cards; tier 3 → compact "Also Nearby" rows. `adjustedPeriod()` shifts times for UTC-storing pilots (Schedaero/Kyle) to match airport local time before overlap comparisons.

**Perf — full history is the trap.** A pilot's segments span their whole history and this runs at startup in the background, blocking taps. `buildGroundPeriods()` works out dates/airports once up front (`tMs()`, `depTimes`, `depApts`, `latestArrAt`, memoized `baseAt()`); doing it per scan cost 2.6s on a phone. The pair loop checks time before distance and skips pairs where both periods ended over 2 days ago, since ended crossings are dropped anyway.

**Perf note — don't remove the paint-yield.** Both `computeOverlap()`/`computeOffDays()` do `await new Promise(r => setTimeout(r, 0))` right after setting the spinner HTML, forcing a real paint before the heavy pipeline runs. Removing this makes the Overlap view feel like it hangs (history: `CLAUDE_HISTORY.md § Crossings pipeline`).

## Built-in logic reference

This section documents non-obvious behaviors already implemented. Check here before assuming something doesn't exist.

### Time handling — two systems coexist

**Kyle** uses UTC times (Schedaero source, strings end in `Z`). All other pilots use local airport time (no timezone suffix). `pilotUsesUtc(k)` detects which system a pilot uses by inspecting the first flight's departure_time string. `flightUTCTime(isoStr, airportCode)` converts any time string to a real UTC Date (use for cross-pilot comparisons — never compare raw `new Date(localString)` across pilots). `flightLocalDate(isoStr, airportCode)` extracts the local calendar date (YYYY-MM-DD) at the airport. `adjustedPeriod(k, p)` shifts a ground period's start/end by the browser-TZ/airport-TZ difference so UTC comparisons between pilots stay consistent.

**Never build an `Intl.DateTimeFormat` in a loop**: very slow, worst on iPhone. `_tzOffsetFmts`/`_tzDateFmts` hold one per zone, and `localTimeToUTC()` memoizes results (`_utcMemo`, returns a new Date each time).

**Local → UTC conversion** (`localTimeToUTC()` app, `localTZToUTC()` server): the DST rules come from the runtime's IANA database via `Intl`, never hand-coded. Both converters take a second pass, reading the offset at the corrected instant. A single pass read it a few hours from the real moment, so on a DST-change day a time shortly after the switch came out an hour off. Times inside the switch itself are inherently ambiguous (fall) or don't exist (spring).

**ADS-B fallback sources**: `api.adsb.lol` and `opendata.adsb.fi` (same readsb v2 format, no key). `api.airplanes.live` was dropped because it 403s every request until a project registers by email.

### "Here Now" / pilot location pins (`renderDayMap`)

Priority order (numbered comments `// ── N. ──` in the code, ~line 7085 onward):
1. **Live ADS-B / SWIM / STDDS** — `_legState(...).state === 'active'` for any of the day's flights → in-air, skip everything below.
2. **Active reserve period** — shown at the reserve airport, *unless* a completed flight to a different, non-reserve airport landed after the reserve began (`wentHomeDuringReserve`).
3. **Reserve ended recently (≤36h ago)** — if the next work segment from that airport departs within 30h, stay anchored there; otherwise fall through.
4. **Active manually-entered `away` segment** — trusted as authoritative (corporate multi-day trips).
5. **Infer from flight + reserve history** — `lastArrival`/`lastArrUTC` starts from the last completed flight's arrival, but a reserve shift that *ended* more recently overrides it (a reserve shift is always sat at base, so it's just as valid an anchor).
5b. **Trip not yet started** — no completed flights at all; if a work flight departs within 24h, show at its departure airport.
6. **Commute prediction** (`isCommuter = atBase && !atHome`) — once `commuteWindowPassed` (local date rolled over, or ≥3h since arrival), shows `Home`; before that, `Heading home` still at the base airport. A non-commuter with no later flight logged just stays `Overnight` at their last arrival indefinitely (the "stay until next logged flight" rule from Crossings above).

**Mid-trip "quick turn" at base** is measured from the pilot's last arrival time, not from "now": if the last arrival was at a non-home airport with a future departure from there, and (not at base, OR the total ground time between that arrival and the next departure is under 18h), they're shown still there (`Layover` same local day, else `Overnight`) rather than sent home.

**`completedFlights` guard**: both `renderMap` and `renderDayMap` require `departureTimeUTC <= now` in addition to `arrivalTimeUTC <= now` before counting a flight as completed — without this, a manually-added transpacific flight whose `arrivalTime` was stored one day too early (a known `inferArrDate` limitation for >12h timezone crossings) would appear completed before it even departs.

**Debug endpoint:** `GET /api/pilots/:key/here-now` returns `{ location, label, step_fired, step_detail, flights }` — a **separate server-side reimplementation** of this same priority chain, not a passthrough of the client's own logic, so the two can drift out of sync — check both when debugging a wrong pin. Uses approximate UTC conversion (raw `isoStr + 'Z'`) for local-time pilots; close enough for debugging, not pixel-perfect.

Full discovery history for the two dated sub-fixes above (reserve fold-in, quick-turn measurement point): `CLAUDE_HISTORY.md § "Here Now" / pilot location pins`.

### `inferAwayLayovers()` — synthetic away events

Runs during `loadPilot()`. Walks all `type='flight'` segments (excluding `trip='PERSONAL'`). Between consecutive flights, if the arrival airport is not the pilot's airline base, not their home airport, and spans a midnight boundary — inserts synthetic `{ type: 'away', arrivalAirport }` events for each day of the layover. These drive calendar "away" coloring but are **not** stored in the DB.

### Off Days detection (`computeOffDays` / `renderCommonOffSection` / `renderOffDayCalendar`)

A pilot is "off" on a date if they have **no** `flight`, `reserve`, or `ground` segments on that calendar date. `trip='PERSONAL'` flights are excluded from the "working" set. Kyle's `type='hard'` and `type='vacation'` segments are both confirmed off days. Reserve windows mark every day in the window as "working" (local airport date, so UTC Kyle doesn't mismark). A date is "common off" when all selected pilots are simultaneously off.

**Off Days tab UI**: List view (default, `renderCommonOffSection()`, chronological rows grouped by date) and Calendar view (`renderOffDayCalendar()`, month grid with colored name pills per off pilot — amber cell = all selected off, green = majority off; independent month nav via `prevOffMonth`/`nextOffMonth`). State: `_offDayView`, `_offDayYear`, `_offDayMonth`, `_offDaySelected`, `_offDayFilter`.

### Auto-sync schedule (server.js)

ICS pilots (Drew, Logan, Sam, Adam) and Kyle's Schedaero sync automatically at **06:00, 14:00, 22:00 UTC** daily — a chained `setTimeout`, not cron. Schedaero keepalive pings every 20 minutes between syncs.

### `buildGroundPeriods` — home city branch (`homeC`)

When a pilot arrives at their home city (distinct from their airline base): looks for the next departure from the home city (`nextFromArr`) AND the next departure from their airline base (`nextFromBase`, since a commuter flies to base before their next trip, ending the "home" window). `groundEnd` = whichever is earlier, capped at arrival+8h if neither exists. Example: Adam lands TUL → home; his next event is an LGA departure (base), found via `nextFromBase`, not a TUL departure.

### Personal/commute flight behavior

- `inferAwayLayovers`: **excluded** (`trip !== 'PERSONAL'`).
- `buildGroundPeriods` `flights` array: **included** — participates as a normal departure/arrival.
- `buildGroundPeriods` `allDeps`: **included** — terminates ground periods at layover airports.
- `computeOffDays` flying-day detection: **excluded** (`trip === 'PERSONAL'`) — doesn't make a day "working."
- `render()` calendar: rendered as its own color-coded type.

### RosterBuster ICS parser (`parseRosterBusterICS`, server.js) — `parser_type: 'ics_rosterbuster'`

Drew's feed uses a consistent emoji prefix per event type in `SUMMARY`: `✈️` = flight, `➡️ (DH)` = deadhead, `🛰` = reserve (e.g. `🛰 Long Call Reserve - LCR`). RosterBuster's `DTSTART`/`DTEND` directly *are* the on-call window for reserve (unlike eCrew's `RESR`/`RAP`, which needs the window parsed out of `DESCRIPTION`). **Any future event type using a new prefix is silently dropped** (`if (!match) continue`) — if a schedule looks like it's missing days, fetch the raw feed (`GET /api/pilots/:key/ics-url`) and check for unmatched `SUMMARY` lines before assuming the data is wrong. The post-parse trip-numbering pass only applies to flights — any new non-flight event type added here must stay excluded from it (`trip` stays `null`), same as reserve already is. History: `CLAUDE_HISTORY.md § RosterBuster ICS parser`.

### Delta "MiCrew" ICS parser (`parseDeltaMiCrewICS`, server.js) — `parser_type: 'ics_delta_micrew'`

Each `VEVENT` is an entire multi-day trip/pairing, not one leg — the real itinerary is free text inside `DESCRIPTION`:
```
Rpt- 1020 01JUL
DL673       ATL-LAX     11:15-12:53   3NE
LAYOVER   16:37/LAX
```
Parser tracks a current calendar date that advances on each `Rpt-` line and rolls forward mid-leg on a crossed midnight. Times in `DESCRIPTION` are already local to each leg's airport — no conversion needed for storage, but **`blockMinutes` still needs real timezone math** (computed via `_aptTimezone`/`localTZToUTC`, never left `null` — a naive `new Date(arr)-new Date(dep)` on two local-time strings is silently wrong whenever a leg crosses timezones). Any new local-time-based parser must do the same.

**Leg-line prefix letters** (optional, before the carrier code, mandatory whitespace in the regex so `O` can't consume an unprefixed `OO3921`'s leading letter): `D `/`DD ` = deadhead on a Delta-numbered flight; `O ` = deadhead on another operator's metal (a Delta mainline pilot can never crew a regional partner's aircraft, so any `O`-prefixed leg is necessarily DH); `I ` = parsed as a normal working flight, not DH (likely instructor/IOE marker, unconfirmed — revisit if a report says otherwise); `G 0000` = ground transport (matched by its own `GROUND_RE` before `LEG_RE`, produces `type:'ground'`). Trailing equipment/tail field is optional — `tail` falls back to `''` when absent (some international legs have nothing after the time range).

**Any unrecognized prefix or line shape silently drops that leg** (and anything depending on it, like the following layover) rather than erroring — check the raw feed and diff every leg-shaped `DESCRIPTION` line against the regex, across the pilot's entire feed history, before considering a gap fixed.

**Non-flying days**: `SUMMARY` codes (`XX`, `PVAC`, `IOE`, `20TR`, etc.) are undocumented and vary — classification goes by keyword match on the *last line* of `DESCRIPTION` instead. Only `VACATION`- and `TRAINING`/`SIMULATOR`/`OPERATING EXPERIENCE`-keyword matches produce a segment (`vacation`/`training`); everything else (including `RESERVE DAY OFF`, `SICK`, `REST` variants, `SCC`, `OK TO RETURN TO FLYING`, `P/DR`, `ADJ`, `FULL`) is deliberately skipped, letting the day default to off.

**Reserve** (`SUMMARY` exactly `LC` or `SC`) — identified by the clean code, not keyword match; `DTSTART`/`DTEND` directly *are* the on-call window. No airport given — falls back to `pilot.base` (same fallback the VCS parser's bare `RE` blocks use).

iCloud publishes these as `webcal://` — `syncPilotICS()` normalizes to `https://` before fetching. Dispatches via `AIRLINE_OPTIONS`'s `icao: 'DAL'` entry. History: `CLAUDE_HISTORY.md § Delta "MiCrew" ICS parser`.

### American Airlines "MobileCCI" ICS parser (`parseAmericanICS`, server.js) — `parser_type: 'ics_american'`

One `VEVENT` per flight leg (simpler than Delta/RosterBuster/eCrew):
```
UID:FLT-1791211500@mobilecci
DESCRIPTION:SEQ#: 10195\nFlight#: 478\nStations: PHL→PHX\nLocal Time: ...\nUTC Time: ...
```
`DTSTART`/`DTEND` have no `Z`/`TZID` but are already local (dep-airport-local / arr-airport-local — confirmed against `DESCRIPTION`'s "Local Time" field). A `Layover-*` VEVENT type is purely informational and skipped (CrewSync computes layovers itself). Real legs identified by `UID` starting `FLT-`. `SEQ#`→`trip`, `Flight#`→flight number (prefixed `AA`, since the feed has no carrier letter), `Stations: DEP→ARR` (unicode `→`, matched loosely). `blockMinutes` computed via `_aptTimezone`/`localTZToUTC`, never `null`.

**Not seen in the one feed this was built against, so not handled — get a real example before guessing**: deadhead legs, reserve/vacation/training/sick markers, equipment/tail number. Dispatches via `icao: 'AAL'`. History: `CLAUDE_HISTORY.md § American Airlines "MobileCCI" parser`.

### Southwest Airlines "CrewHub BYO" ICS parser (`parseSouthwestICS`, server.js) — `parser_type: 'ics_southwest'`

Like Delta's MiCrew parser (whole multi-day trip per `VEVENT`), but `LOCATION` gives the trip number directly (`Trip: DA9X`), and **every leg's time carries its own timezone abbreviation** (`CDT`/`EDT`/`MDT`/...):
```
3617 DAL 07:20 CDT   DCA 11:10 EDT
1513 DCA 11:50 EDT   MSY 13:40 CDT
```
Because a single leg can cross zones, the parser converts each endpoint to real UTC via a fixed abbreviation→offset table (no IANA lookup needed — the abbreviation already encodes DST) and compares *in UTC* to decide date rollover; stored times remain the given local `HH:MM` values. `DTSTART;VALUE=DATE`/`DTEND;VALUE=DATE` anchor the trip's start/end date directly.

**Two skip cases**: `RPRT ...` (same-airport report marker, filtered by its leading token not being purely numeric — real flight numbers are bare digits) and a blank-time equipment-swap artifact row (skipped automatically since the leg regex requires real `HH:MM` digits; a second, real row for the same flight number follows and parses fine). **Deadhead detection NOT built** — a trailing `D`/`P`/`M`/`A` letter on the duty-day summary line is attached to the whole day, not one leg, so it's ambiguous; don't guess. `GDO` ("Guaranteed Day Off") is its own single-day VEVENT with no legs, skipped entirely. `blockMinutes = Math.round((arrUTC-depUTC)/60000)` using the already-computed UTC instants. Dispatches via `icao: 'SWA'`. History: `CLAUDE_HISTORY.md § Southwest Airlines "CrewHub BYO" parser`.

### Parser warnings (American + Southwest only, so far)

`parseAmericanICS`/`parseSouthwestICS` return `{ events, warnings }` instead of a bare array — `warnings` is a list of plain-English strings for anything skipped because it didn't match a known shape. Every other parser still returns a bare array; this is deliberately scoped to just these two, not a system-wide refactor (extending it to Delta/RosterBuster/eCrew would be reasonable, not done).

`pilots.parser_warnings` (TEXT, JSON array) stores the most recent parse's warnings — **overwritten every parse, never accumulated** — from both the upload handler and `syncPilotICS()`. Upload/sync responses include `warnings` directly. **Admin-only**: `renderAdminUserList()` shows an amber "⚠ N unrecognized items" badge (`showParserWarnings()` → `alert()`); upload/sync success toasts also surface a count, gated behind `myPilot === null && !myViewer` (true admin, not a viewer, since a viewer also has `myPilot===null`).

**Known, already-understood warning** (not a bug to re-investigate): Southwest's sample feed flags `Trip "DP36": line looked like a flight leg but didn't match...` for the documented blank-time equipment-swap artifact — expected noise. History: `CLAUDE_HISTORY.md § Parser warnings system`.

### `pilotsCache` invalidation

`pilotsCache[key]` is set once per page load (or after upload/sync). Bulk loads go through `_loadPilotOnce(key)`, one request per pilot at a time, since the grid, Crossings, Off Days and maps all load everyone at startup. The Crossings "Refresh" button calls `computeOverlap()` but does **not** clear the cache — it re-runs `buildGroundPeriods` on cached data. A stale cache can make crossings appear wrong even after a schedule fix. To force-refresh: reload the page.

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

**Simulate buildGroundPeriods in Node** (times treated as UTC in Node — offsets cancel in comparisons but absolute values differ from browser): copy the function from app.html, feed it prod segments, look for periods >48h.

**Crossings 1153h-style bugs — common causes:**
1. Old `recentArr` used as groundStart for a new trip — fixed by the `useRecentArr` other-airport check.
2. `nextFromArr` finding next trip from layover airport weeks later when pilot went home without logging commute — fixed by `wentHome` detection.
3. Missing personal/commute in `allDeps` (verify the filter includes all types).

**Map debugging — always identify which render function:** `renderMap()` (single pilot month), `renderDayMap()` (all pilots one day), `renderAllPilotsMap()` (all pilots month).

UTC/local date skew is common: segments stored in local time, `new Date()` in browser uses local time, but comparisons to `new Date()` (now) need care around midnight.

## Upload flow

`handleUpload(input)` (~line 6523): reads the selected file + upload-for pilot (`#upload-pilot-select`), calls `uploadPilotSchedule(pilotKey, file)` → `POST /api/pilots/:key/upload` (multipart). On success: toast with segment count, reload if currently viewed, `computeOverlap()` to refresh crossings, then `updateCrossingAlert()`/`broadcastCrossingNotifications()`.

**Mobile upload**: `#mobile-upload-sheet` with its own pilot-select/file-input, handled by `handleMobileUpload()` (mirrors `handleUpload`).

**Upload reminder**: `showUploadReminder()` (~line 7454) fires after `loadPilot()` if the pilot has no flights for the current month and hasn't seen the reminder for that month/pilot.

## Add flight modal (`submitAddFlight()`, ~line 7024)

4 flight types: **Work** (`trip` = pairing #), **DH** (`is_dh=true`), **Commute** (`trip='COMMUTE'`, `is_manual=1`), **Personal** (`trip='PERSONAL'`, `is_manual=1`). Fields: pilot selector (admin only), date, DEP/ARR airports (auto-uppercased), dep/arr times, block time (auto-calculated via `autoComputeBlockTime()` unless manually edited), flight #, tail #. POSTs to `/api/pilots/:key/add-segment`; edit mode PUTs to `/segments/:id`. The form is always local airport time. When editing a UTC-stored row (NetJets auto legs, Schedaero), `openEditFlight()` converts the `Z` time to airport-local before pre-filling. Slicing the raw string used to shift the leg by the UTC offset on any save. On save, a row that was stored in UTC is converted back to UTC, so a pilot's rows never end up mixed: Crossings reads a UTC pilot's rows as UTC. Separate `#edit-ground-modal` for ground legs.

## Schedaero sync (Kyle)

**Full sync** (`openSchedaeroSync()` → `syncSchedaero()` → `POST /api/pilots/kyle/sync-schedaero`): requires GetMonth URL, API token (x-avinode-apitoken header), full session cookie. Syncs a configurable month range (back 0–6, ahead 1–6 months). Credentials saved server-side in `settings` after success.

**Quick sync** (`quickSyncSchedaero()` → `POST /api/pilots/kyle/quick-sync-schedaero`): uses saved credentials. Expired session (302/auth error) → opens `#schedaero-modal` in cookie-only mode. Auto-sync runs quick sync at 06:00/14:00/22:00 UTC daily (chained `setTimeout`, not cron); a keepalive ping every 20 minutes keeps the session alive between syncs.

**Kyle's corporate flight number**: real value is `SJJ` + the **first three digits** of the tail (`sjjFlightNumber(tail)`, server.js) — not every digit. Computed by the parser, actually written by `importSchedaeroEvents()`'s INSERT (both manual/quick sync and the 06/14/22 UTC auto-sync share this one import function), and matched by both tail-based callsign fallbacks (`deriveCallsign()` client-side, `deriveServerCallsign()` server-side). Full three-compounding-bugs discovery story: `CLAUDE_HISTORY.md § Schedaero sync`.

**Background poller tracks Kyle's corporate flights** via `deriveServerCallsign(row, airlineCode)` — the poller's query matches tail-only rows too, filtered down to `airlineCode === 'SJJ'` in JS. This was the first instance of the same-day-callsign-reuse problem — see "Same-day round trip sharing one callsign" above.
