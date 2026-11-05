# CrewSync: Live tracking

Current behavior only. Past bugs and why things were built this way: `CLAUDE_HISTORY.md`.

## ADS-B live tracking

Two parallel systems:

### `startLiveTracking()` (map view only, line 5642)

Polls `/api/live-position?callsign=XX&origin=DEP` — **adaptive cadence**: `_pollDelayMs` is 3000ms ("fast") when `d.onGround` or `d.altFt < 3000` (taxiing, final approach, or initial climb), else 8000ms ("cruise"). Self-scheduling loop (`setTimeout` → `await update()` → `scheduleNextPoll()`), not a fixed `setInterval`, so a phase change takes effect on the next poll. `finishTracking()` sets a `_pollerStopped` flag checked at the top of `scheduleNextPoll()` to actually stop a self-rescheduling loop.

- Called from `renderMap()`/`renderDayMap()` for any active-window flight.
- Draws a real-time GPS trail (solid polyline) + remaining-arc (dashed geodesic to destination).
- Plane icon hidden until ADS-B/SWIM confirms airborne (`hasBeenAirborne` — strictly poller-local, set only by a real `found:true` fix from *this* poller; a separate `serverConfirmedAirborne` absorbs the server's historical hint for miss-handling heuristics only, never near the first-confirmation cleanup path).
- `deoverlapLiveLabels()` runs every 300ms to prevent label collisions; also handles waypoint-tag collisions when Route Detail is on, and puts the plane's own label on the side covering the least of its route near the plane (the line ahead counts double, the flown trail single). Heading only sets the preference order between sides that are about equally clear, and with no route yet it decides alone.
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

## FAA SWIM integration — real filed-route display on the live map

Three backend modules consume FAA SWIM data via Solace PubSub+ (`solclientjs`), separate from ADS-B polling.

| File | Feed | Gives you |
|---|---|---|
| `swim.js` | SFDPS (en-route) | Live position/altitude/speed/heading **and** filed route string (current + original/as-filed), SID/STAR, parsed waypoints |
| `stdds.js` | STDDS (surface/terminal) | Airport-vicinity position (TAIS + ASDE-X), preferred over SFDPS near the ground; cross-references SFDPS by GUFI |
| `tfms.js` | TFMS (flow/route) | A dense, already-computed lat/lon trajectory when available; also real OOOI times (`etd`/`eta`/`airlineOnTime`/`airlineInTime`), airport-configuration (APTC) runway flow, and real per-flight route origin (`routeOrigin()`) |
| `tfdm.js` | TFDM (per-flight) | Runway assignment, flight phase (`tfdmState`: `FILED`→...→`ARRIVAL`→...→`LUAW`), departure delay, diversion indicator |

**Paced message processing** (`feed-queue.js`): each feed's Solace `MESSAGE` handler enqueues instead of parsing inline. Messages are processed 20 per event-loop turn (`setImmediate` between batches) and acknowledged after handling, so a reconnect backlog can't starve HTTP. Acking late does not slow the broker: its window is `maxWindowSize` minus what's undelivered inside the library, so memory is protected by pausing the consumer (`stop()` above 300 queued, `start()` at 50). Without that, the queue took the whole backlog into RAM. Startup logs `[boot]` stage timings.

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

### One flight number, two legs in the same window

`renderDayMap()` asks `/api/flight-status` with one origin per callsign: the latest leg that has started, or the next one. The server rejects evidence from another origin, so asking with the first leg's origin left a round trip's second leg at DEPARTURE DUE.

### A later leg can't borrow its callsign's evidence

`startLiveTracking()` re-checks `_isCurrent()` after each position fetch, because a poll already in flight when another leg takes over would otherwise draw a trail and position nothing clears.

On the day map, `_legState()` ignores callsign-level evidence for a leg more than `PREFLIGHT_ROUTE_MS` from departing, for any NetJets leg still ahead of its departure, and for a NetJets leg more than 3 hours past arrival, which has dropped out of the `perLeg` request window. Otherwise today's live flight shows as live on tomorrow's same flight number (Logan's SKW3502).

### Base map

**OpenFreeMap Dark** is the main map everywhere except Wrapped. It's drawn by MapLibre (`L.maplibreGL`), loaded with `defer` in the page head. `_watchBasemap()` falls back to CARTO+ for the session if the style fails to load within 15 seconds or five errors follow once loaded, and `_canDrawVectorMap()` falls back if the script or WebGL is missing. The `.cs-basemap` filter doesn't apply to it. The credit is one small dark line with no Leaflet prefix. It can't be removed, because OpenStreetMap's license requires it. There's no switch in the app. To go back to CARTO+ for everyone, set `_basemapChoice` to `'detail'`.

The backup is CARTO `dark_all` shown as **CARTO+**: the next zoom level's tiles at half size (`tileSize: 128, zoomOffset: 1`), so more cities, roads and rivers show zoomed out. CARTO restyled the plain version, with fewer labels and lighter blue-grey water, and no longer serves the old look anywhere. `addBasemap(map)` sets up every map (route maps, Crew Intel, Wrapped; Wrapped's no-labels map stays on CARTO). A `.cs-basemap` CSS filter (`brightness(0.8) saturate(0.3)`) evens out the land/water contrast and leaves the NEXRAD radar overlay untouched. `BASEMAPS.carto` (standard) is kept as a fallback. Leaflet stays 1.9.4; 2.0 is a beta and a breaking rewrite.

### Debugging NetJets

The one debug source is **`/crew-roster/netjets-lookup`** (Filed / Resolved / On the pilot's schedule per tail), plus the admin-gated `GET /api/debug/netjets/:pilotKey` for on-duty/tour resolution. The research log (`.netjets_research.log`), sample dumps, ETD-drift tracking, the EJA303 poller, the other `/api/debug/*` inspectors and the `seed-route`/`seed-flight` test injectors were all removed 2026-11-03. Research mode itself stays because it feeds the Lookup's fleet-wide data. The flat `.tfms_times_cache.json` only stores callsigns CrewSync tracks (research tails live in the per-leg store). Startup logs `[boot]` timings per stage.

### Route/trail persistence across restarts

`.swim_state_cache.json` (disk-backed) persists SWIM's trail, route, sid/star, origin/dest, sector — restored on startup via `loadStateCache()`, gated by a 24h freshness cutoff. A saved `routeParsed` may already carry a resolved `resolvedPath`, so a restart doesn't even need a fresh resolve. `scheduleSave()` (5s-debounced) fires on both position updates and route updates. **TFMS/TFDM state is NOT persisted** — only SWIM's route/trail; both re-populate naturally within a few polls.

### TFMS airport-configuration (APTC)

A second, unrelated `fiOutput`/`msgType="APTC"` message family on the TFMS queue, giving an airport's general current runway flow independent of any one flight:
```xml
<fcm:airport>SMF</fcm:airport> <fcm:arrRunwayConf>35L/35R</fcm:arrRunwayConf>
<fcm:depRunwayConf>35L/35R</fcm:depRunwayConf> <fcm:arrRate>64</fcm:arrRate>
<fcm:depRate>70</fcm:depRate> <fcm:weather>VMC</fcm:weather> <fcm:stratAar>64</fcm:stratAar>
```
`tfms.js` parses this into a flat `_airportConfig` map keyed by bare 3-letter code, unconditionally stored (never gated by relevant-callsigns — only a few hundred towered airports exist). Detected via a cheap substring check on `msgType="APTC"` before the relevant-callsigns gate (APTC messages carry no callsign at all). `getAirportConfig(aptCode)` returns `null` past a 30min staleness window. **Known limit**: airport-wide, not per-flight — a genuinely opposite-direction runway split resolves cleanly, but a finer split within the same flow direction could still land on the wrong body. 

### Trail backfill from ADS-B

`setRelevantCallsigns()` proactively calls `_watched.add()` for every relevant callsign so SWIM trail recording starts ~30min before a scheduled flight departs, independent of any client opening the live map. `/api/live-position` additionally backfills a SWIM/STDDS trail's missing head from ADS-B **once per flight instance that actually succeeds** (`_swimTrailBackfilled` Set, marked only after `fetchAdsbPosition()` resolves, so a transient rate-limit failure retries on the next poll instead of giving up forever). SWIM stays authoritative for any time range it already covers; ADS-B only fills the gap before it. Cleared on confirmed-parked so the next day's physical flight gets backfilled fresh.

### NOTAMs via SWIM — abandoned

Not implemented. SWIM only pushes live deltas with no snapshot/backlog of already-active NOTAMs, which FRAT's actual need (every NOTAM currently in effect) can't be built from alone. If revisited: start from the FAA NOTAM Search API (`api.faa.gov`) as the baseline, SWIM only ever as a live-update layer on top. Full story: `CLAUDE_HISTORY.md § FAA SWIM integration`.

## Airport data — three sources, layered

1. **FAA NASR** (`data/nasr/airports.json`): authoritative for US airports, with current IDs (KPBI → KDJT), exact coordinates, and an IANA timezone computed from coordinates at build time (`tz-lookup` is a devDependency, so the server needs no new package). ICAO IDs always win. A bare FAA ID only fills an empty slot or replaces the **same** airport (within 50 km), never a different one abroad sharing the letters (CQF = Calais, HND = Tokyo). Loaded by `server.js` after OurAirports, and merged into `public/airports.json` by `build-airports.js` as its last pass.
2. **OurAirports** (`data/airports_raw.csv`): worldwide coordinates and city names, no timezones.
3. **OpenFlights** (`airports.dat`): unmaintained and ~7,700 airline airports only, but still the server's timezone source outside the US.

NASR has no timezone column (checked against APT_BASE.csv), hence computing zones from coordinates.

## Resource usage (1 vCPU/1GB droplet)

**Memory**: about 380 MB steady, peaking over 500 MB during boot, and roughly 300 MB goes to everything else on the box. The feed queue was the source of the 2026-11-03 kills, see "Paced message processing". A 2 GB `/swapfile` (swappiness 10) is the safety net. `[mem]` lines in the pm2 log show rss, heap, feed queue depth and event-loop lag: every 5 minutes, or every 15 seconds above 500 MB. After any restart you didn't do, check `dmesg -T | grep "Killed process"`.

Indexes exist on `segments.pilot_id`, `segments.departure_time`, `pilots.token`, `notifications.pilot_key`, `friend_requests.requester_key`/`.recipient_key`, `segments.route` (NetJets historical-duration lookup) — all `CREATE INDEX IF NOT EXISTS`, purely additive. `runActiveFlightPoller()`'s 15s loop calls `fetchLivePosition()` (checks STDDS/SWIM first) rather than unconditionally hitting the real rate-limited ADS-B API.

**Known, deliberately unbounded**: `GET /api/pilots/:key` returns a pilot's entire segment history with no date bound — the frontend assumes the full list is in `pilotsCache` for historical month navigation. Bounding this needs a paired client-side range-fetch change; not done.

## TFDM delay insight + "don't mark completed while still flying"

**Explicit, standing product principle**: the uploaded schedule is, and stays, the source of truth for when a flight is supposed to depart/land — it is never overwritten with real/estimated times anywhere. Only the *display-layer classification* of whether a flight is still active may use live evidence.

Real TFDM fields: `departureDelay.{predictedDelay,currentDelay,actualDelay}` (ISO-8601 durations, `actualDelay` preferred when populated), `tfdmFlightState` (`FILED`, `SCHEDULED`, `AT_STAND`, `RAMP_TAXI_OUT`, `AMA_TAXI_OUT`, `DEPARTED`, `EN_ROUTE`, `ON_FINAL`, `ARRIVAL`, `AMA_TAXI_IN`, `RAMP_TAXI_IN`, `LUAW`). `getFlightInfo()` (tfdm.js) returns the whole per-callsign entry (phase + delay + runway). `withTfdmInfo()` (server.js) attaches it to every live-position response regardless of which source actually answered position.

`isFlightStillActive(depMs, arrMs, nowMs, csig)` (app.html) is the single shared check used by grid, list, day-detail sheet, `renderMap()`'s month view + route popup + here-now pin, `renderAllPilotsMap()`, and `renderDayMap()`'s popup + here-now pin. Extends the active window to **`LATE_ARRIVAL_GRACE_MS` (90 minutes)** past scheduled arrival *unless* a live poll has already confirmed parked (`_confirmedParked` Set — mirror of `_landedEarly`, which tracks landing *before* scheduled arrival). Delay is surfaced (`· Delayed Nm`) when `departureDelayMin >= 10`, only in the pre-cruise phase.

**Deliberately unchanged**: `startLiveTracking()`'s own "give up after sustained misses" threshold is a different, independent heuristic (only fires when the flight genuinely can't be found at all) and was left as-is.

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
- The `origin-state` debug endpoint from this investigation was removed 2026-11-03.

Full bug-by-bug discovery narrative (8 distinct findings across 2026-10-09 through 2026-10-20): `CLAUDE_HISTORY.md § Same-day round trip sharing one callsign`.
