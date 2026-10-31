# CrewSync — Developer Context for Claude

> **Looking for how/why something got built this way, or a past bug's full story?** See `CLAUDE_HISTORY.md` — the dated, narrative "confirmed live / found and fixed / reverted because" development log, organized under the same section headings as this file. This file (CLAUDE.md) only describes **current behavior** — what exists and how it works right now — so it stays cheap to load every turn. When in doubt about which file to check, start here; every section below that has a meaty history points at the matching `CLAUDE_HISTORY.md §` heading.

## What this app is

CrewSync is a private PWA for a group of pilots (Kyle, Adam, Sam, Logan, Drew, plus later joiners) to coordinate schedules. Key views: Calendar, List, Route Map, Crew Planning (Crossings + Off Days). Backend: Node/Express + SQLite. Frontend: single-file `public/app.html` (~11k lines, all views and logic inline).

Kyle also runs a Tampermonkey userscript (`public/frat-autofill.user.js`) that autofills PRISM SMS flight risk assessments from his CrewSync schedule — see its own section below.

Prod server: `http://167.71.107.245:3000/` (managed via `pm2`, process name `dispatch`). **Deploy is git-based, not scp**: commit locally, `git push origin server`, then on the droplet `cd /var/www/Webapp && git pull origin server`, then `pm2 restart dispatch` after any `server.js`/`db.js` change (`public/app.html` changes don't need a restart, just a browser refresh). The droplet's `/var/www/Webapp` is itself a git clone of this same repo — `scp`-ing files directly onto it bypasses git and causes real drift between the droplet's git history and its running files. Always commit+push *before* deploying, never after — prod should never run code that isn't also on `origin/server`.

Current version: `1.0.10-beta` (`package.json`/`package-lock.json`). Bump it for the next meaningfully-sized batch of fixes, not every commit — see `CLAUDE_HISTORY.md` for the version-bump log if you need to know what shipped when.

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
| `swim.js` / `stdds.js` / `tfms.js` / `tfdm.js` | FAA SWIM feed consumers (SFDPS en-route, STDDS surface/terminal, TFMS flow/route/airport-config, TFDM per-flight runway/phase/delay) — see "FAA SWIM integration" below |
| `vnas.js` | VATSIM vNAS facility/frequency lookup (real ATC sector → frequency, for the live map's FREQ toggle) — unrelated data source from the FAA SWIM feeds above, see "Real ATC frequency" under "FAA SWIM integration" |
| `navdata.js` / `scripts/build-navdata.js` | FAA NASR data resolution (fixes/navaids/SID/STAR/airways) for the live-map route display, and the script that builds `data/nasr/*.json` from raw NASR CSVs |

---

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

---

## File map continued — large module notes

- `swim.js`/`stdds.js`/`tfms.js`/`tfdm.js`/`vnas.js`/`navdata.js` are all read fresh when debugging live-tracking issues; none of their internals are duplicated here — check the module directly.
- `server.js` and `public/app.html` are large; use Grep for function names rather than reading sequentially.

---

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

---

## Identity system

```js
myPilot   // pilot_key of the logged-in pilot, or null
myViewer  // key of view-only user, or null
// Admin: myPilot === null && myViewer === null
```

`getCrewVisible()` → array of visible pilot keys: `visiblePilotKeys()` (self + friends, or everyone for admin/viewer) minus whatever's in `_hiddenCrew`. Default is **visible** — see "Friends system" below.
`_buildCrewVisibilityUI()` → builds "Your Crew" toggles; runs for admin/viewer/demo only now (real pilots get the same toggle inline in the Friends panel — see below).

---

## Friends system

A real pilot can only see another real pilot's schedule once an **accepted, mutual** friendship exists between them (`friend_requests` table). **Admin alone is exempt** — sees every pilot unconditionally. Viewers are friend-gated too, same as real pilots, just admin-assigned instead of self-service (no self-service Friends UI for a viewer). This is a flat social graph, not org/tenant isolation — any pilot can send anyone a friend request; a pair counts as friends once an accepted row exists in either direction.

**Data model:** `friend_requests(requester_key, recipient_key, status)` — `UNIQUE` on the ordered pair, `status` is `'pending'` or `'accepted'` (no `'declined'` — a decline deletes the row). `pilots.friends_seeded` (one-time migration flag), `pilots.hidden_crew` (per-pilot explicit-hide list).

**Server-side (`server.js`):**
- `_resolvePilotToken(token, db, cb)` → `(pilot_key, role)`.
- `_canViewPilot(db, viewerKey, viewerRole, targetKey, cb)` — `true` if `viewerKey === 'admin'`, self, or an accepted friendship exists in either direction.
- `GET /api/pilots/:pilotKey` requires `?token=`; denied → `403 { error: 'not_friends', pilotKey, name }`.
- `GET /api/pilots` (admin user list) is admin-gated; returns `token` column, so admin-only matters.
- `GET /api/pilots-directory` — non-admin-gated, token-required listing (`pilot_key, name, base, home_airport, role, color`, no token) — used by the friends search UI and `_syncPilotRoster()`.
- Friend endpoints: `GET /api/friends`, `POST /api/friends/request` (auto-accepts on mutual-simultaneous-request), `POST /api/friends/respond`, `DELETE /api/friends/:key`, `POST /api/friends/seed` (one-time migration).
- `_unhideFromEachOther(db, keyA, keyB)` — called whenever a friendship newly becomes accepted, so a past unfriend's hide-flag doesn't persist across a later re-friend.
- `_getFriendsData` tags each entry with `isViewer` so the UI can label/filter viewer friends separately.
- Admin override endpoints: `GET /api/admin/friends/:pilotKey`, `POST /api/admin/friends`, `DELETE /api/admin/friends` (all admin-token-gated) — directly assign/remove friendships without request/accept.
- `GET /api/crew-visibility` / `PUT /api/crew-visibility` — token-gated, operate on the caller's own `hidden_crew`.

**Frontend (`app.html`):**
- `visiblePilotKeys()` — single source of truth for "which pilots can I actually fetch data for": `[...PILOT_KEYS]` for admin/viewer, or `[myPilot, ...myFriends]` (viewer friends filtered out) for a real pilot. Every bulk-fetch loop (`computeOverlap()`, `computeOffDays()`, grid-view prefetch) uses this, never raw `PILOT_KEYS`.
- `_pilotFetchUrl(key)` — appends `?token=` when `myToken` is set.
- `fetchPilotData()` → on `403 not_friends`, returns `{ __notFriends: true, pilotKey, name }`; `loadPilot()` renders `_renderNotFriendsState()` instead of an empty schedule.
- Friends UI lives in the Profile sheet (`#friends-section`, real-pilot-only): `renderFriendsPanel()` (friends list with inline visibility toggle + Remove, incoming/outgoing requests, viewer friends collapsed under "View Only · N"), `#add-friend-modal` + `renderFriendSearchResults()`.
- `_buildCrewVisibilityUI()` renders into `#crew-visibility-section`, shown for admin/viewer/demo only (`!!myPilot` hides it for a real pilot, whose equivalent control is inline in the Friends panel).
- `_hiddenCrew` (Set) loaded via `loadCrewVisibility()` inside `initIdentity()`; `getCrewVisible()` = `visiblePilotKeys().filter(p => p === myPilot || !_hiddenCrew.has(p))`.
- Friend request / accept / admin-connect all trigger notifications via `_notifyPilot()` + `pushToAll()` (badge: `#friend-badge-mobile`/`#friend-badge-desktop`). Not live-pushed to an already-open tab — only on page load or after your own action.

Full build history, every bug found/fixed along the way, and the security holes this uncovered: `CLAUDE_HISTORY.md § Friends system`.

---

## Key functions (grep these names)

| Function | Line ~| Role |
|---|---|---|
| `initIdentity()` | 2122 | Auth check on load; sets myPilot/myViewer; calls `_syncPilotRoster()` before any pilot-dependent UI builds |
| `_applyIdentityUI()` | 2267 | Shows/hides UI sections based on who's logged in |
| `_buildCrewVisibilityUI()` | ~2570 | Crew toggle switches — admin/viewer/demo only now |
| `renderFriendsPanel()` | ~2300 | Friends list + incoming/outgoing requests; for a real pilot also renders the crew-visibility toggle + Remove inline per row |
| `render()` | ~6485 | Main calendar/list render dispatcher |
| `renderMap()` | 4857 | Single pilot monthly route map |
| `renderAllPilotsMap()` | 4715 | All-crew monthly map |
| `renderDayMap()` | ~5828 | All-crew single-day map |
| `distanceProportionalArc()` | 4826 | Bezier-bowed great-circle arc for a single route (no de-overlap; `renderMap()` has no cross-route overlap handling at all) |
| `offsetArc()` | 5238 | Bezier arc with perpendicular offset — spreads multiple flights sharing an identical city pair (`renderDayMap()` only) |
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
| `startLiveTracking()` | 4946 | ADS-B/SWIM poll loop for one callsign; adaptive cadence |
| `startCalListLivePolling()` | 4848 | Polls `/api/live-position` for `[data-live-callsign]` elements in cal/list every 15s |
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
| `_legState()` | ~7024 | Day map's unified per-flight status resolver (see "Durable flight-tracking evidence" below) |
| `_hasNewerLegStarted()` | — | Shared helper: has this pilot's same callsign already started a later-scheduled leg today |
| `isFlightStillActive()` | — | Shared grid/list/day-detail/map "is this flight still active" check (90min grace past scheduled arrival, see "TFDM delay insight" below) |

---

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

**Perf note — don't remove the paint-yield.** Both `computeOverlap()`/`computeOffDays()` do `await new Promise(r => setTimeout(r, 0))` right after setting the spinner HTML, forcing a real paint before the heavy pipeline runs. Removing this makes the Overlap view feel like it hangs (history: `CLAUDE_HISTORY.md § Crossings pipeline`).

---

## Built-in logic reference

This section documents non-obvious behaviors already implemented. Check here before assuming something doesn't exist.

### Time handling — two systems coexist

**Kyle** uses UTC times (Schedaero source, strings end in `Z`). All other pilots use local airport time (no timezone suffix). `pilotUsesUtc(k)` detects which system a pilot uses by inspecting the first flight's departure_time string. `flightUTCTime(isoStr, airportCode)` converts any time string to a real UTC Date (use for cross-pilot comparisons — never compare raw `new Date(localString)` across pilots). `flightLocalDate(isoStr, airportCode)` extracts the local calendar date (YYYY-MM-DD) at the airport. `adjustedPeriod(k, p)` shifts a ground period's start/end by the browser-TZ/airport-TZ difference so UTC comparisons between pilots stay consistent.

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

`pilotsCache[key]` is set once per page load (or after upload/sync). The Crossings "Refresh" button calls `computeOverlap()` but does **not** clear the cache — it re-runs `buildGroundPeriods` on cached data. A stale cache can make crossings appear wrong even after a schedule fix. To force-refresh: reload the page.

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

Two swipe handlers registered in `setupGestures()` (~line 1640):

**Calendar / List month swipe** — main content element. Horizontal swipe (|dx| > 60, more horizontal than vertical by 1.8×) → changes month. Calendar/list views only.

**Overlap tab swipe** — `#view-overlap`. Same thresholds. Swipe left → Off Days; swipe right → Crossings. **Critical:** ignores touches originating inside `#offday-filter-bar`:

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

`app.html` ~line 360. Full-screen overlay while the app initializes; fades out once identity is resolved. Logo: `<img class="splash-plane" src="/icon.svg">` (72×72, rounded, floating animation — not an emoji, don't revert). Title "CrewSync", subtitle "Crew Scheduling", three pulsing blue dots. Dismissed via `splash-hide` (fade) then `splash-gone` (display:none). Repurposed for identity-resolution failure: `_showIdentityError()` shows red subtitle text + a Retry button instead of proceeding with an unresolved identity.

---

## Branding assets

| File | Usage |
|---|---|
| `public/icon.svg` | App icon — dark navy bg, white plane pointing NE. Splash screen, crew roster header, favicon |
| `public/icon-192.png` | PWA manifest icon (192×192) |
| `public/icon-512.png` | PWA manifest icon (512×512) |
| `public/apple-touch-icon.png` | iOS home screen icon |

Use `<img src="/icon.svg">` with `border-radius` to match the rounded-square style for any new logo placement. Don't use emoji or generic plane glyphs.

---

## Crew roster page (`/crew-roster`)

Server-side HTML in `server.js` (~line 2068). Protected by `rosterAuth` middleware (password from env), admin only. Per-pilot card: initials avatar (viewers get 👁, blue bg), name/pilot_key/base/home_airport, last-active timestamp + colored dot.

**Last-active color scale:**

| Recency | Color | Label example |
|---|---|---|
| < 1 hour | `#22c55e` green | `3m ago` |
| 1–24 hours | `#84cc16` lime | `5h ago` |
| 1–3 days | `#eab308` yellow | `2d ago · Jun 26` |
| 3–7 days | `#f97316` orange | `5d ago · Jun 23` |
| > 1 week | `#ef4444` red | `Jun 15` |
| Never | `#52525b` gray | `Never` |

`last_active` updates whenever a pilot loads the app. `fmtActive()`/`activeColor()` live inside the route handler.

There's also a NetJets-specific lookup sub-page, `/crew-roster/netjets-lookup` — see "NetJets manual tracking" below.

---

## API endpoints (server.js)

```
GET  /api/pilots                          all pilots — admin-gated (token required, pilot_key==='admin')
GET  /api/pilots/:key                     pilot + all segments — token required, friend-gated
GET  /api/pilots-directory                non-admin-gated directory listing (no token column)
POST /api/pilots/:key/upload              upload schedule file — token required, admin-or-self
DELETE /api/pilots/:key/segments          clear all non-manual segments — token required, admin-or-self
POST /api/pilots/:key/add-segment         add manual segment — token required, admin-or-self
PUT  /api/pilots/:key/segments/:id        edit segment — token required, admin-or-self
DELETE /api/pilots/:key/segments/:id      delete segment — token required, admin-or-self
PUT  /api/pilots/:key                     update pilot profile — token required; admin or self only, self can't touch role
DELETE /api/pilots/:key                   delete pilot + segments — token required, admin only
POST /api/pilots/:key/regenerate-token    reissue login token — token required, admin only
POST /api/pilots/:key/sync-ics            trigger ICS sync — token required, admin-or-self
GET  /api/pilots/:key/ics-url             get stored ICS URL — token required, admin-or-self
POST /api/pilots/kyle/sync-schedaero      full Schedaero sync (Kyle only)
POST /api/pilots/kyle/quick-sync-schedaero  quick sync (Kyle only)
POST /api/early-landing                   report early landing
GET  /api/live-position                   live position for one callsign (SWIM/STDDS/ADS-B, accepts ?origin=)
GET  /api/flight-status                   batched live/airborne/parked/times for several callsigns (accepts ?origins=)
GET  /api/friends                         my friends + pending incoming/outgoing
POST /api/friends/request                 send friend request (auto-accepts on mutual-simultaneous)
POST /api/friends/respond                 accept/decline incoming request
DELETE /api/friends/:key                  unfriend
POST /api/friends/seed                    one-time crew→friends migration
GET  /api/crew-visibility / PUT ...       read/write caller's hidden_crew
GET  /api/admin/friends/:pilotKey         admin: any pilot's friends/incoming/outgoing
POST /api/admin/friends / DELETE ...      admin: directly assign/remove a friendship
GET  /api/intel / POST / PUT /:id / DELETE /:id / POST /:id/vote
GET  /api/notifications / PATCH /read
GET  /api/push/vapid-key / POST /api/push/subscribe
PUT  /api/pilots/:key/rotation            NetJets duty rotation (admin-or-self)
PUT  /api/pilots/:key/tour-tail           NetJets per-tour tail + start airport (admin-or-self)
GET  /api/health                          health check
GET  /admin/users                         admin user management page
GET  /api/pilots/:key/here-now            debug: HERE-NOW priority-chain reimplementation
GET  /api/debug/tfdm/:callsign            debug: raw TFDM state for a callsign
GET  /api/debug/tfms-aptc/:code           debug: raw TFMS APTC state for an airport
GET  /api/debug/origin-state/:callsign    debug: airborne/parked evidence + flight_log rows
GET  /api/debug/seed-route                debug: inject a test route onto a tracked flight
```

---

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

**Simulate buildGroundPeriods in Node** (times treated as UTC in Node — offsets cancel in comparisons but absolute values differ from browser): copy the function from app.html, feed it prod segments, look for periods >48h.

**Crossings 1153h-style bugs — common causes:**
1. Old `recentArr` used as groundStart for a new trip — fixed by the `useRecentArr` other-airport check.
2. `nextFromArr` finding next trip from layover airport weeks later when pilot went home without logging commute — fixed by `wentHome` detection.
3. Missing personal/commute in `allDeps` (verify the filter includes all types).

**Map debugging — always identify which render function:** `renderMap()` (single pilot month), `renderDayMap()` (all pilots one day), `renderAllPilotsMap()` (all pilots month).

UTC/local date skew is common: segments stored in local time, `new Date()` in browser uses local time, but comparisons to `new Date()` (now) need care around midnight.

---

## Calendar grid rendering (`render()` → grid branch)

`render()` (~line 5937) rebuilds whichever view is active. It does **not** fetch — call `loadPilot()` first.

**Grid mode logic per calendar cell:**
1. Walks every day in the month; filters `segments[]` by **local** departure/arrival date (`flightLocalDate()`, not raw JS date). Classifies: Hard Off > Vacation > Flying > Reserve > Away (inferAwayLayovers) > personal-away > Off.
2. Border/background: `border-red-600 bg-red-700/80` Hard Off; `border-blue-500/30 bg-blue-500/10` Flying; `border-amber-400/30` Reserve; `border-yellow-500/40 bg-yellow-900/20` Away layover.
3. Flight items sorted chronologically; data attributes `data-dep-time`, `data-arr-time`, `data-tail`, `data-trip`, `data-flight`, `data-live-callsign`.
4. Active flights (`isFlightStillActive()`, see "TFDM delay insight" below): `active-leg` class + `data-live-callsign` for `startCalListLivePolling()`.
5. After render: `attachTooltips()` wires hover tooltips; `startCalListLivePolling()` starts polling.

**Mobile grid:** compact cells (52–96px), text-only flight pills, status pills hidden.

**Perf rule — never accumulate `innerHTML +=` in the day loop.** Build a local string, assign to `innerHTML` once after the loop (history: `CLAUDE_HISTORY.md § Calendar grid rendering`).

**Auto-scroll to a live leg.** Grid branch scrolls any `.flight-item.active-leg` into view (`block: 'nearest'`) after rendering, deferred to `requestAnimationFrame` (must be deferred — see history).

**Overnight/red-eye indicator (grid only).** A flight whose local dep/arr dates differ gets a 🌙 marker on both day cells, with `data-redeye="dep"`/`"arr"` feeding a custom tooltip explanation. **Never use a native `title=` on `.flight-item`** — it visibly collides with the custom tooltip. Extended to reserve shifts that cross midnight (same marker, worded for an on-call shift). Scoped to the monthly grid only.

---

## List view rendering (`render()` → list branch)

Iterates every day in the month. Day header block with status badge. Flight rows (`.flight-row`) sorted by departure time: route pair, local dep/arr times with tz abbreviation, block time, tail/flight#, layover duration between consecutive legs. Ground legs (type='ground') appear as subdued `VAN ORD→MDW` rows. Reserve slots appear as amber "ON CALL" rows. Past days get `.list-past` (grayscale + dimmed); today highlighted. `layoverLabel(gapMins, atHome, sameDay)` shows overnight duration if >30 min and not at home; suppresses label if >30h at home.

---

## Day detail sheet (`showDayDetail(dateKey)`)

Opens `#day-detail-sheet` (bottom sheet mobile, centered modal desktop). Built from the same `segments[]` slice as the grid: header status (HARD OFF / IN THE AIR / FLYING / ON CALL / DAY OFF) + date; flight cards (route, times, block, tail#, trip#, DH badge, layover to next leg); reserve cards; ground leg cards; manual flights get Edit/Delete (only if `canEdit()`); live flights show `▶ LIVE` + `deriveCallsign()`.

`canEdit()` → true if `myPilot === currentPilot` or admin.

---

## Pull-to-refresh (`setupMobileGestures()`)

Registered on `#view-grid`/`#view-list`. `touchstart`: `ptrActive = el.scrollTop === 0`. `touchmove`: scales/rotates `#ptr-indicator`; at 70px pull → `ptrTriggered`. `touchend`: triggered → `loadPilot(currentPilot)` + toast; else horizontal swipe → `changeMonth()`. `#ptr-indicator` is a fixed 36px circle tracking pull distance.

---

## ADS-B live tracking

Two parallel systems:

### `startLiveTracking()` (map view only, line 5642)

Polls `/api/live-position?callsign=XX&origin=DEP` — **adaptive cadence**: `_pollDelayMs` is 3000ms ("fast") when `d.onGround` or `d.altFt < 3000` (taxiing, final approach, or initial climb), else 8000ms ("cruise"). Self-scheduling loop (`setTimeout` → `await update()` → `scheduleNextPoll()`), not a fixed `setInterval`, so a phase change takes effect on the next poll. `finishTracking()` sets a `_pollerStopped` flag checked at the top of `scheduleNextPoll()` to actually stop a self-rescheduling loop.

- Called from `renderMap()`/`renderDayMap()` for any active-window flight.
- Draws a real-time GPS trail (solid polyline) + remaining-arc (dashed geodesic to destination).
- Plane icon hidden until ADS-B/SWIM confirms airborne (`hasBeenAirborne` — strictly poller-local, set only by a real `found:true` fix from *this* poller; a separate `serverConfirmedAirborne` absorbs the server's historical hint for miss-handling heuristics only, never near the first-confirmation cleanup path).
- `deoverlapLiveLabels()` runs every 300ms to prevent label collisions; also handles waypoint-tag collisions when Route Detail is on, and biases the plane's own label away from whichever screen axis is perpendicular to its heading, away from the route line.
- Parked (`{parked:true}`) → `finishTracking()`; sustained misses (threshold scales with proximity to scheduled arrival: ~5min required while >15min from scheduled arrival, ~40s once close) → `finishTracking()`.
- `_liveLayersByCallsign` (object, keyed by callsign) is the real source of truth for "is something tracking this callsign" — not `_livePollers`, which is cleared on every render.
- World-copy support: markers placed at `lon`, `lon±360`.
- `finishTracking(savedEarly)` ends tracking for *that one flight only* — scoped cleanup, never calls the global `renderMap()`.
- Per-call **instance id** (`_liveTrackingInstanceSeq`) — `update()`/`finishTracking()`/`scheduleNextPoll()` all check `_isCurrent()` before touching shared state, so a same-callsign leg superseded mid-flight (see "Same-day round trip sharing one callsign" below) can't arm a stray timer or mark the wrong thing parked.

**Reliability safeguards currently in place** (full discovery history: `CLAUDE_HISTORY.md § ADS-B live tracking`): dashed arc removal requires `missCount >= 3` (not the first miss); stale-trail protection via `_hexToCallsign` (changed callsign on the same hex forces a trail reset); `isPositionOnRoute()` uses a 300mi floor on top of its 25% slack (so a real weather deviation doesn't freeze the live icon).

### `startCalListLivePolling()` (~line 4848)

Polls every **15 seconds** for `[data-live-callsign]` elements in calendar/list. Per callsign: polls `/api/live-position`, updates `#live-{callsign}` with altitude/speed (`✈ FL340 · 428 kts` or `Taxiing · 15 kts`), appends `· Delayed Nm` when `departureDelayMin >= 10` and not yet en route. `d.parked` populates `_confirmedParked`. Falls back to the `airborne` array + a known past arrival time when the airline's own OOOI field isn't populated (true for non-airline operators like NetJets). Stopped by `stopCalListPollers()` before each re-render.

### Server-side ADS-B proxy (`/api/live-position`)

Proxies to `api.adsb.lol` and `airplanes.live`. Caches trail points per callsign. Returns `{ found, lat, lon, altFt, speedKts, onGround, heading, trail[], parked, hadTrail, tfdmState, departureDelayMin }`. `deriveCallsign()` maps tail/flight-number combos to the correct ADS-B callsign.

### FlightAware links

Every visible flight number/callsign is wrapped by `flightAwareLink(ident, displayHtml, eligible)` → `flightaware.com/live/flight/{ident}`. Gated by `flightAwareEligible(depMs)` (48h window — a dateless FlightAware URL resolves to whichever instance is nearest *now*, which matters for reused flight numbers and for corporate flight plans that aren't filed until close to departure). Recomputed fresh on every render.

### Route overlap on `renderMap()` — known, unfixed

`renderMap()` groups flights into one arc per unique `dep|arr` pair with **no overlap handling between different pairs** (unlike `renderDayMap()`, which uses `offsetArc()`). Two unrelated legs can cross or run close and look like one line. A fix was tried and reverted — see `CLAUDE_HISTORY.md § Route overlap on renderMap()` before attempting this again; don't reuse transitive BFS clustering.

---

## FAA SWIM integration — real filed-route display on the live map

Three backend modules consume FAA SWIM data via Solace PubSub+ (`solclientjs`), separate from ADS-B polling.

| File | Feed | Gives you |
|---|---|---|
| `swim.js` | SFDPS (en-route) | Live position/altitude/speed/heading **and** filed route string (current + original/as-filed), SID/STAR, parsed waypoints |
| `stdds.js` | STDDS (surface/terminal) | Airport-vicinity position (TAIS + ASDE-X), preferred over SFDPS near the ground; cross-references SFDPS by GUFI |
| `tfms.js` | TFMS (flow/route) | A dense, already-computed lat/lon trajectory when available; also real OOOI times (`etd`/`eta`/`airlineOnTime`/`airlineInTime`), airport-configuration (APTC) runway flow, and real per-flight route origin (`routeOrigin()`) |
| `tfdm.js` | TFDM (per-flight) | Runway assignment, flight phase (`tfdmState`: `FILED`→...→`ARRIVAL`→...→`LUAW`), departure delay, diversion indicator |

All expose `setRelevantCallsigns(swimRelevant)`, fed by `runActiveFlightPoller`, pruning stale callsigns on every call. **Two separate relevance windows**: `ADSB_LOOKAHEAD_MS` (30min, drives real rate-limited ADS-B calls) vs `SWIM_LOOKAHEAD_MS` (4h, drives the free SWIM-family calls) — `POLLER_LOOKBACK_MS` (8h) applies to both. `tfms.setRelevantOrigins()` feeds a parallel `callsign → Set<departure_airport>` map so a same-day callsign reuse by an unrelated flight (see "Same-day round trip" below) gets rejected at ingestion, not just on read.

### Route resolution pipeline (`resolveRouteWaypoints()` in server.js)

Filed route string → `swim.js`'s `parseRouteString()` → typed tokens (airport/procedure/fix/airway/radial_fix/latlon) → expanded to coordinates:
1. **TFMS trajectory preferred when available** (`routeParsed.source = 'tfms'`).
2. **Otherwise `navdata.js`** (FAA NASR data, `routeParsed.source = 'navdata'`) — resolves fixes/navaids by name (disambiguated by proximity to the previous point), SID/STAR procedures (runway-specific body segments, see runway fallback below), radial/distance fixes (`projectRadialDistance()`), and airways (sub-sequence between two known points — not yet exercised against a real airway-heavy route).

**Runway-body selection** (`pickBody()` in navdata.js), most-to-least authoritative: TFDM's real per-flight runway assignment → TFMS's airport-configuration (APTC) `arrRunwayConf`/`depRunwayConf` for that airport (`splitRunwayConf()`, accepts multiple candidate runways from one config string) → the destination's own current `depRunwayConf` as a wind-direction proxy (when the destination has no arrival config at all) → `bodies[0]` (arbitrary CSV-order default, last resort).

**Symbol classification** (`resolveFixOrNavaid()`): `vor`/`ndb` from `NAV_TYPE`, `waypoint`/`fix` from `FIX_USE_CODE`, `airport`/`latlon` for endpoints (no marker), `null` for TFMS's dense unnamed trajectory samples (no marker).

### Frontend rendering (`startLiveTracking()` in app.html)

- `computeRouteProgress()` projects live position onto the resolved route to filter to only the remaining portion — not a nearest-point check (would drop an approaching-but-not-yet-passed fix).
- Waypoint symbols follow real FAA chart conventions (`makeWaypointIcon()`): hollow hexagon = `vor`, triangle = `fix`, open four-point star = `waypoint`; all non-compulsory outline style. `ndb` = dashed circle.
- Name tags are managed Leaflet tooltips (`registerWaypointLabel()`), explicitly `openTooltip()`'d after `bindTooltip()` — `permanent:true` with `interactive:false` doesn't reliably auto-open.
- Label collisions handled by `deoverlapLiveLabels()`: plane label places first, route-point tags check against everything already placed and hide outright (not forced into an overlapping stack) if boxed in; symbol stays visible regardless.
- No gap trimmed around symbols — Leaflet's pane order already draws the line under markers for free.
- Zoom-dependent label disclosure: symbols always visible when the ✦ RTE toggle is on, at every zoom; labels gated by `ZOOM_SHOW_ACTIVE_ONLY`/`ZOOM_SHOW_ALL_FIXES` (4/7) — below 4 no labels, 4-7 only the active/next fix, ≥7 every fix.
- **Remaining-route line** (`remainDashedLines`/`remainSolidLines`) is built from exactly three contiguous runs (lead dashed / solid middle / trail dashed), each run keeping **both** endpoints of every leg's arc (no dropped duplicate point) so every run boundary lands exactly on its fix.
- **VCI indicator** (`VCI_ICON_SVG`, inline `<svg>`, never `<img src="data:...">`) shown when a poll's position came from real SWIM data (`source === 'swim'||'stdds'`).
- `#btn-route-detail` ("✦ RTE") sits in its own row next to the Radar button.

### Preflight route display

Shows the planned/filed route up to `PREFLIGHT_ROUTE_MS` (30 minutes) before scheduled departure, only when real FP data exists. `getSwimPosition()` returns `{ found: false, hasRoute: true, routeParsed, route, originalRoute, origin, dest, sid, star, source: 'swim' }` when no live position exists yet but a route has arrived. `startLiveTracking()`'s `update()` branches on `!d.found && d.hasRoute && !hasBeenAirborne` *before* the miss-counting branch: draws one uniform dashed line through the full unfiltered `resolvedPath`, plane icon stays hidden. Each map render function (`renderMap()`, the all-crew month view, `renderDayMap()`) has an `else` branch alongside its active-leg check to find and start-track a departing-soon leg this way.

### Real ATC frequency (vNAS)

`vnas.js` fetches the full vNAS payload every 6h, builds a `facilityId → Map(sectorId → {frequency, callsign})` index, discards the raw payload. Two linkage shapes: **enroute** (ARTCC, numeric sectorId) via `eramConfiguration.sectorId`; **terminal** (TRACON/tower, lettered sectorId) via `starsConfiguration.tcps[]`/`tcpId`. `getFrequency()` returns `null` for anything unresolvable (not every small facility is in VATSIM's model). `swim.js` stores the raw handoff as `entry.sector = {unit, sectorId}`; `server.js`'s `withResolvedFrequency()` resolves it once per poll onto a new sector object. Frontend: `buildBaseTooltip()` shows the MHz next to the callsign, gated by `_showSectorOn` (persisted `cs_show_sector`, **default ON**), button `#btn-show-sector` ("📻 FREQ"). `_liveLabelRefreshers` (global `callsign → refresh()` registry) lets the toggle repaint every tracked label instantly from cached data instead of waiting for each flight's own next poll.

### Temporary test infrastructure (still in use)

`POST /api/debug/seed-route` + `swim._testSeedRoute()` — inject a route string onto an already-tracked flight for testing. Not yet removed; per-session testing still ongoing.

### Route/trail persistence across restarts

`.swim_state_cache.json` (disk-backed) persists SWIM's trail, route, sid/star, origin/dest, sector — restored on startup via `loadStateCache()`, gated by a 24h freshness cutoff. A saved `routeParsed` may already carry a resolved `resolvedPath`, so a restart doesn't even need a fresh resolve. `scheduleSave()` (5s-debounced) fires on both position updates and route updates. **TFMS/TFDM state is NOT persisted** — only SWIM's route/trail; both re-populate naturally within a few polls.

### TFMS airport-configuration (APTC)

A second, unrelated `fiOutput`/`msgType="APTC"` message family on the TFMS queue, giving an airport's general current runway flow independent of any one flight:
```xml
<fcm:airport>SMF</fcm:airport> <fcm:arrRunwayConf>35L/35R</fcm:arrRunwayConf>
<fcm:depRunwayConf>35L/35R</fcm:depRunwayConf> <fcm:arrRate>64</fcm:arrRate>
<fcm:depRate>70</fcm:depRate> <fcm:weather>VMC</fcm:weather> <fcm:stratAar>64</fcm:stratAar>
```
`tfms.js` parses this into a flat `_airportConfig` map keyed by bare 3-letter code, unconditionally stored (never gated by relevant-callsigns — only a few hundred towered airports exist). Detected via a cheap substring check on `msgType="APTC"` before the relevant-callsigns gate (APTC messages carry no callsign at all). `getAirportConfig(aptCode)` returns `null` past a 30min staleness window. **Known limit**: airport-wide, not per-flight — a genuinely opposite-direction runway split resolves cleanly, but a finer split within the same flow direction could still land on the wrong body. Temporary `GET /api/debug/tfms-aptc/:code` inspector still in place.

### Trail backfill from ADS-B

`setRelevantCallsigns()` proactively calls `_watched.add()` for every relevant callsign so SWIM trail recording starts ~30min before a scheduled flight departs, independent of any client opening the live map. `/api/live-position` additionally backfills a SWIM/STDDS trail's missing head from ADS-B **once per flight instance that actually succeeds** (`_swimTrailBackfilled` Set, marked only after `fetchAdsbPosition()` resolves, so a transient rate-limit failure retries on the next poll instead of giving up forever). SWIM stays authoritative for any time range it already covers; ADS-B only fills the gap before it. Cleared on confirmed-parked so the next day's physical flight gets backfilled fresh.

### NOTAMs via SWIM — abandoned

Not implemented. SWIM only pushes live deltas with no snapshot/backlog of already-active NOTAMs, which FRAT's actual need (every NOTAM currently in effect) can't be built from alone. If revisited: start from the FAA NOTAM Search API (`api.faa.gov`) as the baseline, SWIM only ever as a live-update layer on top. Full story: `CLAUDE_HISTORY.md § FAA SWIM integration`.

---

## Resource usage (1 vCPU/1GB droplet)

Indexes exist on `segments.pilot_id`, `segments.departure_time`, `pilots.token`, `notifications.pilot_key`, `friend_requests.requester_key`/`.recipient_key`, `segments.route` (NetJets historical-duration lookup) — all `CREATE INDEX IF NOT EXISTS`, purely additive. `runActiveFlightPoller()`'s 15s loop calls `fetchLivePosition()` (checks STDDS/SWIM first) rather than unconditionally hitting the real rate-limited ADS-B API.

**Known, deliberately unbounded**: `GET /api/pilots/:key` returns a pilot's entire segment history with no date bound — the frontend assumes the full list is in `pilotsCache` for historical month navigation. Bounding this needs a paired client-side range-fetch change; not done.

---

## TFDM delay insight + "don't mark completed while still flying"

**Explicit, standing product principle**: the uploaded schedule is, and stays, the source of truth for when a flight is supposed to depart/land — it is never overwritten with real/estimated times anywhere. Only the *display-layer classification* of whether a flight is still active may use live evidence.

Real TFDM fields: `departureDelay.{predictedDelay,currentDelay,actualDelay}` (ISO-8601 durations, `actualDelay` preferred when populated), `tfdmFlightState` (`FILED`, `SCHEDULED`, `AT_STAND`, `RAMP_TAXI_OUT`, `AMA_TAXI_OUT`, `DEPARTED`, `EN_ROUTE`, `ON_FINAL`, `ARRIVAL`, `AMA_TAXI_IN`, `RAMP_TAXI_IN`, `LUAW`). `getFlightInfo()` (tfdm.js) returns the whole per-callsign entry (phase + delay + runway). `withTfdmInfo()` (server.js) attaches it to every live-position response regardless of which source actually answered position.

`isFlightStillActive(depMs, arrMs, nowMs, csig)` (app.html) is the single shared check used by grid, list, day-detail sheet, `renderMap()`'s month view + route popup + here-now pin, `renderAllPilotsMap()`, and `renderDayMap()`'s popup + here-now pin. Extends the active window to **`LATE_ARRIVAL_GRACE_MS` (90 minutes)** past scheduled arrival *unless* a live poll has already confirmed parked (`_confirmedParked` Set — mirror of `_landedEarly`, which tracks landing *before* scheduled arrival). Delay is surfaced (`· Delayed Nm`) when `departureDelayMin >= 10`, only in the pre-cruise phase.

**Deliberately unchanged**: `startLiveTracking()`'s own "give up after sustained misses" threshold is a different, independent heuristic (only fires when the flight genuinely can't be found at all) and was left as-is.

---

## Durable flight-tracking evidence + the day map's `_legState()`

**Server-side evidence survives restarts.** `_everAirborneCallsigns`/`_parkedCallsigns` (with `_everAirborneOrigin`/`_parkedOrigin` per-leg origin tracking so a reused flight number's next leg doesn't inherit stale evidence), TTLs 12h/6h respectively. Persisted to SQLite via `logFlightEvent()` into `flight_log` (`callsign, day, origin, dest, airborne_at, parked_at, updated_at`, one row per callsign per UTC day, 7-day retention). `restoreFromFlightLog()` rehydrates both Sets 1.5s after server startup.

**Parked detection is time-based** (`PARK_STILL_MS = 3 min` continuous stationary on the ground, tracked via `_groundStillSince`), not count-based. `isClearlyAirborne()` requires `onGround===false` AND (`altFt>2000` OR `speedKts>100`) — altitude alone misfires at elevated airports (PIT ~1200ft, DEN ~5400ft).

**ADS-B cache reuse**: `ADSB_CACHE_TTL` (16s, just over the 15s poller cadence) lets a client's own `/api/live-position` poll reuse the poller's own recent ADS-B-sourced result instead of redoing the slow dual-source race.

**Taxi trail**: drawn whenever on the ground with ≥2 points (not gated to "currently moving"), trimmed to the current leg via scheduled departure time, cleaned server-side (`cleanTrail()` — sorts merged SWIM+STDDS points, drops exact duplicates and single-point spikes). Taxi direction prefers TFDM's own phase (`TAXI_IN`/`ARRIVAL` vs `TAXI_OUT`) over the older poller-local fallback.

**`_legState(cs, dMs, aMs, landedEarlyFlag, pilotKey)` rule order** (day map popup + here-now pin, first match wins):
1. `landedEarlyFlag` true → `completed`
2. `_hasNewerLegStarted(pilotKey, cs, dMs)` true → `completed`
3. confirmed parked, gated on `depHasPassed` and not currently `liveSeen` → `completed`
4. `liveSeen` → `active`, unconditionally (authoritative even for a genuinely early departure)
5. airborne evidence exists, gated on `depHasPassed`, not yet past effective (schedule-or-TFMS-estimated) arrival → `active`
6. TFMS's real OOOI `airlineOnTime` has passed → `completed` (checked only after the two `active` rules above)
7. seen flying at all and past effective arrival → `completed`
8. never seen flying at all but 3 hours past effective arrival → `completed`
9. before scheduled departure → `scheduled`
10. departure passed, not seen flying, TFMS estimated departure ≥5min later than scheduled → `delayed`
11. departure passed, not seen flying, no delay estimate → `due`

Evidence (`etd`/`eta`/`airlineOnTime`/`airlineInTime`, confirmed-parked/airborne/live) is fetched in one batched call per render to `GET /api/flight-status?callsigns=...&origins=...`. TFMS's own estimated-times cache is separately disk-persisted (`.tfms_times_cache.json`, 6h TTL).

**Same standing principle as above applies here too**: only the display-layer classification uses live evidence; the stored schedule is never changed.

Full discovery narrative for all of the above: `CLAUDE_HISTORY.md § Durable flight-tracking evidence`.

---

## Same-day round trip sharing one callsign

A callsign does not uniquely identify one leg — Kyle's corporate flights derive a callsign from the tail (identical for every leg on that tail the same day); Delta genuinely files the same real flight number both directions on some real round trips; Republic reuses a flight number the same day for an entirely different, CrewSync-unknown return flight. Current safeguards in place as a result:

- Background poller tracks tail-only (non-flight-number) rows too, filtered to just the relevant `airlineCode`s.
- `unparkIfNewLeg(cs, origin)` prefers CrewSync's **own known scheduled `departure_airport`** over the live feed's own reported origin (which may not have arrived yet) when deciding whether a stale parked flag should clear. `/api/live-position` accepts an optional `?origin=` for this; `startCalListLivePolling()`/`renderDayMap()` always supply it.
- `_legState`'s parked/airborne rules are gated on `depHasPassed` (this leg's own scheduled departure has passed) — only `liveSeen` (rule 4) is intentionally ungated, to support a genuinely early departure.
- `_landedEarly` is keyed by `` `${callsign}|${scheduledArrMs}` `` (`_landedEarlyKey()`/`_isLandedEarly()`), not bare callsign, so two legs sharing a callsign can't contaminate each other's early-landing flag.
- Each `startLiveTracking()` poller carries a per-call instance id (see "ADS-B live tracking" above) so a superseded poller can't arm a stray timer or mark the wrong leg parked.
- `_hasNewerLegStarted(pilotKey, callsign, ownDepMs)` (shared helper) — if this pilot has another segment today sharing this callsign with a later scheduled departure that's already passed, the earlier leg is definitively `completed` and its own poller self-terminates. Pre-filters on the raw ISO date string within a ±48h window before doing any real per-segment work, for performance.
- `/api/flight-status`'s `live` list excludes anything in `parked` (mirroring `airborne`, which already did), so `parked:true` and `live:true` can't both be true for the same stale cache entry.
- TFMS's real OOOI `airlineOnTime`/`airlineInTime` is used as a last-resort "definitely landed" signal when the position-polling pipeline has nothing (checked after the live-tracking `active` rules so an actively-tracked taxi-in still shows active).
- Day-map popup shows "▶ TAXIING IN" instead of "▶ IN THE AIR" when `onGround` is true for a flight in the `live` list (scoped to the day-map popup only, not grid/list/day-detail).
- `matchesExpectedOrigin(data, expectedOrigin)` (server.js) — compares a live-feed-reported origin against the caller's own already-known scheduled `departure_airport`, applied at every mutation/read site: `fetchLivePosition()`'s STDDS/SWIM return paths, `/api/live-position`'s cache short-circuit and parked-recovery branch, `runActiveFlightPoller()`'s own parked-recovery branch, `/api/flight-status`'s `live`/`airborne`/`parked` arrays, and `restoreFromFlightLog()`. `isExpectedDay()`/`isExpectedOrigin()` reject a mismatched message's *entire* contents at ingestion in `tfdm.js`/`tfms.js`. `tfms.js` parses the real origin straight out of its own filed-route string (`routeOrigin()`) and caches it on `_latest[cs].origin`.
- A temporary debug endpoint, `GET /api/debug/origin-state/:callsign`, is still live from this investigation.

Full bug-by-bug discovery narrative (8 distinct findings across 2026-10-09 through 2026-10-20): `CLAUDE_HISTORY.md § Same-day round trip sharing one callsign`.

---

## NetJets manual tracking (`parser_type: 'manual_netjets'`)

NetJets publishes no exportable schedule feed at all — a manual-entry pilot type built around how NetJets pilots actually work: home-based, tail-locked for a whole tour, on a rotation. One real account: `mack` / Mack Kraus (base/home both DFW).

**Tail → ATC callsign rule**: `EJA` + the full numeric run of the tail, no truncation (`ejaFlightNumber(tail)` server-side, `deriveCallsign()`'s `EJA` branch client-side — both just strip non-digits).

**Exposed in the admin dropdown only** — never in `join.html`'s public self-signup. `AIRLINE_OPTIONS` has a real `EJA` entry (`parser: 'manual_netjets'`, `needsIcs: false`) in both the admin edit-user modal and the self-service My Info modal.

**Home-based**: `pilots.base === pilots.home_airport` for this pilot type, so `buildGroundPeriods`'s commuter branch never triggers.

**Duty rotation + per-tour tail.** `pilot_duty_rotation(pilot_id, anchor_date, days_on, days_off, effective_from)` and `pilot_tour_tail(pilot_id, tour_start_date, tail, start_airport)` (`UNIQUE(pilot_id, tour_start_date)`, upserted). `GET /api/pilots/:key` returns `rotation_history`/`tour_tails`. `PUT /api/pilots/:key/rotation` / `.../tour-tail` (admin-or-self). Resolution: `_resolveRotationAt()` → most recent rotation row still effective; `_tourStartDateFor()` → modular-arithmetic day-1 of the on-duty tour containing a date, or `null` if off-duty/unconfigured; `_tourTailFor()` looks up the saved tail for that tour start. The pilot just picks any known Day-1 date + Days On/Off — no external line/family mapping needed for the base rotation case.

**Off Days integration.** `_isOffDutyGeneric(pilotKey, dateStr, pilotFlyingDates)` — off only when there's neither a real logged segment nor the rotation saying on-duty. Wired into `renderCommonOffSection()`, `renderOffDayCalendar()`, `showOffDayDetail()`. Falls back to pure segment-based when no rotation is saved yet.

**Self-service UI.** `#my-info-netjets-section` (Days On/Off + Anchor Date + Save; numeric tail input + Save, keyed to today's resolved tour start). `_refreshMyInfoNetjetsStatus()` shows current status. Add Flight modal pre-fills Tail#/Flight# from the saved tour tail.

**Auto-creating legs.** SWIM-first: the derived `EJA` callsign is fed into `setRelevantCallsigns()` proactively every poll cycle via `_getOnDutyNetjetsPilots()`, merged in before the main scheduled-flight relevance computation (NetJets legs have no `departure_time` to drive that query otherwise). `_pollNetjetsLegCreation()` materializes **every known leg** from a per-leg store (`tfdm.getAllLegs()`/`tfms.getAllLegTimes()`, both disk-persisted and scoped to EJA callsigns only) rather than tracking just "the current" leg — real NetJets callsigns routinely carry 2+ concurrently-filed legs, sometimes spanning today and tomorrow. Matching across polls is fuzzy (an estimated time can legitimately drift poll to poll), not an exact key. `isParkedForOrigin()` (NetJets-specific) avoids the generic `isParked()`'s single-slot-per-callsign confusion when two legs on the same tail are both tracked.

**Restart-safe by construction.** `auto_leg_key` (format `<callsign>|<tourStartDate>|<legNumber>`) on the `segments` row is the actual source of truth — `_pollNetjetsLegCreation()` queries fresh every call, no persisted in-memory cache.

**Resolving timing data for a leg**, in priority order: TFDM's parsed per-flight origin/dest (most authoritative) → TFMS's filed route string (`routeDest()`, local mirror of `routeOrigin()`) → reverse-geocoding the last known ADS-B/STDDS position (`_findNearestAirportCode()`) once a leg looks landed with no SWIM destination ever reported. `block_minutes` is a plain UTC diff (TFMS's `processFlightTimes()` already normalizes every time field to real UTC-with-`Z` strings — `pilotUsesUtc()` auto-detects this, same convention as Kyle's segments). An inconsistent arrival-before-departure value is corrected to `arrival_time = departure_time` (a neutral placeholder), never left `NULL` — several places in app.html assume a `type='flight'` segment always has both times.

**ETA placeholder for a leg with no real timing data yet**, priority order: NetJets' own real average duration for that exact city pair from genuinely completed legs → any other tracked pilot's real scheduled `block_minutes` for the same city pair (`idx_segments_route` keeps this off a full table scan) → great-circle distance at an assumed 420kt cruise. `block_minutes` is never written from the estimate itself, only from real evidence.

**`start_airport` is informational, not a hard gate** — a mismatch between the saved starting airport and the aircraft's real position no longer silently blocks leg creation; it's just a signal, since the old hard-reject's failure mode was indistinguishable from "nothing's happening."

**A human's manual correction is never silently overwritten.** `segments.auto_leg_edited` is set unconditionally by the existing segment-edit endpoint — once a human touches an auto-created row, `_pollNetjetsLegCreation()` goes permanently hands-off on that row's fields, only reading `arrival_airport` back out as the next leg's informational context.

**Day-1-only reminder, two layers.** `checkNetjetsTourReminders()` (server.js, every 6h) sends a push/in-app notification the evening before each tour's Day 1 if no tail is saved, deduped via `pilot_tour_reminder_sent`. `_maybeShowNetjetsTailReminder()` (client, called from `loadPilot()`) shows a modal once per day, localStorage-deduped, scoped to the tour's actual first day only.

**Admin gets read-only visibility, not an edit UI.** `#edit-user-netjets-section` (`_loadEditUserNetjetsStatus()`) — no admin-side setter; this is self-service by design for a one-pilot beta.

**Line-switch seam transition.** `scripts/build-seam-tables.js` → `public/seam-tables.json` (14 `7Line*` keys, `8Line2/4/6/9/11/13` only for 8&6 — a property of the seam table's own data coverage, not a restriction on which lines are generally valid elsewhere). When `saveMyRotation()` detects a real family/line switch, `PUT /:pilotKey/rotation` computes a 28-day override window (`_computeSeamWindow()`) stored in `pilot_duty_rotation_seam(window_start_date, from_key, to_key, table_letter)`, returned as `rotation_seams`. `_seamOverrideFor()` looks up the per-day value inside a stored window; falls through to the normal rotation formula otherwise. Family/Line pickers default to a blank placeholder so a save can't silently lock in the wrong line by omission.

**CC schedule override (CC52/60/72/76).** For pilots who bid per-trimester totals with no repeating cadence — their schedule can only come from a real NetJets Yahoo Mail monthly export. `parseCcScheduleText()` parses one line per day (`<DayAbbr>, <MonAbbr> <DD>, <YYYY> <STATUS>`; `X`=duty, `OFF`=day off, `P<n>`=PTO), warning (not erroring) on anything unrecognized. Stored in `pilot_cc_schedule_day` (`UNIQUE(pilot_id, date)`), returned as `cc_schedule_days`. **Intake is the standard Upload button only** — `POST /:pilotKey/upload` special-cases `parser_type==='manual_netjets'` before the normal dispatch, accepting a `.txt` or `.pdf`. Response shape: `{success, ccSchedule:true, daysParsed, warnings}`.

**PDF support uses real OCR** (`_ocrPdfBuffer()`): `pdftoppm -png -r 200` (poppler) rasterizes each page, then the **native `tesseract` CLI** (not the `tesseract.js` npm package — see history for why) OCRs each page image. Both are system packages (`apt-get install poppler-utils tesseract-ocr`) — check `which pdftoppm tesseract` first if PDF upload breaks on a fresh droplet. Both calls carry a 60s timeout/SIGKILL backstop. Real-world latency on the live droplet (sharing one vCPU with SWIM/STDDS/ADS-B pollers) is ~53s for a typical schedule PDF — `handleUpload()`/`handleMobileUpload()` show an upfront "this can take up to a minute…" toast for `.pdf` uploads specifically.

**Surfaced as a third option on the Duty Rotation Family dropdown** (`7 & 7` / `8 & 6` / `CC (52/60/72/76)`), not a separate section — picking `CC` hides the Line picker/Save button and shows a plain note pointing at Upload instead. `openEditMyInfoModal()` defaults to `CC` whenever `cc_schedule_days` has any rows, even if a stale rotation row exists underneath.

**Resolution precedence, `_isNetJetsOnDuty()`**: (1) `_ccScheduleOverrideFor()` — explicit CC day record, if one exists; (2) `_seamOverrideFor()` — seam transition window; (3) fallback to the normal rotation formula. A pilot's CC schedule overrides any overlapping tours from a previous 7&7/8&6 schedule, by design.

**Known, unaddressed blind spot**: getting to/from the jet on day 1 / the last day of a tour is typically a commercial deadhead, invisible to tail-based tracking. The existing manual "Commute" flight type (`trip='COMMUTE'`) is the intended fallback (2 entries per tour) but isn't yet specifically surfaced/encouraged in the UI for this pilot type.

**Tail display**: a pilot enters just the tail digits ("742"); `displayTail()` shows the full `N742QS` wherever a reader sees it, without changing what's stored.

**`/crew-roster/netjets-lookup`** — a human-readable exploration page over `tfdm.getAllLegs()`/`tfms.getAllLegTimes()`.

Full build narrative — the F70-timezone bug and its own regression, the same-callsign-concurrent-leg discovery (59% of tracked EJA callsigns showing 2+ concurrent legs fleet-wide), the leg-creation rewrite, the arrival-before-departure fix, the grid-poller "completed" fallback fix, the TFDM-scheduled-state-window research, and the GUFI/etdType/diversionIndicator extraction pass: `CLAUDE_HISTORY.md § NetJets manual tracking`.

---

## Upload flow

`handleUpload(input)` (~line 6523): reads the selected file + upload-for pilot (`#upload-pilot-select`), calls `uploadPilotSchedule(pilotKey, file)` → `POST /api/pilots/:key/upload` (multipart). On success: toast with segment count, reload if currently viewed, `computeOverlap()` to refresh crossings, then `updateCrossingAlert()`/`broadcastCrossingNotifications()`.

**Mobile upload**: `#mobile-upload-sheet` with its own pilot-select/file-input, handled by `handleMobileUpload()` (mirrors `handleUpload`).

**Upload reminder**: `showUploadReminder()` (~line 7454) fires after `loadPilot()` if the pilot has no flights for the current month and hasn't seen the reminder for that month/pilot.

---

## Add flight modal (`submitAddFlight()`, ~line 7024)

4 flight types: **Work** (`trip` = pairing #), **DH** (`is_dh=true`), **Commute** (`trip='COMMUTE'`, `is_manual=1`), **Personal** (`trip='PERSONAL'`, `is_manual=1`). Fields: pilot selector (admin only), date, DEP/ARR airports (auto-uppercased), dep/arr times, block time (auto-calculated via `autoComputeBlockTime()` unless manually edited), flight #, tail #. POSTs to `/api/pilots/:key/add-segment`; edit mode PUTs to `/segments/:id`. Separate `#edit-ground-modal` for ground legs.

---

## Notifications system

### Push notifications
Service worker `/sw.js` registered by `initServiceWorker()`. `initPushNotifications()` → `subscribeToPush()` if already granted, else shows `#notif-prompt-sidebar`. Server sends push on crossings via `broadcastCrossingNotifications()`. SW message `{type:'OPEN_OVERLAP'}` → `switchView('overlap')`. `PUSH_ENABLED` gates the feature; `myToken` ties a subscription to a pilot.

### In-app crossing alerts
`updateCrossingAlert(overlaps)` (~8132): filters to overlaps involving `myPilot` within `XALERT_BADGE_WINDOW` (48h), cross-referenced against `localStorage['cs_xacked']` for unread badge count. Within `XALERT_MODAL_WINDOW` (24h) and not yet shown this session → `#crossing-alert-modal` once per session. `ackMyCrossings()` on opening crossings clears the badge.

### Notification panel (`#notif-panel`)
Bell icon → `loadNotifications()` (`/api/notifications?token=…`). Clicking a notification → `switchView('overlap')` + `PATCH /api/notifications/read`. `navigator.setAppBadge()` where supported (iOS 16.4+).

---

## Crew Intel view (`#view-intel`)

**State**: `_intelAll`, `_intelView` (`'airports'|'map'|'detail'`), `_intelDetailAirport`, `_intelFilter.category`, `_intelSearch`, `_intelMap`.

**Views**: airports list (`renderIntelAirports()`, alphabetical cards, color-accented border), intel map (`renderIntelMap()`, Leaflet thumbtack pins, red = mixed category), detail view (`renderIntelDetail()`, per-airport tip cards with category filter pills).

**Data flow**: `loadIntelCounts()` → `_intelAll`; `saveIntelTip()` POST/PUT `/api/intel`; `deleteIntelTip()`; `voteIntel(id, vote)`.

**Category colors**: hotel=`#60a5fa`, food=`#fbbf24`, activity=`#4ade80`, tip=`#c4b5fd`; mixed pin=`#ef4444`.

**Clutter filters (both default ON)**, read through `_intelVisible()` everywhere entries are rendered or counted: `_intelHideGeneric` (regex-matches national park/monument/historic-site/seashore/memorial naming), `_intelHideEmptyActivity` (any `activity` entry with a blank body — ~70% of all activity entries have no body). Each persists its own `localStorage` toggle, `'0'` = off.

**Voting** (`intel_votes`, `UNIQUE(intel_id, pilot_key)`, upserted; a cleared vote deletes the row). `GET /api/intel` attaches `score` (SUM) and, with a token, `my_vote`. Sort order is by `score` descending (ties → newest first), not grouped by category — category pills still filter. **Redaction**: entries at or below `INTEL_REDACT_THRESHOLD` (`-3`) collapse to a one-line "Downvoted by the crew (N) — tap to view anyway" placeholder in the detail view only (`_intelExpandedRedacted`, in-memory, not persisted) — doesn't affect `_intelVisible()`, airport totals, or map pin counts.

---

## Admin panel (`openAdminPanel()`, ~line 8255)

Full-page takeover (`#admin-panel`), header with back arrow/title/"+ Add User", Users/Dashboard tab switcher (`switchAdminTab()`).

**Users tab**: `loadAdminUsers()` → `/api/pilots` → `renderAdminUserList()` as a responsive card grid, search box (`#admin-user-search` → `filterAdminUsers()`).

**Dashboard tab**: app stats — total segments, pilots, segments per pilot, last sync times.

**Edit/Add User modal (`#edit-user-modal`)**: view-only toggle (role='viewer', hides pilot-specific fields); airline selector determines `parser_type` (GoJet→`ics_rosterbuster`, SkyWest→`vcs_skywest`, Republic→`csv`, Sun Country→`ics_scx`, Atlas Air→`ics_ecrew`, Delta→`ics_delta_micrew`, American→`ics_american`, Southwest→`ics_southwest`, SpiritJets(corporate)→`schedaero`, NetJets(admin-only)→`manual_netjets`, Other→`other`); friends toggle list (`#edit-user-friends-section`); `saveUser()` → POST/PUT `/api/pilots`; after save alerts the generated `?u=TOKEN` personal link.

**`role` field** is optional, cosmetic metadata (Profile sheet subtitle + a small label on Crossings cards) — nothing in parsing/sync/access-control/friends reads it.

Full airline/parser-display-bug narrative: `CLAUDE_HISTORY.md § Admin panel`.

---

## Pilot roster is fully DB-driven — no hardcoded pilot config anywhere

The `pilots` table (including `color`) is the **only** source of truth for every pilot's config, including the original 5. `server.js` has no hardcoded parser/airline-code maps (`getParserForPilot()` is just `pilotRow?.parser_type || 'csv'`). `app.html`'s `PILOT_KEYS`/`PILOT_COLORS`/`PILOT_NAMES`/`PILOT_ROLES`/`PILOT_HOME` all start **empty** for a real session and are populated entirely by `_syncPilotRoster()` from `/api/pilots-directory`, called inside `initIdentity()` before any pilot-dependent UI builds. Pill bar/sidebar order is alphabetical by name (`ORDER BY name`) with the signed-in pilot's own pill always pinned first via `_reorderPilotPills()` — no insertion-order or hardcoded ordering anywhere. The 5 static sidebar/pill `<button>` elements and the `PILOT_HOMES`/`PILOT_CARRIER` client-side fallback objects were removed outright — every pilot (including the original 5) is rendered/resolved dynamically now. `AIRLINE_OPTIONS` has a real SpiritJets/Schedaero entry for Kyle so his profile has a stable, selectable match (not "Other"). `PILOT_HOME_AIRPORTS` (Kyle's dual SUS/STL) remains a deliberate, scoped hardcoded exception (see "Key constants" above) — the schema has no second-home-airport column.

**Self-service profile editing** (base / home airport / airline): `#my-info-section` (real pilots only) → `#edit-my-info-modal` → `openEditMyInfoModal()`/`_onMyInfoAirlineChange()`/`saveMyInfo()`, PUTs `/api/pilots/:pilotKey` (admin-or-self; a self-edit's SQL `UPDATE` omits the `role` column entirely, so a pilot can't grant themselves a role change through this path), then re-syncs ICS if a new URL was given and refreshes the view.

**Every schedule-mutation endpoint requires auth** (see API list above) — admin, or the pilot acting on their own data, enforced via `_resolvePilotToken`.

**A failed identity lookup never silently becomes admin.** `initIdentity()` retries a failed token lookup up to 3x (network error/5xx only, not a 4xx), and on total failure stops startup and shows `_showIdentityError()` instead of proceeding with `myPilot`/`myToken` left `null` (the same state the app treats as admin everywhere).

**Known, deliberately out-of-scope remainders**: Hunter's `parser_type` is still wrong (`ics_scx`, should be `ics_ecrew` — his `airline_code` is already correct, so this never affected his real parsed schedule, only display); `PILOT_HOME_AIRPORTS` remains hardcoded by design; `join.html`'s own airline list is separate/shorter and untouched (new-pilot signup, not existing-pilot editing).

Full three-places-duplicated-config story and the two security-hole discoveries: `CLAUDE_HISTORY.md § Pilot roster is fully DB-driven`.

---

## PWA / service worker

**Service worker `/sw.js`**: registered on every load; handles background push (parses payload, shows system notification); on click sends `{type:'OPEN_OVERLAP'}` → Crossings tab.

**PWA install prompt (`#pwa-prompt`)**: shown on mobile when not in `standalone` mode. iOS: manual "Add to Home Screen" instructions (no native API). Android: `beforeinstallprompt` → `pwaInstall()`. Dismissed state in `localStorage['pwa_dismissed']`, not shown again for 7 days.

**Auto-refresh on resume** (in `<head>`, runs before any scripts):
```js
if (document.visibilityState === 'hidden') hiddenAt = Date.now();
else if (hiddenAt && Date.now() - hiddenAt > 5 * 60 * 1000) window.location.reload();
```
Refreshes after 5 minutes backgrounded.

**Manifest**: served with `?u=TOKEN` from the `<link rel="manifest">` tag injected in `<head>`.

---

## UI components and modals reference

| Element | Opens via | Purpose |
|---|---|---|
| `#day-detail-sheet` | `showDayDetail(dateKey)` | Day events bottom sheet |
| `#add-flight-modal` | `openAddFlight()` | Add/edit manual flight |
| `#edit-ground-modal` | Edit button on ground leg card | Edit ground transfer |
| `#schedaero-modal` | "Sync Schedaero" button | Kyle's Schedaero sync |
| `#drew-ics-modal` | "Sync Schedule (Drew)" button | Drew's RosterBuster ICS URL |
| `#ics-sync-modal` | "Sync Schedule" button | Generic ICS URL |
| `#mobile-upload-sheet` | Mobile nav Upload button | Mobile upload/sync |
| `#profile-sheet` | Avatar button / sidebar identity row | Identity, link, crew visibility, notifications |
| `#admin-panel` | Profile → "Manage Users" | User list + dashboard |
| `#edit-user-modal` | "+" or Edit in admin panel | Add/edit pilot or viewer |
| `#overlap-detail-modal` | "Also Nearby" row tap | Expanded crossing detail |
| `#crossing-alert-modal` | Auto, once per session if crossing within 24h | Crossing alert |
| `#intel-modal` | "+ Add" in Crew Intel | Add/edit intel tip |
| `#notif-panel` | Bell icon | Notification history |
| `#confirm-modal` | `showConfirm(title, body)` | Destructive action confirmation |
| `#overlap-help-modal` | "?" in Crossings | Crossings type explanation |
| `#intel-help-modal` | "?" in Crew Intel | Crew Intel explanation |
| `#grid-help-modal` | "?" in Calendar | Color coding help |
| `#list-help-modal` | "?" in List | List view explanation |
| `#map-help-modal` | "?" in Map | Map modes explanation |

**Bottom sheet swipe-to-dismiss**: `setupSheetSwipe(panelEl, dismissFn)` — dragging down >80px dismisses with a 220ms slide-out.

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

**Desktop sidebar**: collapsible via hamburger `toggleSidebar()`. `#sidebar.sidebar-hidden` sets width:0, overflow:hidden, opacity:0 with CSS transition.

---

## Color constants (pilot colors)

Used in Crew Intel, map legend, sidebar avatar circles, mobile pill active state, flight card accents:
```js
PILOT_COLORS = {
  kyle: '#3b82f6',   // blue-500
  adam: '#2dd4bf',   // teal-400
  sam:  '#f97316',   // orange-500
  logan:'#818cf8',   // indigo-400
  drew: '#fb7185',   // rose-400
}
```
These live in the `pilots.color` DB column now (see "Pilot roster is fully DB-driven") — the object above is just the current values. Additional non-core pilots have colors defined inline; further pilots get `_dynamicColorPool` rotating palette. Hardcoded HTML uses these as rgba, e.g. `#3b82f6` → `rgba(59,130,246,0.15)` for avatar circle background.

---

## UI theme (server branch — aviation boarding pass style)

### Flight cards (day detail sheet + list view)
- `.bp-card` — boarding pass container, `overflow:hidden`, `border-radius:16px`
- `.bp-apt-code` — 38px monospace airport code (30px mobile)
- `.bp-top-bar` — 3px accent gradient bar at card top
- `.bp-tear-line` / `.bp-stub` — dashed separator + stub section with flight meta + barcode decoration
- `accentColor` hierarchy (day detail & list): `isActiveLeg → #22c55e` > `isPersonal → #a78bfa` > `isCommute → #f59e0b` > `PILOT_COLORS[currentPilot]`

### Sidebar pilot buttons (`#sidebar-pilot-list`)
- `.pilot-avatar-btn` — full-width button with colored initials circle (`w-7 h-7 rounded-full`) + name
- Circle uses `PILOT_COLORS[pilot]` rgba (hardcoded in HTML, must match JS constant)
- Active state set by `loadPilot()`: `btn.style.background = pc + '1a'`, `btn.style.borderColor = pc + '55'`

### Mobile top header (`header.md:hidden`)
- Contains identity avatar (`#identity-avatar`), month info (`#mobile-header-month-info`), prev/next month (`#mobile-prev-btn`/`#mobile-next-btn`), bell (`#notif-bell-btn-mobile`), help, add-flight (`#btn-add-flight-mobile`).
- Calendar-specific controls hidden via `style.display='none'` on `overlap`/`intel` views (`switchView()`'s `calView` check) — only avatar/bell/help remain.
- Height: `calc(env(safe-area-inset-top) + 56px)`, `padding-top: calc(env(safe-area-inset-top) + 6px)`. Fully opaque `bg-black`, no `backdrop-blur-md`. Status bar style is solid `black` (`apple-mobile-web-app-status-bar-style`), not translucent. These values are empirically settled, not spec-derived — full iteration history (and the on-screen-readout diagnostic technique worth reusing for future iOS rendering reports) is in `CLAUDE_HISTORY.md § Mobile header padding`.
- No light mode exists anywhere in the app (was built and fully removed).
- `<body style="height: 100dvh" data-fullheight>` with a `100lvh` override under `@supports`, so the PWA reaches the true bottom edge.
- Bottom nav uses a flat `12px` bottom padding (not `env(safe-area-inset-bottom)`), with matching content-reservation padding below it (grid/list `70px`, map mode bar `68px`).
- `#current-month-display-mobile` must stay `whitespace-nowrap overflow-hidden text-ellipsis` with `min-w-0` on its flex parent — a wrapped long month name pushes its block above the safe-area boundary (looks like a rendering glitch, isn't).

### Mobile nav bar (`.mobile-nav`)
- Each button `56px` tall, `.mbtn-icon-wrap` (38×28px, `border-radius:10px`) wraps the SVG.
- Active: `.mbtn-active .mbtn-icon-wrap` → `background: rgba(59,130,246,0.13)`, icon/label `#3b82f6`.
- Top indicator line (`.mbtn::before`): 2px `#3b82f6`, animates width 0→28px on active.

### Mobile pilot pills (`#mobile-pilot-bar`)
- Active pill uses `PILOT_COLORS[pilot]` (border + color + background) via `loadPilot()` JS.
- Inactive: `border-zinc-700 text-zinc-400`.

---

## Schedaero sync (Kyle)

**Full sync** (`openSchedaeroSync()` → `syncSchedaero()` → `POST /api/pilots/kyle/sync-schedaero`): requires GetMonth URL, API token (x-avinode-apitoken header), full session cookie. Syncs a configurable month range (back 0–6, ahead 1–6 months). Credentials saved server-side in `settings` after success.

**Quick sync** (`quickSyncSchedaero()` → `POST /api/pilots/kyle/quick-sync-schedaero`): uses saved credentials. Expired session (302/auth error) → opens `#schedaero-modal` in cookie-only mode. Auto-sync runs quick sync at 06:00/14:00/22:00 UTC daily (chained `setTimeout`, not cron); a keepalive ping every 20 minutes keeps the session alive between syncs.

**Kyle's corporate flight number**: real value is `SJJ` + the **first three digits** of the tail (`sjjFlightNumber(tail)`, server.js) — not every digit. Computed by the parser, actually written by `importSchedaeroEvents()`'s INSERT (both manual/quick sync and the 06/14/22 UTC auto-sync share this one import function), and matched by both tail-based callsign fallbacks (`deriveCallsign()` client-side, `deriveServerCallsign()` server-side). Full three-compounding-bugs discovery story: `CLAUDE_HISTORY.md § Schedaero sync`.

**Background poller tracks Kyle's corporate flights** via `deriveServerCallsign(row, airlineCode)` — the poller's query matches tail-only rows too, filtered down to `airlineCode === 'SJJ'` in JS. This was the first instance of the same-day-callsign-reuse problem — see "Same-day round trip sharing one callsign" above.

---

## FRAT Autofill userscript (`public/frat-autofill.user.js`)

Tampermonkey userscript (Kyle only) that autofills PRISM SMS (`prismsms.argus.aero`) flight risk assessment reports from his CrewSync schedule: Date, Origin, Dest, Trip ID, PIC, SIC, Aircraft, TSA, and ~24 risk questions computed from schedule + `aviationweather.gov` + FAA NOTAM data. Served from `/frat-autofill.user.js` with `@updateURL`/`@downloadURL` pointing at prod for Tampermonkey auto-update.

**`@match` covers the whole `prismsms.argus.aero` origin**, not just the report URL — needed because PRISM is an Angular SPA using `history.pushState` navigation (full story: `CLAUDE_HISTORY.md § FRAT Autofill userscript`). The script patches `history.pushState`/`replaceState` + listens for `popstate`, idling via `isFratReportRoute()`/`isFratLandingRoute()` route checks.

**Full automated pipeline** (landing page → filled, saved report):
1. On `/tools/frat-landing`, shows the leg-select panel (`mode:'landing'`).
2. Picking a leg sets `_pendingFlight`; `triggerCreateReport()` clicks "Create Risk Assessment" + the template option in the dropdown.
3. The new report routes via pushState; the SPA-navigation watcher re-runs `main('report')`, finds `_pendingFlight`, fills immediately.
4. `saveReport()` clicks "Save as Pending" → "Yes", routing back to landing.
5. Any failed automated click preserves the pending flight and prompts a manual click — finishing manually still triggers auto-fill once the report opens.

`triggerCreateReport()` prefers the known static `#btn-frat-add` id over generic text search (see history for why). The leg-select panel's "dbg" button calls `debugDump()` — check console output there before assuming a selector is broken.

**Sends Kyle's real CrewSync login token** (hardcoded `const TOKEN`) since `GET /api/pilots/:key` requires `?token=`. **Known, accepted exposure**: the file is both committed to the public GitHub remote and served unauthenticated, so the token is effectively public — anyone who finds it can act as Kyle through the API, though not as admin or any other pilot. Regenerating the token via the admin panel both revokes this and requires updating this constant to match. Don't paste the literal token value anywhere else committed to the repo — reference it by name/location instead.

A non-200 schedule-fetch response logs the actual HTTP status + a response snippet (`@version 3.11`+) rather than failing silently.

---

## Demo mode (`/demo` route)

`demo-data.js` generates fake pilots (`alex`, `morgan`, `casey`, `jordan`). `GET /api/demo/pilots/:key` calls `buildDemoSegments()` fresh on every request (never cached at module load).

**Three-month window** (previous/current/next month relative to the server's own UTC clock, concatenated) — avoids a server/visitor month-boundary mismatch near midnight UTC. `anchorForMonthOffset(n)` returns the 15th of month `n`; `buildForAnchor(ANCHOR, idStart)` builds one month's segments for all four pilots (`idStart` keeps ids unique across the three calls: 1000/2000/3000).

**Identity display**: no login token, so `myPilot`/`myViewer` are both falsy — same state as admin. `_applyIdentityUI()` checks `isDemo` before falling back to the admin label, showing "Demo" instead. Check `isDemo` the same way for any new identity-driven UI text.

---

## Offline / connectivity

`#offline-banner` (red bar, top) appears on `window.addEventListener('offline')`, disappears on `'online'`. The service worker does not cache API responses — push-only, no offline data mode; all schedule data requires network.

---

## `flightLocalDate` / `flightUTCTime` — when to use each

`flightLocalDate(isoStr, airportCode)` → `'YYYY-MM-DD'` at the airport's local timezone. Use when checking which calendar day an event falls on.

`flightUTCTime(isoStr, airportCode)` → `Date` in true UTC. Use when comparing times across pilots or checking if a flight is currently active (`depMs <= now <= arrMs`).

Never use `new Date(localString) < now` directly for crossings or "currently airborne" checks — local browser time may differ from airport timezone by hours.
